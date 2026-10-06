import type { RoleName } from './config/models.js';

/** One CommandCode call, as seen by the metered fetch wrapper. */
export interface UsageRecord {
  at: number;
  role: RoleName;
  model: string;
  /** Path below the provider base URL, e.g. `/chat/completions`. */
  endpoint: string;
  threadId?: string;
  runId?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** HTTP status; 0 when the request failed before a response arrived. */
  status: number;
  /** Provider error type such as `rate_limit_error`, when status >= 400. */
  errorType?: string;
}

/** Implemented by usage/meter.ts; consumed by llm/metered-fetch.ts. */
export interface UsageRecorder {
  record(record: UsageRecord): void;
}

/** Which conversation a model call belongs to, for usage attribution. */
export interface CallContext {
  role: RoleName;
  model: string;
  threadId?: string;
  runId?: string;
}
