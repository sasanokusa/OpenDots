import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exposedTools } from '../../src/server/connections.js';
import type { Connection } from '../../src/shared/connection-types.js';
import {
  explainReason,
  japaneseReason,
} from '../../src/selfhost/approvals/broker.js';
import { CommandCodeClient } from '../../src/selfhost/llm/commandcode.js';
import { sasacodeConfig } from '../../src/selfhost/sasacode/config.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
} from '../../src/selfhost/sasacode/harness.js';
import { environmentNote } from '../../src/selfhost/sasacode/harness.js';
import { internalApp } from '../../src/selfhost/sasacode/internal-server.js';
import { RunRegistry } from '../../src/selfhost/sasacode/runs.js';
import {
  SERVICE_TOOL_PATTERN,
  serviceTools,
  type ServiceToolsInput,
} from '../../src/selfhost/sasacode/services.js';
import { sasacodeRun } from './sasacode-helpers.js';

const tool = (name: string, requiresApproval: boolean, enabled = true) => ({
  name,
  title: name,
  description: `${name} things`,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  readOnly: !requiresApproval,
  enabled,
  requiresApproval,
});

function fakeService(connections: Connection[]) {
  const calls: { tool: string; args: unknown }[] = [];
  const service: ServiceToolsInput['service'] = {
    tools: () => exposedTools(connections),
    resolve: (_dotId, name) => {
      const match = exposedTools(connections).find((t) => t.name === name);
      if (!match)
        throw new Error('Connection tool is not available to this Dot.');
      return match;
    },
    call: async (exposed, args) => {
      calls.push({ tool: exposed.tool.name, args });
      return { isError: false, text: `${exposed.tool.name} ok` };
    },
  };
  return { service, calls };
}

const gmail: Connection = {
  id: 'c1',
  dotId: 'dot-1',
  name: 'Gmail',
  url: 'http://127.0.0.1:8000/mcp',
  hasToken: false,
  tools: [tool('search_messages', false), tool('draft_message', true)],
  error: null,
  createdAt: 0,
  updatedAt: 0,
};

function setup(
  approve?: (request: ApprovalRequest) => Promise<ApprovalDecision>,
) {
  const { service, calls } = fakeService([structuredClone(gmail)]);
  const requests: ApprovalRequest[] = [];
  const tools = serviceTools({
    service,
    dotId: 'dot-1',
    threadId: 'thread-1',
    check: () => {},
    signal: new AbortController().signal,
    approve: approve
      ? (request) => {
          requests.push(request);
          return approve(request);
        }
      : undefined,
  });
  const byName = (name: string) => tools.find((t) => t.name === name)!;
  return { tools, byName, calls, requests };
}

describe('serviceTools', () => {
  it('names tools <connection>__<tool> so one sasacode rule allows them', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      'gmail__search_messages',
      'gmail__draft_message',
    ]);
    expect(SERVICE_TOOL_PATTERN).toBe('*__*');
    expect(tools[1]!.description).toMatch(/^\[Gmail, asks the owner first\]/);
    expect(tools[0]!.inputSchema.type).toBe('object');
  });

  it('runs read-only tools without asking', async () => {
    const approve = vi.fn();
    const { byName, calls } = setup(approve);
    const result = await byName('gmail__search_messages').call({ q: 'x' });
    expect(result).toEqual({ isError: false, text: 'search_messages ok' });
    expect(calls).toEqual([{ tool: 'search_messages', args: { q: 'x' } }]);
    expect(approve).not.toHaveBeenCalled();
  });

  it('asks the owner before an Ask first tool and runs it once allowed', async () => {
    const { byName, calls, requests } = setup(async () => ({
      decision: 'allow',
    }));
    const result = await byName('gmail__draft_message').call({ q: 'hi' });
    expect(result.text).toBe('draft_message ok');
    expect(requests).toEqual([
      expect.objectContaining({
        threadId: 'thread-1',
        dotId: 'dot-1',
        tool: 'Gmail: draft_message',
        args: { q: 'hi' },
        reason: 'connection ask: Gmail',
      }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('runs nothing when the owner declines or nobody can answer', async () => {
    const declined = setup(async () => ({
      decision: 'deny',
      feedback: 'The owner refused this.',
    }));
    expect(
      await declined.byName('gmail__draft_message').call({ q: 'hi' }),
    ).toEqual({ isError: true, text: 'The owner refused this.' });
    expect(declined.calls).toEqual([]);

    const headless = setup();
    const result = await headless.byName('gmail__draft_message').call({});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/needs the owner’s approval/);
    expect(headless.calls).toEqual([]);
  });
});

describe('the internal MCP server', () => {
  const clients: Client[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
  });

  it('lists the service tools next to the OpenDots tools and calls them', async () => {
    const runs = new RunRegistry();
    const app = internalApp({
      runs,
      client: new CommandCodeClient({ apiKey: 'k', baseURL: 'http://x' }),
    });
    const { tools, calls } = setup();
    const token = runs.open(sasacodeRun({ services: tools }));
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://internal.test/mcp'), {
        fetch: async (input, init) => app.fetch(new Request(input, init)),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).toEqual(
      expect.arrayContaining([
        'gmail__search_messages',
        'gmail__draft_message',
      ]),
    );
    const result = (await client.callTool({
      name: 'gmail__search_messages',
      arguments: { q: 'invoice' },
    })) as CallToolResult;
    expect(result.content).toEqual([
      { type: 'text', text: 'search_messages ok' },
    ]);
    expect(calls).toEqual([
      { tool: 'search_messages', args: { q: 'invoice' } },
    ]);
  });
});

describe('sasacode settings for services', () => {
  it('allows service tools in the sasacode config', () => {
    const config = sasacodeConfig({
      home: '/data/sasacode',
      port: 4567,
      appDir: '/srv/opendots',
      homeDir: '/home/sasa',
    });
    expect(config.permissions.allow).toContain('*__*');
  });

  it('tells the Dot about its services and not to use the action card', () => {
    const note = environmentNote('/srv/dots/dot-1', [], ['Gmail', 'GitHub']);
    expect(note).toContain('Connected services: Gmail, GitHub.');
    expect(note).toContain('never call request_connection_action');
    expect(environmentNote('/srv/dots/dot-1')).not.toContain(
      'Connected services',
    );
  });

  it('explains the approval reason in English and Japanese', () => {
    const english = explainReason('connection ask: Gmail');
    expect(english).toBe(
      'This connected-service action asks you first: Gmail.',
    );
    expect(japaneseReason(english)).toBe(
      'つないだサービスへの操作なので、確認が必要です: Gmail',
    );
  });
});
