import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chat, toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import {
  CommandCodeClient,
  CommandCodeError,
  DEFAULT_BASE_URL,
  type SystemOneQuestion,
} from '../../src/selfhost/llm/commandcode.js';
import { meteredFetch } from '../../src/selfhost/llm/metered-fetch.js';
import type {
  CallContext,
  UsageRecord,
  UsageRecorder,
} from '../../src/selfhost/types.js';
import {
  startFakeCommandCode,
  type FakeCommandCode,
} from './fake-commandcode.js';

class MemoryRecorder implements UsageRecorder {
  records: UsageRecord[] = [];
  record(record: UsageRecord) {
    this.records.push(record);
  }
  /** Recording of streamed bodies finishes just after the caller does. */
  settled(count: number) {
    return vi.waitFor(() => expect(this.records).toHaveLength(count));
  }
}

const worker: CallContext = {
  role: 'worker',
  model: 'deepseek/deepseek-v4.1-flash',
  threadId: 'thread-1',
  runId: 'run-1',
};
const user = [{ role: 'user' as const, content: 'hi' }];

let fake: FakeCommandCode;
let recorder: MemoryRecorder;
const clientFor = (options: { zdr?: boolean } = {}) =>
  new CommandCodeClient({
    apiKey: 'test-key',
    baseURL: fake.baseURL,
    recorder,
    ...options,
  });

beforeEach(async () => {
  fake = await startFakeCommandCode();
  recorder = new MemoryRecorder();
});
afterEach(async () => {
  await fake.close();
});

describe('chat adapter', () => {
  it('returns streamed text and records usage for the calling role', async () => {
    fake.onChat(() => ({
      content: 'hello from the fake',
      usage: { prompt_tokens: 120, completion_tokens: 30, cached_tokens: 100 },
    }));
    const text = await chat({
      adapter: clientFor().chatAdapter(worker),
      messages: user,
      stream: false,
    });
    expect(text).toBe('hello from the fake');
    await recorder.settled(1);
    expect(recorder.records[0]).toEqual({
      at: expect.any(Number),
      role: 'worker',
      model: 'deepseek/deepseek-v4.1-flash',
      endpoint: '/chat/completions',
      threadId: 'thread-1',
      runId: 'run-1',
      inputTokens: 120,
      cachedInputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 0,
      status: 200,
    });
    const [request] = fake.requests;
    expect(request.headers.authorization).toBe('Bearer test-key');
    expect(request.body).toMatchObject({
      model: 'deepseek/deepseek-v4.1-flash',
      stream: true,
    });
  });

  it('resolves the context per call when given a function', async () => {
    let runId = 'run-a';
    const adapter = clientFor().chatAdapter(() => ({ ...worker, runId }));
    await chat({ adapter, messages: user, stream: false });
    runId = 'run-b';
    await chat({ adapter, messages: user, stream: false });
    await recorder.settled(2);
    expect(recorder.records.map((r) => r.runId).sort()).toEqual([
      'run-a',
      'run-b',
    ]);
  });

  it('runs a tool-call round trip and records both model calls', async () => {
    const seen: string[] = [];
    const echo = toolDefinition({
      name: 'echo',
      description: 'Echo the text back.',
      inputSchema: z.object({ text: z.string() }),
    }).server(({ text }) => {
      seen.push(text);
      return { echoed: text };
    });
    fake.onChat((body) =>
      body.messages.some((message: { role: string }) => message.role === 'tool')
        ? {
            content: 'all done',
            usage: { prompt_tokens: 40, completion_tokens: 4 },
          }
        : {
            toolCalls: [
              { id: 'call_1', name: 'echo', arguments: '{"text":"abc"}' },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 8 },
          },
    );
    const text = await chat({
      adapter: clientFor().chatAdapter(worker),
      messages: user,
      tools: [echo],
      stream: false,
    });
    expect(text).toBe('all done');
    expect(seen).toEqual(['abc']);
    expect(fake.requests).toHaveLength(2);
    await recorder.settled(2);
    const usage = recorder.records
      .map((r) => [r.inputTokens, r.outputTokens, r.status])
      .sort();
    expect(usage).toEqual([
      [20, 8, 200],
      [40, 4, 200],
    ]);
  });

  it('records a 429 with its provider error type', async () => {
    fake.onChat(() => ({
      status: 429,
      error: { type: 'rate_limit_error', message: 'slow down' },
    }));
    await expect(
      chat({
        adapter: clientFor().chatAdapter(worker, { maxRetries: 0 }),
        messages: user,
        stream: false,
      }),
    ).rejects.toThrow();
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      status: 429,
      errorType: 'rate_limit_error',
      inputTokens: 0,
      outputTokens: 0,
      role: 'worker',
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('sends the zero-data-retention header only when enabled', async () => {
    await chat({
      adapter: clientFor({ zdr: true }).chatAdapter(worker),
      messages: user,
      stream: false,
    });
    await chat({
      adapter: clientFor().chatAdapter(worker),
      messages: user,
      stream: false,
    });
    expect(fake.requests.map((r) => r.headers['x-cmd-zdr'])).toEqual([
      '1',
      undefined,
    ]);
    expect(fake.requests[0].headers.authorization).toBe('Bearer test-key');
  });
});

describe('systemOne', () => {
  const questions: Record<string, SystemOneQuestion> = {
    is_urgent: { type: 'noul', instructions: 'Urgent?' },
    department: {
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'payments', shipping: 'delivery' },
    },
    frustration: {
      type: 'score',
      instructions: 'How frustrated?',
      criteria: ['Calm', 'Frustrated', 'Very angry'],
    },
  };

  it('parses answers and records usage as the router', async () => {
    const result = await clientFor().systemOne(questions, 'Payments failed', {
      ctx: { threadId: 'thread-2' },
    });
    expect(result.usage).toEqual({ input_tokens: 84, output_tokens: 3 });
    expect(result.answers.is_urgent).toEqual({ type: 'noul', noul: 0.5 });
    expect(result.answers.department).toMatchObject({
      type: 'choice',
      choice: 'billing',
    });
    expect(result.answers.frustration).toMatchObject({
      type: 'score',
      legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
    });
    expect(fake.requests[0].body).toEqual({
      model: 'typesafe/jev',
      state: 'Payments failed',
      questions,
    });
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      role: 'router',
      model: 'typesafe/jev',
      endpoint: '/systemone',
      threadId: 'thread-2',
      inputTokens: 84,
      outputTokens: 3,
      status: 200,
    });
  });

  it('refuses zero data retention without touching the network', async () => {
    const error = await clientFor({ zdr: true })
      .systemOne(questions, 'x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandCodeError);
    expect(error).toMatchObject({
      status: 422,
      type: 'cmd_zdr_no_providers',
    });
    expect(fake.requests).toHaveLength(0);
    expect(recorder.records).toHaveLength(0);
  });

  it('times out slow answers and records the abort', async () => {
    fake.onSystemOne(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { body: {} };
    });
    await expect(
      clientFor().systemOne(questions, 'x', { timeoutMs: 40 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      status: 0,
      errorType: 'aborted',
    });
  });

  it('honours the caller signal', async () => {
    fake.onSystemOne(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { body: {} };
    });
    const controller = new AbortController();
    const pending = clientFor().systemOne(questions, 'x', {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(new Error('stop')), 30);
    await expect(pending).rejects.toThrow('stop');
  });

  it('throws a CommandCodeError carrying the provider message', async () => {
    fake.onSystemOne(() => ({
      status: 500,
      body: { error: { message: 'jev is down', type: 'server_error' } },
    }));
    await expect(clientFor().systemOne(questions, 'x')).rejects.toMatchObject({
      name: 'CommandCodeError',
      message: 'jev is down',
      status: 500,
      type: 'server_error',
    });
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      status: 500,
      errorType: 'server_error',
    });
  });

  it('rejects a response that does not match the schema', async () => {
    fake.onSystemOne(() => ({
      body: { answers: { is_urgent: { type: 'noul', noul: 'high' } } },
    }));
    await expect(clientFor().systemOne(questions, 'x')).rejects.toMatchObject({
      status: 502,
      type: 'invalid_response',
    });
  });
});

describe('messages', () => {
  it('forwards only model, max_tokens, system and messages', async () => {
    const result = await clientFor().messages({
      model: 'claude-sonnet-5-5',
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'review this' }],
      maxTokens: 800,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      tool_choice: { type: 'auto' },
    });
    expect(result).toMatchObject({
      text: 'ok',
      stopReason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 4 },
    });
    const [request] = fake.requests;
    expect(request.body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 800,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'review this' }],
    });
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.headers.authorization).toBe('Bearer test-key');
  });

  it('omits system when none is given and joins text blocks', async () => {
    fake.onMessages(() => ({
      body: {
        content: [
          { type: 'text', text: 'Hello, ' },
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'world.' },
        ],
        stop_reason: 'max_tokens',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 2,
          output_tokens: 7,
        },
      },
    }));
    const result = await clientFor().messages(
      {
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 10,
      },
      { ctx: { runId: 'run-9' } },
    );
    expect(result.text).toBe('Hello, world.');
    expect(result.stopReason).toBe('max_tokens');
    expect(fake.requests[0].body).not.toHaveProperty('system');
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      role: 'escalation',
      model: 'claude-sonnet-5-5',
      endpoint: '/messages',
      runId: 'run-9',
      inputTokens: 17,
      cachedInputTokens: 5,
      outputTokens: 7,
    });
  });

  it('tolerates malformed usage but rejects a body without content', async () => {
    const request = {
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user' as const, content: 'x' }],
      maxTokens: 10,
    };
    fake.onMessages(() => ({
      body: {
        content: [{ type: 'text', text: 'fine' }],
        usage: { input_tokens: 'many' },
      },
    }));
    const result = await clientFor().messages(request);
    expect(result).toEqual({ text: 'fine' });
    fake.onMessages(() => ({ body: { id: 'msg_x' } }));
    await expect(clientFor().messages(request)).rejects.toMatchObject({
      status: 502,
      type: 'invalid_response',
    });
  });

  it('throws a CommandCodeError for Anthropic-shaped errors', async () => {
    fake.onMessages(() => ({
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'bad max_tokens' },
      },
    }));
    await expect(
      clientFor().messages({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 0,
      }),
    ).rejects.toMatchObject({
      name: 'CommandCodeError',
      message: 'bad max_tokens',
      status: 400,
      type: 'invalid_request_error',
    });
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      status: 400,
      errorType: 'invalid_request_error',
    });
  });
});

describe('client', () => {
  it('defaults to the CommandCode provider URL and trims trailing slashes', () => {
    const options = { apiKey: 'k', recorder };
    expect(new CommandCodeClient(options).baseURL).toBe(DEFAULT_BASE_URL);
    expect(
      new CommandCodeClient({ ...options, baseURL: 'http://x.test/v1//' })
        .baseURL,
    ).toBe('http://x.test/v1');
  });
});

describe('meteredFetch', () => {
  const ctx: CallContext = { role: 'chat', model: 'm' };
  const sse = (events: string[], contentType = 'text/event-stream') =>
    new Response(events.join(''), {
      status: 200,
      headers: { 'content-type': contentType },
    });
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const stub = (response: () => Response | Promise<Response>) =>
    vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      response(),
    );

  it('records non-stream OpenAI JSON usage and leaves the body readable', async () => {
    const response = await meteredFetch(ctx, recorder)(
      `${fake.baseURL}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: user, stream: false }),
      },
    );
    const json = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(json.choices[0].message.content).toBe('ok');
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      endpoint: '/chat/completions',
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      status: 200,
    });
  });

  it('reads Responses usage from non-stream JSON', async () => {
    const base = stub(() =>
      Response.json({
        usage: {
          input_tokens: 50,
          output_tokens: 9,
          input_tokens_details: { cached_tokens: 30 },
          output_tokens_details: { reasoning_tokens: 4 },
        },
      }),
    );
    await meteredFetch(ctx, recorder, { baseFetch: base })(
      'http://x.test/v1/responses',
    );
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      endpoint: '/v1/responses',
      inputTokens: 50,
      cachedInputTokens: 30,
      outputTokens: 9,
      reasoningTokens: 4,
    });
  });

  it('parses Anthropic SSE usage across chunk boundaries and keeps the stream intact', async () => {
    const events = [
      'event: message_start\n',
      data({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
            output_tokens: 1,
          },
        },
      }),
      'event: content_block_delta\n',
      data({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hi' },
      }),
      data({ type: 'message_delta', usage: { output_tokens: 7 } }),
      data({ type: 'message_delta', usage: { output_tokens: 25 } }),
      data({ type: 'message_stop' }),
    ];
    const wire = events.join('');
    const encoder = new TextEncoder();
    const base = stub(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              // Split mid-line so a data line spans two chunks.
              for (let i = 0; i < wire.length; i += 17) {
                controller.enqueue(encoder.encode(wire.slice(i, i + 17)));
              }
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
        ),
    );
    const response = await meteredFetch(ctx, recorder, { baseFetch: base })(
      'https://api.commandcode.ai/provider/v1/messages',
    );
    expect(await response.text()).toBe(wire);
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      endpoint: '/messages',
      inputTokens: 150,
      cachedInputTokens: 40,
      outputTokens: 25,
      status: 200,
    });
  });

  it('parses OpenAI chat and Responses SSE usage, ignoring [DONE] and junk', async () => {
    const chatStream = stub(() =>
      sse([
        ': keep-alive\n\n',
        data({ choices: [{ delta: { content: 'a' } }], usage: null }),
        'data: not json\n\n',
        data({
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 6,
            prompt_tokens_details: { cached_tokens: 8 },
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        }),
        'data: [DONE]\n\n',
      ]),
    );
    const responsesStream = stub(() =>
      sse([
        data({ type: 'response.created', response: { usage: null } }),
        data({ type: 'response.output_text.delta', delta: 'a' }),
        data({
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 70,
              output_tokens: 11,
              input_tokens_details: { cached_tokens: 60 },
              output_tokens_details: { reasoning_tokens: 5 },
            },
          },
        }),
      ]),
    );
    const one = await meteredFetch(ctx, recorder, { baseFetch: chatStream })(
      'http://x.test/provider/v1/chat/completions',
    );
    await one.text();
    const two = await meteredFetch(ctx, recorder, {
      baseFetch: responsesStream,
    })('http://x.test/provider/v1/responses');
    await two.text();
    await recorder.settled(2);
    expect(recorder.records[0]).toMatchObject({
      endpoint: '/chat/completions',
      inputTokens: 12,
      cachedInputTokens: 8,
      outputTokens: 6,
      reasoningTokens: 2,
    });
    expect(recorder.records[1]).toMatchObject({
      endpoint: '/responses',
      inputTokens: 70,
      cachedInputTokens: 60,
      outputTokens: 11,
      reasoningTokens: 5,
    });
  });

  it('records once with partial usage when a stream dies midway', async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const base = stub(
      () =>
        new Response(
          new ReadableStream({
            // Erroring a stream discards chunks nobody has read yet, so wait
            // until both tee branches have consumed the first one.
            async pull(controller) {
              if (pulls++ === 0) {
                controller.enqueue(
                  encoder.encode(
                    data({
                      type: 'message_start',
                      message: { usage: { input_tokens: 9, output_tokens: 1 } },
                    }),
                  ),
                );
              } else {
                await new Promise((resolve) => setTimeout(resolve, 20));
                controller.error(new Error('socket hang up'));
              }
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const response = await meteredFetch(ctx, recorder, { baseFetch: base })(
      'http://x.test/messages',
    );
    await expect(response.text()).rejects.toThrow('socket hang up');
    await recorder.settled(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]).toMatchObject({
      status: 200,
      inputTokens: 9,
      outputTokens: 1,
    });
  });

  it('records network failures and aborts, then rethrows', async () => {
    const failing = meteredFetch(ctx, recorder, {
      baseFetch: stub(() => Promise.reject(new TypeError('fetch failed'))),
    });
    await expect(failing('http://x.test/a')).rejects.toThrow('fetch failed');

    const controller = new AbortController();
    controller.abort();
    const aborted = meteredFetch(ctx, recorder, {
      baseFetch: stub(() =>
        Promise.reject(new DOMException('aborted', 'AbortError')),
      ),
    });
    await expect(
      aborted('http://x.test/b', { signal: controller.signal }),
    ).rejects.toThrow('aborted');

    expect(recorder.records).toMatchObject([
      { status: 0, errorType: 'network_error', endpoint: '/a', inputTokens: 0 },
      { status: 0, errorType: 'aborted', endpoint: '/b' },
    ]);
  });

  it('returns error responses untouched and reads the type from either shape', async () => {
    const openai = new Response(
      JSON.stringify({ error: { message: 'm', code: 'insufficient_quota' } }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    );
    const anthropic = Response.json(
      { type: 'error', error: { type: 'overloaded_error', message: 'm' } },
      { status: 529 },
    );
    const replies = [openai, anthropic];
    const fetcher = meteredFetch(ctx, recorder, {
      baseFetch: stub(() => replies.shift()!),
    });
    const first = await fetcher('http://x.test/provider/v1/chat/completions');
    expect(first.status).toBe(402);
    expect(await first.json()).toMatchObject({
      error: { code: 'insufficient_quota' },
    });
    await fetcher('http://x.test/provider/v1/messages');
    expect(recorder.records).toMatchObject([
      { status: 402, errorType: 'insufficient_quota' },
      { status: 529, errorType: 'overloaded_error' },
    ]);
  });

  it('adds the zdr header to string, Request and Headers-bearing calls', async () => {
    const base = stub(() => Response.json({}));
    const fetcher = meteredFetch(ctx, recorder, { baseFetch: base, zdr: true });

    await fetcher('http://x.test/a', {
      headers: { authorization: 'Bearer k', 'X-Other': 'keep' },
    });
    await fetcher('http://x.test/b', {
      headers: new Headers({ authorization: 'Bearer k' }),
    });
    await fetcher('http://x.test/c', {
      headers: [['authorization', 'Bearer k']],
    });
    await fetcher(
      new Request('http://x.test/d', {
        headers: { authorization: 'Bearer k' },
      }),
    );

    const sent = base.mock.calls.map(([, init]) => new Headers(init?.headers));
    for (const headers of sent) {
      expect(headers.get('x-cmd-zdr')).toBe('1');
      expect(headers.get('authorization')).toBe('Bearer k');
    }
    expect(sent[0].get('x-other')).toBe('keep');
  });

  it('leaves headers alone without zdr', async () => {
    const base = stub(() => Response.json({}));
    await meteredFetch(ctx, recorder, { baseFetch: base })('http://x.test/a');
    expect(base.mock.calls[0][1]).toBeUndefined();
  });

  it('stamps the start time and resolves the context per call', async () => {
    let calls = 0;
    let time = 1000;
    const fetcher = meteredFetch(
      () => ({ role: 'chat', model: 'm', runId: `run-${++calls}` }),
      recorder,
      { baseFetch: stub(() => Response.json({})), now: () => time },
    );
    await fetcher('http://x.test/a');
    time = 2000;
    await fetcher('http://x.test/b');
    await recorder.settled(2);
    expect(recorder.records.map((r) => [r.at, r.runId])).toEqual([
      [1000, 'run-1'],
      [2000, 'run-2'],
    ]);
  });

  it('survives a throwing recorder', async () => {
    const broken: UsageRecorder = {
      record() {
        throw new Error('disk full');
      },
    };
    const fetcher = meteredFetch(ctx, broken, {
      baseFetch: stub(() =>
        Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }),
      ),
    });
    const response = await fetcher('http://x.test/a');
    expect(await response.json()).toBeTruthy();
    const streaming = meteredFetch(ctx, broken, {
      baseFetch: stub(() =>
        sse([data({ type: 'message_delta', usage: { output_tokens: 1 } })]),
      ),
    });
    await (await streaming('http://x.test/b')).text();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
