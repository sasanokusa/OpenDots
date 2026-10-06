import type { DatabaseSync } from 'node:sqlite';
import type { Message } from '@ag-ui/client';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { handover, roles, turn, type TurnRole } from '../config/models.js';
import type { CommandCodeClient } from '../llm/commandcode.js';
import type { UsageMeter } from '../usage/meter.js';
import { evaluatePolicy } from '../usage/policy.js';
import {
  delegateTool,
  type Subtask,
  type TurnState,
} from '../agents/delegate.js';
import { handoverTool } from '../agents/handover.js';
import { AdvisorLedger, advisorTool } from '../agents/advisor.js';
import { runSubloop } from '../agents/subloop.js';
import { DecisionLog } from './decision-log.js';
import {
  ROUTE_QUESTIONS_VERSION,
  askJev,
  decideRoute,
  highImpactTasks,
  lastUserText,
  routeState,
  type RouteDecision,
} from './jev.js';
import type { TurnPlan, TurnPlanInput } from './types.js';

const LANGUAGE = 'Reply in the language the owner used.';

export const CHAT_SUFFIX = `Routing: you are the conversation role. Answer directly when you can. Give concrete work (web research, computer work, code generation) to workers with delegate_tasks, at most two tasks per call; only workers have computer tools. If the request needs three or more steps, you cannot see a clear path, or you are not confident, call handover_to_planner once with a concise ticket instead of improvising. If a delegated task comes back with handover_required, or delegation is refused, hand over. Relay worker and planner results in your own words and never claim work without tool evidence. ${LANGUAGE}`;

export const PLANNER_SUFFIX = `Routing: you are the planning role. Start with a short numbered plan. Delegate independent steps to workers with delegate_tasks (up to three run in parallel) and keep coordination, page edits and judgment yourself. Before the final answer, check each result against the goal and state briefly what you verified. If workers fail the same task twice, you have rewritten the plan three times, or a design decision or risky action needs review, call ask_advisor with a focused ticket (at most twice). ${LANGUAGE}`;

export const HIGH_IMPACT_SUFFIX =
  'This request may send something externally, delete data, spend money, or deploy. Do not perform any such action without explicit owner authorization in this conversation, and verify the plan and its results before finishing.';

export const ESCALATE_SUFFIX =
  'The owner asked for escalation with /escalate. First call ask_advisor with a ticket built from this conversation, then act on the advice.';

export const ESCALATE_UNAVAILABLE_SUFFIX =
  'The owner asked for escalation with /escalate, but the planning model is rate-limited right now so the advisor cannot be reached. Say so plainly, help as far as you can, and suggest sending /escalate again in about ten minutes.';

export const WORKER_SUFFIX = `Routing: you are handling this request directly as a worker. Do the task with the tools provided and report the result concisely. ${LANGUAGE}`;

/**
 * Server-initiated turns (backlog runs) pin a role through the user message's
 * metadata. An authenticated client could set it too, which is harmless: a
 * forced role gets no tools beyond what the Dot already allows.
 */
export function forcedRole(messages: Message[]): TurnRole | undefined {
  const last = [...messages]
    .reverse()
    .find((message) => message.role === 'user');
  const role = (last as { metadata?: { selfhostRole?: unknown } } | undefined)
    ?.metadata?.selfhostRole;
  return role === 'worker' || role === 'chat' || role === 'planner'
    ? role
    : undefined;
}

export interface TurnPlannerDeps {
  client: CommandCodeClient;
  meter: UsageMeter;
  db: DatabaseSync;
  routerEnabled: boolean;
  /** Model used for every turn when the router is off. */
  singleModel: string;
  log?: DecisionLog;
  now?: () => number;
}

export interface TurnPlanner {
  (input: TurnPlanInput): Promise<TurnPlan>;
  log: DecisionLog;
}

export function createTurnPlanner(deps: TurnPlannerDeps): TurnPlanner {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? new DecisionLog(deps.db, now);
  const ledger = new AdvisorLedger(deps.db, now);
  const policy = () => evaluatePolicy(deps.meter, now());

  const adapterFor = (
    role: TurnRole | 'planner',
    input: TurnPlanInput,
    model = roles[role].model,
  ) =>
    deps.client.chatAdapter(() => ({
      role,
      model,
      threadId: input.threadId,
      runId: input.runId,
    }));

  const plannerTools = (
    input: TurnPlanInput,
    state: TurnState,
  ): ToolDefinition[] => [
    ...input.baseTools,
    delegateTool({
      owner: 'planner',
      state,
      baseTools: input.baseTools,
      client: deps.client,
      check: input.check,
      signal: input.signal,
    }),
    advisorTool({
      state,
      client: deps.client,
      ledger,
      policy,
      check: input.check,
      signal: input.signal,
      now,
    }),
  ];

  const chatTools = (
    input: TurnPlanInput,
    state: TurnState,
  ): ToolDefinition[] => [
    ...input.baseTools.filter((tool) => !tool.name.startsWith('computer_')),
    delegateTool({
      owner: 'chat',
      state,
      baseTools: input.baseTools,
      client: deps.client,
      check: input.check,
      signal: input.signal,
      guard: async (tasks: Subtask[]) => {
        const next =
          state.handovers < handover.maxPerTask
            ? 'Call handover_to_planner with a ticket instead.'
            : 'Tell the owner this needs planning and suggest sending /plan.';
        if (tasks.length >= handover.forceOnSubtasks)
          return `Three or more tasks need a plan. ${next}`;
        const failed = tasks.find(
          (task) =>
            (state.failures.get(task.title) ?? 0) >= handover.workerFailures,
        );
        if (failed) return `"${failed.title}" already failed twice. ${next}`;
        const risky = await highImpactTasks(
          deps.client,
          tasks.map((task) => `${task.title}\n${task.instructions}`),
          {
            signal: input.signal,
            threadId: input.threadId,
            runId: input.runId,
          },
        );
        if (risky.some(Boolean))
          return `A task may send, delete, pay or deploy; the planner must review it. ${next}`;
        return undefined;
      },
    }),
    handoverTool({
      state,
      policy,
      markHandover: (runId) => log.markHandover(runId),
      check: input.check,
      now,
      runPlanner: (prompt) =>
        runSubloop({
          adapter: adapterFor('planner', input),
          systemPrompts: [
            input.systemPrompt,
            PLANNER_SUFFIX,
            ...(state.highImpact ? [HIGH_IMPACT_SUFFIX] : []),
          ],
          prompt,
          tools: plannerTools(input, state),
          maxIterations: roles.planner.maxIterations ?? 12,
          maxOutputTokens: roles.planner.maxOutputTokens,
          timeLimitMs: turn.timeLimitMs,
          signal: input.signal,
        }),
    }),
  ];

  const planner = (async (input: TurnPlanInput): Promise<TurnPlan> => {
    if (!deps.routerEnabled)
      return {
        role: 'chat',
        adapter: adapterFor('chat', input, deps.singleModel),
        tools: input.baseTools,
      };
    const text = lastUserText(input.messages);
    const flags = policy();
    const forced = forcedRole(input.messages);
    const decision: RouteDecision = forced
      ? { role: forced, reason: 'forced', highImpact: false }
      : decideRoute({
          text,
          jev: /^\s*\/(plan|escalate)\b/i.test(text)
            ? undefined
            : await askJev(deps.client, routeState(input.messages), {
                signal: input.signal,
                threadId: input.threadId,
                runId: input.runId,
              }),
          policy: flags,
          now: now(),
        });
    try {
      log.record({
        threadId: input.threadId,
        runId: input.runId,
        version: ROUTE_QUESTIONS_VERSION,
        text,
        decision,
      });
    } catch {
      // Logging must never block a turn.
    }
    const state: TurnState = {
      dotId: input.dotId,
      threadId: input.threadId,
      runId: input.runId,
      systemPrompt: input.systemPrompt,
      highImpact: decision.highImpact,
      forceAdvisor: decision.command === 'escalate',
      handovers: 0,
      advisorCalls: 0,
      failures: new Map(),
    };
    const role = decision.role;
    const common = {
      role,
      adapter: adapterFor(role, input),
      maxOutputTokens: roles[role].maxOutputTokens,
      maxIterations: roles[role].maxIterations,
    };
    if (role === 'planner')
      return {
        ...common,
        tools: plannerTools(input, state),
        systemPromptSuffix: [
          PLANNER_SUFFIX,
          ...(decision.highImpact ? [HIGH_IMPACT_SUFFIX] : []),
          ...(state.forceAdvisor ? [ESCALATE_SUFFIX] : []),
        ].join('\n'),
      };
    const unavailable =
      decision.command === 'escalate' ? [ESCALATE_UNAVAILABLE_SUFFIX] : [];
    if (role === 'chat')
      return {
        ...common,
        tools: chatTools(input, state),
        systemPromptSuffix: [CHAT_SUFFIX, ...unavailable].join('\n'),
      };
    return {
      ...common,
      tools: input.baseTools,
      systemPromptSuffix: [WORKER_SUFFIX, ...unavailable].join('\n'),
    };
  }) as TurnPlanner;
  planner.log = log;
  return planner;
}
