/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface FakeChatReply {
  content?: string;
  toolCalls?: FakeToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens?: number;
  };
  status?: number;
  error?: { type: string; message: string };
}

export interface FakeRequest {
  /** Path below the base URL, e.g. `/chat/completions`. */
  path: string;
  method: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: any;
}

export interface FakeJsonReply {
  status?: number;
  body: unknown;
}

type MaybePromise<T> = T | Promise<T>;
type ChatHandler = (
  body: any,
  request: FakeRequest,
) => MaybePromise<FakeChatReply>;
type JsonHandler = (
  body: any,
  request: FakeRequest,
) => MaybePromise<FakeJsonReply>;

export interface FakeCommandCode {
  /** e.g. http://127.0.0.1:PORT/provider/v1 */
  baseURL: string;
  requests: FakeRequest[];
  onChat(handler: ChatHandler): void;
  onSystemOne(handler: JsonHandler): void;
  onMessages(handler: JsonHandler): void;
  close(): Promise<void>;
}

const BASE_PATH = '/provider/v1';

const defaultChat: ChatHandler = () => ({
  content: 'ok',
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

// Mirrors the real endpoint: typesafe/jev refuses zero data retention.
const defaultSystemOne: JsonHandler = (body, request) => {
  if (request.headers['x-cmd-zdr'] === '1') {
    return {
      status: 422,
      body: {
        error: {
          message: 'typesafe/jev does not support zero data retention',
          type: 'cmd_zdr_no_providers',
        },
      },
    };
  }
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries<any>(body?.questions ?? {})) {
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria ?? {});
      const rest = keys.slice(1);
      answers[key] = {
        type: 'choice',
        choice: keys[0] ?? '',
        confidence: 0.9,
        probabilities: Object.fromEntries([
          ...(keys.length ? [[keys[0], rest.length ? 0.9 : 1]] : []),
          ...rest.map((name) => [name, 0.1 / rest.length]),
        ]),
      };
    } else if (question.type === 'score') {
      const levels: string[] = question.criteria ?? [];
      answers[key] = {
        type: 'score',
        score: 0,
        confidence: 0.8,
        legend: Object.fromEntries(levels.map((text, i) => [String(i), text])),
        probabilities: Object.fromEntries(
          levels.map((_, i) => [String(i), i === 0 ? 1 : 0]),
        ),
      };
    } else {
      answers[key] = { type: 'noul', noul: 0.5 };
    }
  }
  return {
    body: {
      model: 'typesafe/jev',
      answers,
      usage: { input_tokens: 84, output_tokens: 3 },
    },
  };
};

// Sonnet 5.5 rejects these with a 400; the fake does too so a leak fails loudly.
const REJECTED_MESSAGE_FIELDS = [
  'temperature',
  'top_p',
  'top_k',
  'tool_choice',
];

const defaultMessages: JsonHandler = (body) => {
  const rejected = REJECTED_MESSAGE_FIELDS.find(
    (field) => body?.[field] !== undefined,
  );
  if (rejected) {
    return {
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `${rejected} is not supported for this model`,
        },
      },
    };
  }
  return {
    body: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: body?.model,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 4 },
    },
  };
};

function splitInto(text: string, parts: number): string[] {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / parts));
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size)
    pieces.push(text.slice(i, i + size));
  return pieces;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function openAIUsage(reply: FakeChatReply) {
  const { prompt_tokens, completion_tokens, cached_tokens } = reply.usage ?? {
    prompt_tokens: 10,
    completion_tokens: 5,
  };
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    ...(cached_tokens !== undefined && {
      prompt_tokens_details: { cached_tokens },
    }),
  };
}

function sendChat(res: ServerResponse, body: any, reply: FakeChatReply) {
  const failing = reply.error !== undefined || (reply.status ?? 200) >= 400;
  if (failing) {
    const error = reply.error ?? {
      type: 'server_error',
      message: 'fake error',
    };
    sendJson(res, reply.status ?? 500, {
      error: { message: error.message, type: error.type, code: error.type },
    });
    return;
  }

  const toolCalls = reply.toolCalls ?? [];
  const finishReason = toolCalls.length ? 'tool_calls' : 'stop';
  const base = {
    id: `chatcmpl-fake-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: body?.model ?? 'fake',
  };
  const usage = openAIUsage(reply);

  if (!body?.stream) {
    sendJson(res, 200, {
      ...base,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          message: {
            role: 'assistant',
            content: reply.content ?? null,
            ...(toolCalls.length && {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }),
          },
        },
      ],
      usage,
    });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    res.write(
      `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices, ...extra })}\n\n`,
    );
  const delta = (
    value: Record<string, unknown>,
    finish: string | null = null,
  ) => chunk([{ index: 0, delta: value, finish_reason: finish }]);

  delta({ role: 'assistant', content: '' });
  for (const piece of splitInto(reply.content ?? '', 3)) {
    delta({ content: piece });
  }
  toolCalls.forEach((call, index) => {
    delta({
      tool_calls: [
        {
          index,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: '' },
        },
      ],
    });
    for (const piece of splitInto(call.arguments, 3)) {
      delta({ tool_calls: [{ index, function: { arguments: piece } }] });
    }
  });
  delta({}, finishReason);
  chunk([], { usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const part of req) chunks.push(part as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function startFakeCommandCode(
  options: { port?: number } = {},
): Promise<FakeCommandCode> {
  const requests: FakeRequest[] = [];
  let chatHandler = defaultChat;
  let systemOneHandler = defaultSystemOne;
  let messagesHandler = defaultMessages;

  const server = createServer(async (req, res) => {
    res.on('error', () => undefined);
    try {
      const url = new URL(req.url ?? '/', 'http://fake');
      const path = url.pathname.startsWith(BASE_PATH)
        ? url.pathname.slice(BASE_PATH.length)
        : url.pathname;
      const request: FakeRequest = {
        path,
        method: req.method ?? 'GET',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([name, value]) => [
            name.toLowerCase(),
            Array.isArray(value) ? value.join(', ') : (value ?? ''),
          ]),
        ),
        body: await readBody(req),
      };
      requests.push(request);

      if (request.method === 'GET' && path === '/models') {
        sendJson(res, 200, {
          object: 'list',
          data: [
            'xiaomi/mimo-v2.6-flash',
            'xiaomi/mimo-v2.6-pro',
            'deepseek/deepseek-v4.1-flash',
            'claude-sonnet-5-5',
          ].map((id) => ({ id, object: 'model', owned_by: 'fake' })),
        });
      } else if (request.method === 'POST' && path === '/chat/completions') {
        sendChat(res, request.body, await chatHandler(request.body, request));
      } else if (request.method === 'POST' && path === '/systemone') {
        const reply = await systemOneHandler(request.body, request);
        sendJson(res, reply.status ?? 200, reply.body);
      } else if (request.method === 'POST' && path === '/messages') {
        const reply = await messagesHandler(request.body, request);
        sendJson(res, reply.status ?? 200, reply.body);
      } else {
        sendJson(res, 404, {
          error: {
            message: `No route for ${request.method} ${path}`,
            type: 'not_found',
            code: 'not_found',
          },
        });
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'fake_handler_error',
          code: 'fake_handler_error',
        },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}${BASE_PATH}`,
    requests,
    onChat: (handler) => {
      chatHandler = handler;
    },
    onSystemOne: (handler) => {
      systemOneHandler = handler;
    },
    onMessages: (handler) => {
      messagesHandler = handler;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
