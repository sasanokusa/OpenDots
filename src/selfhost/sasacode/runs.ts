import { randomBytes } from 'node:crypto';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { roles, type RoleName } from '../config/models.js';
import type { PageReviewDraft } from '../../shared/page-review.js';
import type { ServiceTool } from './services.js';

/** One sasacode child process, as the internal server sees it. */
export interface SasacodeRun {
  dotId: string;
  threadId: string;
  runId: string;
  role: RoleName;
  model: string;
  /** OpenDots tools offered to sasacode over MCP for this run. */
  tools: ToolDefinition[];
  /** The Dot's connected-service tools (upstream MCP connections). */
  services?: ServiceTool[];
  /** Set when the browser offered the human review card for this run. */
  onReview?: (draft: PageReviewDraft) => void;
  signal: AbortSignal;
}

/**
 * Per-run bearer tokens. sasacode presents the token as its API key to the
 * LLM relay and in the MCP header; it names the run, so usage and tool calls
 * are attributed to the right thread and stop working when the run ends.
 */
export class RunRegistry {
  readonly #runs = new Map<string, SasacodeRun>();

  open(run: SasacodeRun): string {
    const token = randomBytes(32).toString('base64url');
    this.#runs.set(token, run);
    return token;
  }

  get(token: string | undefined): SasacodeRun | undefined {
    return token ? this.#runs.get(token) : undefined;
  }

  close(token: string): void {
    this.#runs.delete(token);
  }

  get size(): number {
    return this.#runs.size;
  }
}

/** Models a run may call: the turn roles' models plus its own. */
export function roleForModel(
  model: unknown,
  run: SasacodeRun,
): RoleName | undefined {
  if (typeof model !== 'string') return undefined;
  if (model === run.model) return run.role;
  for (const role of ['chat', 'planner', 'worker'] as const)
    if (roles[role].model === model) return role;
  return undefined;
}
