import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { z } from 'zod';
import { roles } from '../config/models.js';
import type { CallContext, UsageRecorder } from '../types.js';
import { meteredFetch, readProviderError } from './metered-fetch.js';

export const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1';

const SYSTEMONE_TIMEOUT_MS = 3000;
const ANTHROPIC_VERSION = '2023-06-01';

export class CommandCodeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string,
  ) {
    super(message);
    this.name = 'CommandCodeError';
  }
}

export type SystemOneQuestion =
  | { type: 'noul'; instructions: string; criteria?: Record<string, string> }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type SystemOneAnswer =
  | { type: 'noul'; noul: number }
  | {
      type: 'choice';
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: 'score';
      score: number;
      confidence: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
    };

export interface SystemOneResult {
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface MessagesRequest {
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  /** Accepted so callers can pass sampling options, but never sent. */
  [extra: string]: unknown;
}

export interface MessagesResult {
  text: string;
  stopReason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface CommandCodeOptions {
  apiKey: string;
  baseURL?: string;
  recorder: UsageRecorder;
  fetch?: typeof fetch;
  zdr?: boolean;
}

const tokenUsage = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
});

const systemOneAnswer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number() }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number(),
    probabilities: z.record(z.string(), z.number()),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    confidence: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), z.number()),
  }),
]);

const systemOneResponse = z.object({
  answers: z.record(z.string(), systemOneAnswer),
  usage: tokenUsage.optional().catch(undefined),
});

const messagesResponse = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullish(),
  usage: tokenUsage.optional().catch(undefined),
});

const invalidResponse = (what: string) =>
  new CommandCodeError(
    `CommandCode returned an unexpected ${what} response`,
    502,
    'invalid_response',
  );

function callContext(
  base: CallContext,
  override?: Partial<CallContext>,
): CallContext {
  const defined = Object.entries(override ?? {}).filter(
    ([, value]) => value !== undefined,
  );
  return { ...base, ...Object.fromEntries(defined) };
}

export class CommandCodeClient {
  readonly baseURL: string;
  readonly #apiKey: string;
  readonly #recorder: UsageRecorder;
  readonly #fetch?: typeof fetch;
  readonly #zdr: boolean;

  constructor(options: CommandCodeOptions) {
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#recorder = options.recorder;
    this.#fetch = options.fetch;
    this.#zdr = options.zdr ?? false;
  }

  /** OpenAI-compatible TanStack adapter over /chat/completions with metered fetch. */
  chatAdapter(
    ctx: CallContext | (() => CallContext),
    options?: { maxRetries?: number },
  ) {
    const { model } = typeof ctx === 'function' ? ctx() : ctx;
    return openaiCompatibleText(model, {
      apiKey: this.#apiKey,
      baseURL: this.baseURL,
      api: 'chat-completions',
      maxRetries: options?.maxRetries ?? 2,
      fetch: this.#metered(ctx),
    });
  }

  async systemOne(
    questions: Record<string, SystemOneQuestion>,
    state: string,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      ctx?: Partial<CallContext>;
    } = {},
  ): Promise<SystemOneResult> {
    const model = roles.router.model;
    if (this.#zdr) {
      throw new CommandCodeError(
        `${model} does not support zero data retention`,
        422,
        'cmd_zdr_no_providers',
      );
    }
    const timeout = AbortSignal.timeout(
      options.timeoutMs ?? SYSTEMONE_TIMEOUT_MS,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    const json = await this.#post(
      '/systemone',
      { model, state, questions },
      callContext({ role: 'router', model }, options.ctx),
      signal,
    );
    const parsed = systemOneResponse.safeParse(json);
    if (!parsed.success) throw invalidResponse('systemone');
    return parsed.data;
  }

  async messages(
    request: MessagesRequest,
    options: { signal?: AbortSignal; ctx?: Partial<CallContext> } = {},
  ): Promise<MessagesResult> {
    const { model, system, messages, maxTokens } = request;
    // Sonnet 5.5 rejects temperature, top_p, top_k and tool_choice with a 400,
    // so only the fields below are ever forwarded.
    const body = {
      model,
      max_tokens: maxTokens,
      ...(system !== undefined && { system }),
      messages,
    };
    const json = await this.#post(
      '/messages',
      body,
      callContext({ role: 'escalation', model }, options.ctx),
      options.signal,
      { 'anthropic-version': ANTHROPIC_VERSION },
    );
    const parsed = messagesResponse.safeParse(json);
    if (!parsed.success) throw invalidResponse('messages');
    return {
      text: parsed.data.content
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join(''),
      ...(parsed.data.stop_reason && { stopReason: parsed.data.stop_reason }),
      ...(parsed.data.usage && { usage: parsed.data.usage }),
    };
  }

  /**
   * Relays a request body unchanged (used by the sasacode LLM relay). The
   * response, streaming or not, is returned as is; usage is still recorded.
   */
  forward(
    path: string,
    body: string,
    ctx: CallContext,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.#metered(ctx)(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body,
      signal,
    });
  }

  #metered(ctx: CallContext | (() => CallContext)): typeof fetch {
    return meteredFetch(ctx, this.#recorder, {
      baseFetch: this.#fetch,
      zdr: this.#zdr,
    });
  }

  async #post(
    path: string,
    body: unknown,
    ctx: CallContext,
    signal?: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await this.#metered(ctx)(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const { message, type } = readProviderError(await response.text());
      throw new CommandCodeError(
        message ?? `CommandCode ${path} failed with status ${response.status}`,
        response.status,
        type,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      // A caller abort or timeout mid-body is not a malformed response.
      if (signal?.aborted) throw error;
      throw invalidResponse(path.slice(1));
    }
  }
}
