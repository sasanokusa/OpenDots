import type { Message } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import type {
  BuiltInAgentFactoryContext,
  ToolDefinition,
} from '@copilotkit/runtime/v2';
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
  /** Upstream's system prompt for this Dot and page; reused by sub-loops. */
  systemPrompt: string;
}

export interface TurnPlan {
  role: RoleName;
  /** CommandCode model id for this role, e.g. `xiaomi/mimo-v2.6-flash`. */
  model: string;
  adapter: ChatAdapter;
  tools: ToolDefinition[];
  systemPromptSuffix?: string;
  maxOutputTokens?: number;
  maxIterations?: number;
}

/** What DotAgent hands an external harness for one run. */
export interface HarnessRunInput {
  dotId: string;
  ctx: BuiltInAgentFactoryContext;
  check: () => void;
  baseTools: ToolDefinition[];
  systemPrompt: string;
}

/** Hooks DotAgent reads from `PlatformConfig.selfhost`. */
export interface SelfhostAgentHooks {
  turnTimeLimitMs: number;
  planTurn?: (input: TurnPlanInput) => Promise<TurnPlan>;
  /** When set, this drives the turn (sasacode) instead of TanStack AI. */
  runHarness?: (input: HarnessRunInput) => AsyncIterable<BaseEvent>;
}
