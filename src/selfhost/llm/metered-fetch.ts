import type { CallContext, UsageRecorder } from '../types.js';

export interface MeteredFetchOptions {
  baseFetch?: typeof fetch;
  /** Send `x-cmd-zdr: 1` so CommandCode retains no request data. */
  zdr?: boolean;
  now?: () => number;
}

interface Tally {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

const BASE_PATH = '/provider/v1';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

const emptyTally = (): Tally => ({
  input: 0,
  cached: 0,
  output: 0,
  reasoning: 0,
});

/** Pulls the message and type out of OpenAI- and Anthropic-shaped errors. */
export function readProviderError(body: string): {
  message?: string;
  type?: string;
} {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return {};
  }
  if (!isRecord(data)) return {};
  const error = data.error;
  if (typeof error === 'string') return { message: text(error) };
  if (!isRecord(error)) return { message: text(data.message) };
  const code = typeof error.code === 'number' ? String(error.code) : error.code;
  return { message: text(error.message), type: text(error.type) ?? text(code) };
}

function readUsage(usage: unknown): Tally | undefined {
  if (!isRecord(usage)) return undefined;
  if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
    const prompt = usage.prompt_tokens_details;
    const completion = usage.completion_tokens_details;
    return {
      input: count(usage.prompt_tokens),
      cached: isRecord(prompt) ? count(prompt.cached_tokens) : 0,
      output: count(usage.completion_tokens),
      reasoning: isRecord(completion) ? count(completion.reasoning_tokens) : 0,
    };
  }
  if (!('input_tokens' in usage || 'output_tokens' in usage)) return undefined;
  // Responses, Anthropic and systemone share these names. Anthropic reports
  // cache reads and writes outside of input_tokens, so fold them back in.
  const cacheRead = count(usage.cache_read_input_tokens);
  const inputDetails = usage.input_tokens_details;
  const outputDetails = usage.output_tokens_details;
  return {
    input:
      count(usage.input_tokens) +
      cacheRead +
      count(usage.cache_creation_input_tokens),
    cached:
      cacheRead ||
      (isRecord(inputDetails) ? count(inputDetails.cached_tokens) : 0),
    output: count(usage.output_tokens),
    reasoning: isRecord(outputDetails)
      ? count(outputDetails.reasoning_tokens)
      : 0,
  };
}

function applyEvent(tally: Tally, event: unknown): void {
  if (!isRecord(event)) return;
  if (event.type === 'message_start') {
    const usage = readUsage(
      isRecord(event.message) ? event.message.usage : undefined,
    );
    if (usage) Object.assign(tally, usage);
    return;
  }
  if (event.type === 'message_delta') {
    if (isRecord(event.usage) && 'output_tokens' in event.usage) {
      tally.output = count(event.usage.output_tokens);
    }
    return;
  }
  // Responses events nest usage under `response`; chat chunks carry it directly.
  const usage = readUsage(
    isRecord(event.response) ? event.response.usage : event.usage,
  );
  if (usage) Object.assign(tally, usage);
}

async function drainSse(
  body: ReadableStream<Uint8Array>,
  tally: Tally,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const feed = (line: string) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      applyEvent(tally, JSON.parse(payload));
    } catch {
      // Not JSON; metering must never interfere with the stream.
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) feed(line);
  }
  feed(buffer + decoder.decode());
}

function endpointOf(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split(/[?#]/)[0];
  }
  const at = pathname.indexOf(BASE_PATH);
  return at < 0 ? pathname : pathname.slice(at + BASE_PATH.length) || '/';
}

function withZdr(input: string | URL | Request, init?: RequestInit) {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set('x-cmd-zdr', '1');
  return { ...init, headers };
}

const isAbort = (error: unknown, signal?: AbortSignal | null): boolean =>
  signal?.aborted === true ||
  (isRecord(error) &&
    (error.name === 'AbortError' || error.name === 'TimeoutError'));

/**
 * Wraps fetch so every CommandCode call records its token usage. Metering is
 * best effort: recorder failures and unparseable bodies are swallowed so they
 * can never break the model call itself.
 */
export function meteredFetch(
  ctx: CallContext | (() => CallContext),
  recorder: UsageRecorder,
  options: MeteredFetchOptions = {},
): typeof fetch {
  const metered = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const at = options.now?.() ?? Date.now();
    const call = typeof ctx === 'function' ? ctx() : ctx;
    const endpoint = endpointOf(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    let recorded = false;
    const record = (usage: Tally, status: number, errorType?: string) => {
      if (recorded) return;
      recorded = true;
      try {
        recorder.record({
          at,
          role: call.role,
          model: call.model,
          endpoint,
          ...(call.threadId !== undefined && { threadId: call.threadId }),
          ...(call.runId !== undefined && { runId: call.runId }),
          inputTokens: usage.input,
          cachedInputTokens: usage.cached,
          outputTokens: usage.output,
          reasoningTokens: usage.reasoning,
          status,
          ...(errorType !== undefined && { errorType }),
        });
      } catch {
        // See above: a broken recorder must not fail the call.
      }
    };

    const send = options.baseFetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await (options.zdr
        ? send(input, withZdr(input, init))
        : send(input, init));
    } catch (error) {
      const signal =
        init?.signal ?? (input instanceof Request ? input.signal : null);
      record(
        emptyTally(),
        0,
        isAbort(error, signal) ? 'aborted' : 'network_error',
      );
      throw error;
    }

    const { status } = response;
    if (!response.ok) {
      let errorType: string | undefined;
      try {
        errorType = readProviderError(await response.clone().text()).type;
      } catch {
        // Unreadable error body; keep the status alone.
      }
      record(emptyTally(), status, errorType);
      return response;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream') && response.body) {
      // Branch A goes to the caller; branch B is read here until it ends.
      const [forCaller, forMeter] = response.body.tee();
      const tally = emptyTally();
      void drainSse(forMeter, tally)
        .catch(() => undefined)
        .then(() => record(tally, status));
      return new Response(forCaller, {
        status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    if (contentType.includes('json')) {
      void response
        .clone()
        .json()
        .then(
          (body: unknown) =>
            (isRecord(body) ? readUsage(body.usage) : undefined) ??
            emptyTally(),
          () => emptyTally(),
        )
        .then((usage) => record(usage, status));
      return response;
    }

    record(emptyTally(), status);
    return response;
  };
  return metered as typeof fetch;
}
