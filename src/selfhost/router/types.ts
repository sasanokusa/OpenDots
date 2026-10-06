import type { Message } from '@ag-ui/client';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import type { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import type { RoleName } from '../config/models.js';

export type ChatAdapter = ReturnType<typeof openaiCompatibleText>;

export interface TurnPlanInput {
  dotId: string;
  threadId: string;
  runId: string;
  /** AG-UI messages after upstream removed client-supplied system/developer messages. */
  messages: Message[];
  signal: AbortSignal;
  /** Upstream's permission/pause check; throws when the turn must stop. */
  check: () => void;
  /** Server tools upstream prepared for this Dot (pages, search, computer). */
  baseTools: ToolDefinition[];
}

export interface TurnPlan {
  role: RoleName;
  adapter: ChatAdapter;
  tools: ToolDefinition[];
  systemPromptSuffix?: string;
  maxOutputTokens?: number;
  maxIterations?: number;
}

/** Hooks DotAgent reads from `PlatformConfig.selfhost`. */
export interface SelfhostAgentHooks {
  turnTimeLimitMs: number;
  planTurn?: (input: TurnPlanInput) => Promise<TurnPlan>;
}
