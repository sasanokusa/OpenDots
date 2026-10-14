import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { describe, expect, it } from 'vitest';
import { webSearchTools } from '../../src/selfhost/agents/web-search.js';
import { webSearchUrl } from '../../src/selfhost/env.js';

/** A stand-in for free-search-mcp, served through a fetch function. */
function fakeSearch(
  answer: (name: string, args: Record<string, unknown>) => string,
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const server = new Server(
      { name: 'free-search', version: '0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ name: request.params.name, args });
      try {
        return {
          content: [{ type: 'text', text: answer(request.params.name, args) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: (error as Error).message }],
          isError: true,
        };
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(new Request(input, init));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function run(tools: ToolDefinition[], name: string, args: object) {
  const tool = tools.find((item) => item.name === name);
  if (!tool?.execute) throw new Error(`missing ${name}`);
  return tool.execute(args as never) as Promise<string>;
}

const options = (fetch: typeof globalThis.fetch, allowed = true) => ({
  url: 'http://127.0.0.1:8820/mcp',
  check: () => {},
  signal: new AbortController().signal,
  allowed: () => allowed,
  fetch,
});

describe('webSearchTools', () => {
  it('runs each query through free-search and joins the results', async () => {
    const fake = fakeSearch((name, args) => `# Search: ${String(args.query)}`);
    const tools = webSearchTools(options(fake.fetch));
    expect(tools.map((tool) => tool.name)).toEqual([
      'search_web',
      'read_public_page',
    ]);
    const text = await run(tools, 'search_web', {
      objective: 'Where is the campus?',
      search_queries: ['campus access', 'campus map'],
    });
    expect(text).toBe('# Search: campus access\n\n# Search: campus map');
    expect(fake.calls).toEqual([
      { name: 'search', args: { query: 'campus access' } },
      { name: 'search', args: { query: 'campus map' } },
    ]);
  });

  it('reports a failed query and keeps the others', async () => {
    const fake = fakeSearch((name, args) => {
      if (args.query === 'bad') throw new Error('every engine was gated');
      return 'ok';
    });
    const text = await run(webSearchTools(options(fake.fetch)), 'search_web', {
      objective: 'x',
      search_queries: ['bad', 'good'],
    });
    expect(text).toContain('(failed: every engine was gated)');
    expect(text).toContain('ok');
  });

  it('reads a page with fetch and surfaces its refusal as an error', async () => {
    const fake = fakeSearch((name, args) => {
      if (String(args.url).includes('127.0.0.1'))
        throw new Error('Refusing to connect to blocked address 127.0.0.1');
      return '# Page';
    });
    const tools = webSearchTools(options(fake.fetch));
    expect(
      await run(tools, 'read_public_page', { url: 'https://example.com/' }),
    ).toBe('# Page');
    await expect(
      run(tools, 'read_public_page', { url: 'http://127.0.0.1:4310/' }),
    ).rejects.toThrow(/blocked address/);
    expect(fake.calls.map((call) => call.name)).toEqual(['fetch', 'fetch']);
  });

  it('follows the research switch in Settings', async () => {
    const fake = fakeSearch(() => 'ok');
    await expect(
      run(webSearchTools(options(fake.fetch, false)), 'search_web', {
        objective: 'x',
        search_queries: ['y'],
      }),
    ).rejects.toThrow(/disabled in Settings/);
    expect(fake.calls).toEqual([]);
  });
});

describe('webSearchUrl', () => {
  it('reads an http(s) URL and rejects anything else', () => {
    expect(webSearchUrl({})).toBeUndefined();
    expect(webSearchUrl({ WEB_SEARCH_MCP_URL: ' ' })).toBeUndefined();
    expect(
      webSearchUrl({ WEB_SEARCH_MCP_URL: 'http://127.0.0.1:8820/mcp' }),
    ).toBe('http://127.0.0.1:8820/mcp');
    expect(() => webSearchUrl({ WEB_SEARCH_MCP_URL: 'file:///x' })).toThrow(
      /http\(s\)/,
    );
    expect(() => webSearchUrl({ WEB_SEARCH_MCP_URL: 'nope' })).toThrow();
  });
});
