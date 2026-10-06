import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { handover } from '../config/models.js';
import type { PolicyFlags } from '../usage/policy.js';
import { isCoolingDown } from '../usage/policy.js';
import { HIGH_IMPACT_PATTERN } from '../router/jev.js';
import type { TurnState } from './delegate.js';

export const handoverTicket = z.object({
  goal: z.string().trim().min(1).max(6000),
  findings: z.string().trim().max(8000).default(''),
  done: z.string().trim().max(8000).default(''),
  reason: z.string().trim().min(1).max(2000),
  recent_summary: z.string().trim().max(8000).default(''),
});
export type HandoverTicket = z.infer<typeof handoverTicket>;

export function handoverPrompt(ticket: HandoverTicket) {
  return [
    'The conversation agent handed this request to you. Re-plan from this ticket, carry the work through, check the result, and reply with a report the conversation agent can relay to the owner.',
    `# Goal\n${ticket.goal}`,
    `# What is known so far\n${ticket.findings || '(nothing yet)'}`,
    `# What was already done\n${ticket.done || '(nothing yet)'}`,
    `# Why it was handed over\n${ticket.reason}`,
    `# Recent conversation\n${ticket.recent_summary || '(none)'}`,
  ].join('\n\n');
}

export interface HandoverDeps {
  state: TurnState;
  policy: () => PolicyFlags;
  markHandover: (runId: string) => void;
  runPlanner: (prompt: string) => Promise<string>;
  check: () => void;
  now?: () => number;
}

export function handoverRefusal(
  deps: HandoverDeps,
  ticket: HandoverTicket,
): string | undefined {
  if (deps.state.handovers >= handover.maxPerTask)
    return 'This request was already handed over once. Finish it yourself or ask the owner to send /plan.';
  const size = Object.values(ticket).join('').length;
  if (size > handover.ticketMaxChars)
    return `The ticket is ${size} characters; keep it under ${handover.ticketMaxChars} by summarizing.`;
  const policy = deps.policy();
  if (isCoolingDown(policy, 'planner', (deps.now ?? Date.now)()))
    return 'The planning model is rate-limited right now. Continue yourself and tell the owner planning was unavailable.';
  const highImpact =
    deps.state.highImpact ||
    HIGH_IMPACT_PATTERN.test(`${ticket.goal}\n${ticket.reason}`);
  if (
    !highImpact &&
    (policy.plannerOverWeekly ||
      policy.plannerReserved ||
      policy.plannerUrgentOnly)
  )
    return 'The planning budget is nearly used, so continue yourself and tell the owner that you are proceeding without the planner.';
  return undefined;
}

export function handoverTool(deps: HandoverDeps): ToolDefinition {
  return defineTool({
    name: 'handover_to_planner',
    description:
      'Hand this request to the planning agent once, when it needs three or more steps, the path is unclear, you are not confident, or delegation was refused. Send a concise ticket, not the whole conversation. You remain the one who talks to the owner; relay the returned report.',
    parameters: handoverTicket,
    execute: async (input) => {
      deps.check();
      const ticket = handoverTicket.parse(input);
      const refusal = handoverRefusal(deps, ticket);
      if (refusal) return { refused: true, reason: refusal };
      deps.state.handovers++;
      deps.markHandover(deps.state.runId);
      return { report: await deps.runPlanner(handoverPrompt(ticket)) };
    },
  });
}
