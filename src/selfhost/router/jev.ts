import type { Message } from '@ag-ui/client';
import { routing, type TurnRole } from '../config/models.js';
import type {
  CommandCodeClient,
  SystemOneQuestion,
} from '../llm/commandcode.js';
import { messageText } from '../threads/service.js';
import type { PolicyFlags } from '../usage/policy.js';
import { isCoolingDown } from '../usage/policy.js';

/** Bump the version whenever wording or order changes, so logs stay comparable. */
export const ROUTE_QUESTIONS_VERSION = 'v1';
export const ROUTE_QUESTIONS: Record<
  'route' | 'high_impact',
  SystemOneQuestion
> = {
  route: {
    type: 'choice',
    instructions: 'Who should handle this request first?',
    criteria: {
      chat: 'Conversation, answering a question, short writing, or a small one-step task.',
      planner:
        'Needs several steps or decisions; should be planned before acting.',
      worker:
        'One clear, mechanical task such as a search, file operation, or code generation.',
    },
  },
  high_impact: {
    type: 'noul',
    instructions:
      'Does this request involve sending something externally, deleting data, paying money, or deploying to production?',
  },
};

export const HIGH_IMPACT_QUESTION = ROUTE_QUESTIONS.high_impact;

/** Used when Jev cannot answer; deliberately simple and predictable. */
export const HIGH_IMPACT_PATTERN =
  /\b(send|e-?mail|post|publish|delete|remove|erase|pay|purchase|buy|order|charge|deploy|release|transfer)\b|送信|送って|投稿|公開|削除|消して|支払|購入|買って|注文|課金|決済|デプロイ|本番|振込|送金/i;

const PAGE_PREFIX = /^From \[[^\]]*\]\([^)]*\):\n\n/;

export type Command = 'plan' | 'escalate';

export interface JevVerdict {
  choice?: string;
  probabilities?: Record<string, number>;
  highImpact?: number;
  latencyMs: number;
  error?: string;
}

export interface RouteDecision {
  role: TurnRole;
  reason: string;
  highImpact: boolean;
  command?: Command;
  jev?: JevVerdict;
}

export function lastUserText(messages: Message[]): string {
  const last = [...messages]
    .reverse()
    .find((message) => message.role === 'user');
  return last ? messageText(last).replace(PAGE_PREFIX, '') : '';
}

export function commandOf(text: string): Command | undefined {
  const match = /^\s*\/(plan|escalate)\b/i.exec(text);
  return match ? (match[1].toLowerCase() as Command) : undefined;
}

/** Latest request plus a short excerpt of the exchange before it. */
export function routeState(messages: Message[]): string {
  const turns = messages.filter((message) =>
    ['user', 'assistant'].includes(message.role),
  );
  const lastUserIndex = turns.findLastIndex(
    (message) => message.role === 'user',
  );
  if (lastUserIndex < 0) return '';
  const request = messageText(turns[lastUserIndex])
    .replace(PAGE_PREFIX, '')
    .slice(0, 2000);
  const before = turns
    .slice(Math.max(0, lastUserIndex - 2), lastUserIndex)
    .map(
      (message) =>
        `${message.role}: ${messageText(message).replace(PAGE_PREFIX, '')}`,
    )
    .join('\n')
    .slice(-1000);
  return before ? `Earlier:\n${before}\n\nRequest:\n${request}` : request;
}

export function fallbackRole(text: string): TurnRole {
  const steps = text.split('\n').filter((line) =>
    // ASCII numbers need a following space so "1.5km" is not a step.
    /^\s*(?:[-*•]\s+|\d+[.)]\s+|[・①-⑳]|[０-９]+[．.)）、])/.test(line),
  ).length;
  return text.length > routing.fallbackRule.plannerMinChars ||
    steps >= routing.fallbackRule.plannerMinSteps
    ? 'planner'
    : 'chat';
}

export async function askJev(
  client: CommandCodeClient,
  state: string,
  options: { signal?: AbortSignal; threadId?: string; runId?: string },
): Promise<JevVerdict> {
  const started = Date.now();
  try {
    const result = await client.systemOne(ROUTE_QUESTIONS, state, {
      signal: options.signal,
      timeoutMs: routing.jevTimeoutMs,
      ctx: { threadId: options.threadId, runId: options.runId },
    });
    const route = result.answers.route;
    const impact = result.answers.high_impact;
    if (route?.type !== 'choice' || impact?.type !== 'noul')
      throw new Error('Jev answered with unexpected question types.');
    if (!['chat', 'planner', 'worker'].includes(route.choice))
      throw new Error(`Jev chose an unknown route: ${route.choice}`);
    return {
      choice: route.choice,
      probabilities: route.probabilities,
      highImpact: impact.noul,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      latencyMs: Date.now() - started,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`.slice(0, 300)
          : 'Error',
    };
  }
}

/** Per-task high-impact check for work the chat role wants to delegate. */
export async function highImpactTasks(
  client: CommandCodeClient | undefined,
  texts: string[],
  options: { signal?: AbortSignal; threadId?: string; runId?: string },
): Promise<boolean[]> {
  if (client && texts.length) {
    try {
      const questions = Object.fromEntries(
        texts.map((_, index) => [`task_${index}`, HIGH_IMPACT_QUESTION]),
      );
      const state = texts
        .map((text, index) => `task_${index}: ${text.slice(0, 1500)}`)
        .join('\n\n');
      const result = await client.systemOne(questions, state, {
        signal: options.signal,
        timeoutMs: routing.jevTimeoutMs,
        ctx: { threadId: options.threadId, runId: options.runId },
      });
      return texts.map((text, index) => {
        const answer = result.answers[`task_${index}`];
        return answer?.type === 'noul'
          ? answer.noul >= routing.highImpact
          : HIGH_IMPACT_PATTERN.test(text);
      });
    } catch {
      // Fall through to the keyword rule.
    }
  }
  return texts.map((text) => HIGH_IMPACT_PATTERN.test(text));
}

const FALLBACK: Record<TurnRole, TurnRole | undefined> = {
  planner: 'chat',
  chat: 'worker',
  worker: undefined,
};

export function decideRoute(input: {
  text: string;
  jev?: JevVerdict;
  policy: PolicyFlags;
  now: number;
}): RouteDecision {
  const { text, jev, policy, now } = input;
  const command = commandOf(text);
  let decision: RouteDecision;
  if (command) {
    decision = {
      role: 'planner',
      reason: 'command',
      highImpact: HIGH_IMPACT_PATTERN.test(text),
      command,
    };
  } else if (!jev || jev.error || !jev.choice) {
    decision = {
      role: fallbackRole(text),
      reason: 'fallback_rule',
      highImpact: HIGH_IMPACT_PATTERN.test(text),
    };
  } else {
    const confidence = jev.probabilities?.[jev.choice] ?? 0;
    const highImpact = (jev.highImpact ?? 0) >= routing.highImpact;
    decision = highImpact
      ? { role: 'planner', reason: 'high_impact', highImpact }
      : confidence < routing.minConfidence
        ? { role: 'planner', reason: 'low_confidence', highImpact }
        : { role: jev.choice as TurnRole, reason: 'jev', highImpact };
    if (
      decision.reason === 'jev' &&
      decision.role === 'planner' &&
      policy.plannerOverWeekly &&
      confidence < routing.plannerOverWeeklyMinConfidence
    )
      decision = {
        ...decision,
        role: 'chat',
        reason: 'policy:plannerOverWeekly',
      };
    if (decision.reason === 'low_confidence' && policy.plannerOverWeekly)
      decision = {
        ...decision,
        role: 'chat',
        reason: 'policy:plannerOverWeekly',
      };
  }
  decision.jev = jev;
  if (decision.role === 'planner' && !decision.highImpact && !command) {
    if (policy.plannerUrgentOnly)
      decision = {
        ...decision,
        role: 'chat',
        reason: 'policy:plannerUrgentOnly',
      };
    else if (policy.plannerReserved)
      decision = {
        ...decision,
        role: 'chat',
        reason: 'policy:plannerReserved',
      };
  }
  // Walk the fallback chain past roles that are rate-limited or out of budget.
  let skipped: string | undefined;
  for (
    let role: TurnRole | undefined = decision.role;
    role;
    role = FALLBACK[role]
  ) {
    const exhausted = role === 'chat' && policy.chatExhausted;
    if (!exhausted && !isCoolingDown(policy, role, now)) {
      if (skipped) decision = { ...decision, role, reason: skipped };
      break;
    }
    skipped ??= exhausted ? 'policy:chatExhausted' : 'policy:coolingDown';
  }
  return decision;
}
