import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';

const SEARCH_CHARS = 12_000;
const PAGE_CHARS = 24_000;
const TIMEOUT_MS = 60_000;

export interface WebSearchOptions {
  /** Streamable HTTP endpoint of a free-search-mcp server (WEB_SEARCH_MCP_URL). */
  url: string;
  check: () => void;
  signal: AbortSignal;
  /** Settings' research switch, read again on every call. */
  allowed: () => boolean;
  fetch?: typeof fetch;
}

function resultText(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

/**
 * search_web and read_public_page for a Dot whose WEB_SEARCH_PROVIDER is off,
 * backed by free-search-mcp (keyless multi-engine search on the server). They
 * use upstream's tool names, so workers sent with needs: ["web"] get them too.
 */
export function webSearchTools(options: WebSearchOptions): ToolDefinition[] {
  const guard = () => {
    options.check();
    if (!options.allowed())
      throw new Error('Research is disabled in Settings.');
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(TIMEOUT_MS),
    ]);
    const client = new Client({ name: 'opendots', version: '1.0.0' });
    const send = options.fetch ?? fetch;
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      fetch: (input, init) =>
        send(input, {
          ...init,
          signal: AbortSignal.any([
            signal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        }),
    });
    try {
      await client.connect(transport);
      const result = (await client.callTool(
        { name, arguments: args },
        undefined,
        { signal, timeout: TIMEOUT_MS },
      )) as CallToolResult;
      const text = resultText(result);
      if (result.isError) throw new Error(text || `${name} failed.`);
      return text;
    } finally {
      await client.close().catch(() => {});
    }
  };
  return [
    defineTool({
      name: 'search_web',
      description:
        'Search the public web (several engines, no account) and return ranked results with snippets and URLs. Read promising results with read_public_page, and cite source URLs.',
      parameters: z.object({
        objective: z.string().min(1).max(4000),
        search_queries: z
          .array(z.string().min(1).max(200))
          .min(1)
          .max(3)
          .describe(
            'One to three concise keyword queries, ideally 3–6 words each.',
          ),
      }),
      execute: async ({ search_queries }) => {
        guard();
        const parts: string[] = [];
        for (const query of search_queries) {
          try {
            parts.push(await call('search', { query }));
          } catch (error) {
            options.signal.throwIfAborted();
            parts.push(
              `# Search: ${query}\n(failed: ${error instanceof Error ? error.message : String(error)})`,
            );
          }
        }
        return clip(parts.join('\n\n'), SEARCH_CHARS);
      },
    }),
    defineTool({
      name: 'read_public_page',
      description:
        'Read a public HTTP(S) page or document (HTML, PDF and the like) as Markdown. No logins, private addresses or write actions.',
      parameters: z.object({ url: z.string().url().max(2048) }),
      execute: async ({ url }) => {
        guard();
        return clip(await call('fetch', { url }), PAGE_CHARS);
      },
    }),
  ];
}
