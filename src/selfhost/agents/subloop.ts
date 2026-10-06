import { chat, maxIterations } from '@tanstack/ai';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { tanstackTools } from '../../server/tanstack-tools.js';
import type { ChatAdapter } from '../router/types.js';

export interface SubloopOptions {
  adapter: ChatAdapter;
  systemPrompts: string[];
  prompt: string;
  tools: ToolDefinition[];
  maxIterations: number;
  maxOutputTokens?: number;
  timeLimitMs: number;
  signal: AbortSignal;
}

/** A nested, non-streaming agent loop run from inside a tool call. */
export async function runSubloop(options: SubloopOptions): Promise<string> {
  options.signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `Sub-task exceeded its ${options.timeLimitMs / 1000} second limit.`,
        ),
      ),
    options.timeLimitMs,
  );
  try {
    const text = await chat({
      adapter: options.adapter,
      messages: [{ role: 'user', content: options.prompt }],
      systemPrompts: options.systemPrompts,
      tools: tanstackTools(options.tools),
      agentLoopStrategy: maxIterations(options.maxIterations),
      modelOptions: options.maxOutputTokens
        ? { max_completion_tokens: options.maxOutputTokens }
        : {},
      abortController: controller,
      stream: false,
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    return text;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
  }
}

/** Runs `tasks` with at most `limit` in flight, preserving order. */
export async function pool<T, R>(
  tasks: T[],
  limit: number,
  run: (task: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(tasks.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, tasks.length)) },
    async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await run(tasks[index], index);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}

const locks = new Map<string, Promise<unknown>>();

/** Serializes work on a shared resource such as one Dot's browser. */
export async function withLock<T>(key: string, work: () => Promise<T>) {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}
