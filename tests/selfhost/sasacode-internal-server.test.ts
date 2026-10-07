import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageReviewTool } from '../../src/shared/page-review.js';
import { roles } from '../../src/selfhost/config/models.js';
import { CommandCodeClient } from '../../src/selfhost/llm/commandcode.js';
import {
  REVIEW_PENDING,
  internalApp,
  startInternalServer,
} from '../../src/selfhost/sasacode/internal-server.js';
import { RunRegistry } from '../../src/selfhost/sasacode/runs.js';
import {
  startFakeCommandCode,
  type FakeCommandCode,
} from './fake-commandcode.js';
import { MemoryRecorder, sasacodeRun, testTools } from './sasacode-helpers.js';

let fake: FakeCommandCode;
let recorder: MemoryRecorder;
let runs: RunRegistry;
let app: ReturnType<typeof internalApp>;
const clients: Client[] = [];

const makeClient = (options: { fetch?: typeof fetch } = {}) =>
  new CommandCodeClient({
    apiKey: 'commandcode-key',
    baseURL: fake.baseURL,
    recorder,
    ...options,
  });

beforeEach(async () => {
  fake = await startFakeCommandCode();
  recorder = new MemoryRecorder();
  runs = new RunRegistry();
  app = internalApp({ runs, client: makeClient() });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await fake.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const post = (path: string, token: string | undefined, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token && auth(token)),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const chatBody = (model: string, extra: object = {}) => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

/** An MCP client that talks to the Hono app in-process. */
async function connect(token: string | undefined, target = app) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://internal.test/mcp'), {
      fetch: async (input, init) => target.fetch(new Request(input, init)),
      requestInit: { headers: token ? auth(token) : {} },
    }),
  );
  return client;
}
const resultText = (result: unknown) =>
  ((result as CallToolResult).content as { type: string; text: string }[])
    .map((block) => block.text)
    .join('');

describe('authentication', () => {
  it('answers 401 without a token or with an unknown one', async () => {
    const token = runs.open(sasacodeRun());
    const requests = [
      () => app.request('/llm/v1/models'),
      () => app.request('/llm/v1/models', { headers: auth('wrong') }),
      () => post('/llm/v1/chat/completions', undefined, chatBody('x')),
      () => post('/llm/v1/chat/completions', 'wrong', chatBody('x')),
      () => post('/mcp', undefined, {}),
      () => post('/mcp', 'wrong', {}),
      () => post('/mcp', token.slice(1), {}),
    ];
    for (const send of requests) {
      const response = await send();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: {
          message: 'Unknown run token.',
          type: 'authentication_error',
        },
      });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('accepts the token with any case of the Bearer scheme', async () => {
    const token = runs.open(sasacodeRun());
    const response = await app.request('/llm/v1/models', {
      headers: { authorization: `bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it('stops accepting a token when its run is closed', async () => {
    const token = runs.open(sasacodeRun());
    expect(
      (await app.request('/llm/v1/models', { headers: auth(token) })).status,
    ).toBe(200);
    runs.close(token);
    expect(
      (await app.request('/llm/v1/models', { headers: auth(token) })).status,
    ).toBe(401);
    expect((await post('/mcp', token, {})).status).toBe(401);
  });
});

describe('GET /llm/v1/models', () => {
  it('lists the models of the three turn roles, not the router or escalation', async () => {
    const token = runs.open(sasacodeRun());
    const response = await app.request('/llm/v1/models', {
      headers: auth(token),
    });
    const body = (await response.json()) as {
      object: string;
      data: { id: string; object: string }[];
    };
    expect(body.object).toBe('list');
    expect(body.data.map((model) => model.id)).toEqual([
      roles.chat.model,
      roles.planner.model,
      roles.worker.model,
    ]);
    expect(body.data.every((model) => model.object === 'model')).toBe(true);
  });
});

describe('POST /llm/v1/chat/completions', () => {
  it('relays to CommandCode with the real key and records usage for the run', async () => {
    fake.onChat(() => ({
      content: 'relayed reply',
      usage: { prompt_tokens: 50, completion_tokens: 7, cached_tokens: 20 },
    }));
    const token = runs.open(
      sasacodeRun({ threadId: 'thread-9', runId: 'run-9', role: 'chat' }),
    );
    const body = chatBody(roles.chat.model, {
      stream: false,
      temperature: 0.3,
    });
    const response = await post('/llm/v1/chat/completions', token, body);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('json');
    const json = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(json.choices[0].message.content).toBe('relayed reply');

    // The request goes out unchanged, with CommandCode's key rather than the run token.
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request.path).toBe('/chat/completions');
    expect(request.headers.authorization).toBe('Bearer commandcode-key');
    expect(request.headers.authorization).not.toContain(token);
    expect(request.body).toEqual(body);

    await recorder.settled(1);
    expect(recorder.records).toEqual([
      {
        at: expect.any(Number),
        role: 'chat',
        model: roles.chat.model,
        endpoint: '/chat/completions',
        threadId: 'thread-9',
        runId: 'run-9',
        inputTokens: 50,
        cachedInputTokens: 20,
        outputTokens: 7,
        reasoningTokens: 0,
        status: 200,
      },
    ]);
  });

  it('streams server-sent events through and meters them', async () => {
    fake.onChat(() => ({
      content: 'streamed reply',
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    }));
    const token = runs.open(sasacodeRun());
    const response = await post(
      '/llm/v1/chat/completions',
      token,
      chatBody(roles.chat.model, { stream: true }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    const streamed = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map(
        (line) =>
          (
            JSON.parse(line.slice(6)) as {
              choices: { delta?: { content?: string } }[];
            }
          ).choices[0]?.delta?.content ?? '',
      )
      .join('');
    expect(streamed).toBe('streamed reply');
    expect(body).toContain('data: [DONE]');
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      inputTokens: 11,
      outputTokens: 3,
      status: 200,
    });
  });

  it("charges each allowed model to its own role, and the run's own model to the run's role", async () => {
    const token = runs.open(
      sasacodeRun({ role: 'worker', model: 'vendor/special-model' }),
    );
    for (const model of [
      roles.planner.model,
      roles.worker.model,
      roles.chat.model,
      'vendor/special-model',
    ])
      expect(
        (await post('/llm/v1/chat/completions', token, chatBody(model))).status,
      ).toBe(200);
    await recorder.settled(4);
    expect(
      recorder.records
        .map((record) => [record.model, record.role])
        .sort(([a], [b]) => a.localeCompare(b)),
    ).toEqual(
      [
        [roles.planner.model, 'planner'],
        [roles.worker.model, 'worker'],
        [roles.chat.model, 'chat'],
        ['vendor/special-model', 'worker'],
      ].sort(([a], [b]) => a.localeCompare(b)),
    );
  });

  it('refuses a model outside the roles without calling CommandCode', async () => {
    const token = runs.open(sasacodeRun());
    for (const model of [roles.router.model, roles.escalation.model, 'gpt-x']) {
      const response = await post(
        '/llm/v1/chat/completions',
        token,
        chatBody(model),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          message: `Model ${model} is not available to this Dot.`,
          type: 'invalid_request',
        },
      });
    }
    const missing = await post('/llm/v1/chat/completions', token, {
      messages: [],
    });
    expect(missing.status).toBe(400);
    expect(
      ((await missing.json()) as { error: { message: string } }).error.message,
    ).toContain('Model undefined');
    expect(fake.requests).toHaveLength(0);
    expect(recorder.records).toHaveLength(0);
  });

  it('refuses a body that is not JSON', async () => {
    const token = runs.open(sasacodeRun());
    const response = await post('/llm/v1/chat/completions', token, 'not json');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'Body is not JSON.', type: 'invalid_request' },
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('passes an upstream error status and body through, and meters the failure', async () => {
    fake.onChat(() => ({
      status: 429,
      error: { type: 'rate_limit_error', message: 'slow down' },
    }));
    const token = runs.open(sasacodeRun());
    const response = await post(
      '/llm/v1/chat/completions',
      token,
      chatBody(roles.chat.model),
    );
    expect(response.status).toBe(429);
    expect(
      ((await response.json()) as { error: { message: string } }).error.message,
    ).toBe('slow down');
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      status: 429,
      errorType: 'rate_limit_error',
      role: 'chat',
    });
  });

  it('answers 502 when CommandCode cannot be reached', async () => {
    const broken = internalApp({
      runs,
      client: makeClient({
        fetch: async () => {
          throw new Error('socket hang up');
        },
      }),
    });
    const token = runs.open(sasacodeRun());
    const response = await broken.request('/llm/v1/chat/completions', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify(chatBody(roles.chat.model)),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { message: 'socket hang up', type: 'upstream_error' },
    });
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      status: 0,
      errorType: 'network_error',
    });
  });

  it('does not call CommandCode for a run that was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const token = runs.open(sasacodeRun({ signal: controller.signal }));
    const response = await post(
      '/llm/v1/chat/completions',
      token,
      chatBody(roles.chat.model),
    );
    expect(response.status).toBe(502);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('/mcp', () => {
  it('lists the tools of the run with their JSON schemas', async () => {
    const { tools } = testTools();
    const token = runs.open(sasacodeRun({ tools }));
    const client = await connect(token);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      tools.map((tool) => tool.name),
    );
    const echo = listed.tools.find((tool) => tool.name === 'echo');
    expect(echo?.description).toBe('Echo the text back.');
    expect(echo?.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
  });

  it('serves each run its own tools', async () => {
    const { tools } = testTools();
    const first = runs.open(sasacodeRun({ tools: tools.slice(0, 1) }));
    const second = runs.open(sasacodeRun({ tools: tools.slice(1, 3) }));
    const names = async (token: string) =>
      (await (await connect(token)).listTools()).tools.map((tool) => tool.name);
    expect(await names(first)).toEqual(['echo']);
    expect(await names(second)).toEqual(['shout', 'quiet']);
  });

  it('offers review_space_page only when the run has an onReview handler', async () => {
    const { tools } = testTools();
    const without = runs.open(sasacodeRun({ tools }));
    const withReview = runs.open(sasacodeRun({ tools, onReview: vi.fn() }));
    const listed = async (token: string) =>
      (await (await connect(token)).listTools()).tools;
    expect((await listed(without)).map((tool) => tool.name)).not.toContain(
      pageReviewTool.name,
    );
    const names = (await listed(withReview)).map((tool) => tool.name);
    expect(names).toEqual([
      ...tools.map((tool) => tool.name),
      pageReviewTool.name,
    ]);
    const review = (await listed(withReview)).find(
      (tool) => tool.name === pageReviewTool.name,
    );
    expect(review?.description).toBe(pageReviewTool.description);
    expect(review?.inputSchema.required).toEqual(
      expect.arrayContaining(['title', 'content', 'spaceId']),
    );
  });

  it('calls a tool with valid arguments and returns its result as JSON text', async () => {
    const { tools, calls } = testTools();
    const client = await connect(runs.open(sasacodeRun({ tools })));
    const result = await client.callTool({
      name: 'echo',
      arguments: { text: 'hi' },
    });
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toBe('{"echoed":"hi"}');
    expect(calls).toEqual([{ tool: 'echo', args: { text: 'hi' } }]);
  });

  it('returns a string result as is and "done" when the tool returns nothing', async () => {
    const { tools } = testTools();
    const client = await connect(runs.open(sasacodeRun({ tools })));
    expect(
      resultText(
        await client.callTool({ name: 'shout', arguments: { text: 'abc' } }),
      ),
    ).toBe('ABC');
    expect(resultText(await client.callTool({ name: 'quiet' }))).toBe('done');
  });

  it('returns isError for invalid arguments without running the tool', async () => {
    const { tools, calls } = testTools();
    const client = await connect(runs.open(sasacodeRun({ tools })));
    for (const args of [{}, { text: 42 }, { text: '' }]) {
      const name = args.text === '' ? 'shout' : 'echo';
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/^Invalid arguments: /);
    }
    expect(calls).toEqual([]);
  });

  it('returns isError for an unknown tool and for one without an executor', async () => {
    const { tools } = testTools();
    const client = await connect(runs.open(sasacodeRun({ tools })));
    const unknown = await client.callTool({ name: 'nope', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(resultText(unknown)).toBe('Unknown tool: nope');
    const interrupt = await client.callTool({ name: 'ask_owner' });
    expect(interrupt.isError).toBe(true);
    expect(resultText(interrupt)).toBe('Unknown tool: ask_owner');
  });

  it('returns isError with the message when a tool throws', async () => {
    const { tools } = testTools();
    const client = await connect(runs.open(sasacodeRun({ tools })));
    const result = await client.callTool({ name: 'explode' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('kaboom');
  });

  it('cuts very long results', async () => {
    const { tools } = testTools();
    const client = await connect(runs.open(sasacodeRun({ tools })));
    const result = await client.callTool({ name: 'flood' });
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toHaveLength(60_000);
  });

  it('does not run tools of a run that was aborted', async () => {
    const { tools, calls } = testTools();
    const controller = new AbortController();
    const client = await connect(
      runs.open(sasacodeRun({ tools, signal: controller.signal })),
    );
    controller.abort();
    const result = await client.callTool({
      name: 'echo',
      arguments: { text: 'late' },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('hands a review draft to onReview and answers that it is pending', async () => {
    const onReview = vi.fn();
    const client = await connect(runs.open(sasacodeRun({ onReview })));
    const result = await client.callTool({
      name: pageReviewTool.name,
      arguments: { title: '  Weekly notes  ', content: '# Hi', spaceId: 's1' },
    });
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toBe(REVIEW_PENDING);
    expect(REVIEW_PENDING).toMatch(/Stop here/);
    expect(onReview).toHaveBeenCalledOnce();
    expect(onReview).toHaveBeenCalledWith({
      title: 'Weekly notes',
      content: '# Hi',
      spaceId: 's1',
    });
  });

  it('rejects an invalid review draft without calling onReview', async () => {
    const onReview = vi.fn();
    const client = await connect(runs.open(sasacodeRun({ onReview })));
    for (const args of [
      {},
      { title: '', content: 'x', spaceId: 's1' },
      { title: 'T', content: 'x', spaceId: 's1', extra: true },
    ]) {
      const result = await client.callTool({
        name: pageReviewTool.name,
        arguments: args,
      });
      expect(result.isError).toBe(true);
    }
    expect(onReview).not.toHaveBeenCalled();
  });

  it('treats review_space_page as unknown when the run has no onReview', async () => {
    const client = await connect(runs.open(sasacodeRun()));
    const result = await client.callTool({
      name: pageReviewTool.name,
      arguments: { title: 'T', content: 'x', spaceId: 's1' },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(`Unknown tool: ${pageReviewTool.name}`);
  });

  it('needs the token on every MCP request', async () => {
    await expect(connect(undefined)).rejects.toThrow();
    await expect(connect('wrong')).rejects.toThrow();
  });
});

describe('startInternalServer', () => {
  it('listens on loopback and serves the same routes until closed', async () => {
    const server = await startInternalServer({ runs, client: makeClient() });
    try {
      expect(server.port).toBeGreaterThan(0);
      const token = runs.open(sasacodeRun());
      const base = `http://127.0.0.1:${server.port}`;
      const models = await fetch(`${base}/llm/v1/models`, {
        headers: auth(token),
      });
      expect(models.status).toBe(200);
      const denied = await fetch(`${base}/llm/v1/models`);
      expect(denied.status).toBe(401);
      const client = new Client({ name: 'test', version: '1.0.0' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: auth(token) },
        }),
      );
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      for (const client of clients.splice(0)) await client.close();
      await server.close();
    }
    await expect(
      fetch(`http://127.0.0.1:${server.port}/llm/v1/models`),
    ).rejects.toThrow();
  });
});
