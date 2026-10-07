import { randomUUID } from 'node:crypto';
import type { ConnectionService } from '../../server/connections.js';
import type { ApprovalDecision, ApprovalRequest } from './harness.js';

/** A connected-service (MCP) tool as the internal server offers it to sasacode. */
export interface ServiceTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  call(args: Record<string, unknown>): Promise<{
    isError: boolean;
    text: string;
  }>;
}

/** sasacode allows these without asking; the bridge below does the gating. */
export const SERVICE_TOOL_PATTERN = '*__*';

const UNAVAILABLE =
  'This action needs the owner’s approval, which is not available here. Tell the owner what you wanted to do.';
const DECLINED =
  'The owner declined this action. Do not perform it or try another way.';

export interface ServiceToolsInput {
  service: Pick<ConnectionService, 'tools' | 'resolve' | 'call'>;
  dotId: string;
  threadId: string;
  check: () => void;
  signal: AbortSignal;
  approve?: (
    request: ApprovalRequest,
    signal: AbortSignal,
  ) => Promise<ApprovalDecision>;
}

function objectSchema(
  schema: Record<string, unknown>,
): ServiceTool['inputSchema'] {
  return { ...schema, type: 'object' };
}

/**
 * The Dot's enabled connection tools. Read-only tools run directly; tools set
 * to "Ask first" wait for the owner through the approval broker (web card and
 * Discord buttons), so the Dot never needs upstream's in-chat action card.
 */
export function serviceTools(input: ServiceToolsInput): ServiceTool[] {
  return input.service.tools(input.dotId).map((exposed) => ({
    name: exposed.name,
    description:
      `[${exposed.connection.name}${exposed.tool.requiresApproval ? ', asks the owner first' : ''}] ${exposed.tool.title}: ${exposed.tool.description}`.slice(
        0,
        1024,
      ),
    inputSchema: objectSchema(exposed.tool.inputSchema),
    async call(args) {
      input.check();
      // Re-resolve so a tool the owner just disabled or gated is honored.
      const current = input.service.resolve(input.dotId, exposed.name);
      if (current.tool.requiresApproval) {
        if (!input.approve) return { isError: true, text: UNAVAILABLE };
        const answer = await input.approve(
          {
            id: randomUUID(),
            threadId: input.threadId,
            dotId: input.dotId,
            tool: `${current.connection.name}: ${current.tool.title}`,
            args,
            reason: `connection ask: ${current.connection.name}`,
          },
          input.signal,
        );
        if (answer.decision !== 'allow')
          return { isError: true, text: answer.feedback ?? DECLINED };
        input.check();
      }
      const result = await input.service.call(current, args, input.signal);
      input.check();
      return result;
    },
  }));
}
