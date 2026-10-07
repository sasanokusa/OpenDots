import { serve, type ServerType } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { pageReviewSchema, pageReviewTool } from '../../shared/page-review.js';
import { roles } from '../config/models.js';
import type { CommandCodeClient } from '../llm/commandcode.js';
import { roleForModel, type RunRegistry, type SasacodeRun } from './runs.js';

export const REVIEW_PENDING =
  'Sent to the owner for review in the app. Stop here and do not call more tools; the decision arrives as the next message.';

const MAX_TOOL_TEXT = 60_000;

function bearer(c: Context): string | undefined {
  return c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
}

function text(value: unknown, isError = false): CallToolResult {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text: body.slice(0, MAX_TOOL_TEXT) }],
    ...(isError && { isError: true }),
  };
}

function inputSchema(tool: ToolDefinition) {
  return z.toJSONSchema(tool.parameters as z.ZodType) as {
    type: 'object';
    [key: string]: unknown;
  };
}

async function validate(tool: ToolDefinition, args: unknown) {
  const result = await tool.parameters['~standard'].validate(args ?? {});
  if (result.issues)
    throw new Error(
      `Invalid arguments: ${result.issues.map((issue) => issue.message).join('; ')}`,
    );
  return result.value;
}

/** A fresh MCP server per request (stateless Streamable HTTP). */
function mcpServer(run: SasacodeRun): Server {
  const server = new Server(
    { name: 'opendots', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...run.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchema(tool),
      })),
      ...(run.services ?? []).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
      ...(run.onReview
        ? [
            {
              name: pageReviewTool.name,
              description: pageReviewTool.description,
              inputSchema: pageReviewTool.parameters as {
                type: 'object';
                [key: string]: unknown;
              },
            },
          ]
        : []),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === pageReviewTool.name && run.onReview) {
        run.onReview(pageReviewSchema.parse(args));
        return text(REVIEW_PENDING);
      }
      const service = run.services?.find((item) => item.name === name);
      if (service) {
        run.signal.throwIfAborted();
        const result = await service.call(
          args && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
        );
        return text(result.text, result.isError);
      }
      const tool = run.tools.find((candidate) => candidate.name === name);
      if (!tool?.execute) return text(`Unknown tool: ${name}`, true);
      run.signal.throwIfAborted();
      return text((await tool.execute(await validate(tool, args))) ?? 'done');
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true);
    }
  });
  return server;
}

export interface InternalServerDeps {
  runs: RunRegistry;
  client: CommandCodeClient;
}

/**
 * Loopback-only endpoints for sasacode child processes: an OpenAI-compatible
 * relay that meters every call, and the OpenDots tools over MCP. Neither is
 * reachable through the public app port.
 */
export function internalApp({ runs, client }: InternalServerDeps): Hono {
  const app = new Hono();
  const unauthorized = (c: Context) =>
    c.json(
      {
        error: { message: 'Unknown run token.', type: 'authentication_error' },
      },
      401,
    );

  app.get('/llm/v1/models', (c) => {
    if (!runs.get(bearer(c))) return unauthorized(c);
    const ids = [...new Set([roles.chat, roles.planner, roles.worker])].map(
      (role) => role.model,
    );
    return c.json({
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', owned_by: 'commandcode' })),
    });
  });

  app.post('/llm/v1/chat/completions', async (c) => {
    const run = runs.get(bearer(c));
    if (!run) return unauthorized(c);
    const body = await c.req.text();
    let model: unknown;
    try {
      model = (JSON.parse(body) as { model?: unknown }).model;
    } catch {
      return c.json(
        { error: { message: 'Body is not JSON.', type: 'invalid_request' } },
        400,
      );
    }
    const role = roleForModel(model, run);
    if (!role)
      return c.json(
        {
          error: {
            message: `Model ${String(model)} is not available to this Dot.`,
            type: 'invalid_request',
          },
        },
        400,
      );
    try {
      const upstream = await client.forward(
        '/chat/completions',
        body,
        {
          role,
          model: model as string,
          threadId: run.threadId,
          runId: run.runId,
        },
        AbortSignal.any([run.signal, c.req.raw.signal]),
      );
      const headers = new Headers();
      const type = upstream.headers.get('content-type');
      if (type) headers.set('content-type', type);
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error) {
      return c.json(
        {
          error: {
            message:
              error instanceof Error ? error.message : 'CommandCode failed.',
            type: 'upstream_error',
          },
        },
        502,
      );
    }
  });

  app.all('/mcp', async (c) => {
    const run = runs.get(bearer(c));
    if (!run) return unauthorized(c);
    const server = mcpServer(run);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}

export interface InternalServer {
  port: number;
  close(): Promise<void>;
}

export function startInternalServer(
  deps: InternalServerDeps,
  port = 0,
): Promise<InternalServer> {
  const app = internalApp(deps);
  return new Promise((resolve) => {
    const server: ServerType = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port },
      (info) =>
        resolve({
          port: info.port,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
              // Streaming relays and MCP requests must not hold shutdown open.
              (
                server as { closeAllConnections?: () => void }
              ).closeAllConnections?.();
            }),
        }),
    );
  });
}
