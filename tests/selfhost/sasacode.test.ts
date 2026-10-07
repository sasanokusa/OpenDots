import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventType } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { prices, roles } from '../../src/selfhost/config/models.js';
import {
  explainReason,
  japaneseReason,
} from '../../src/selfhost/approvals/broker.js';
import {
  OPENDOTS_TOOLS,
  PROVIDER,
  READ_ONLY_COMMANDS,
  TOKEN_ENV,
  sasacodeConfig,
  writeSasacodeConfig,
} from '../../src/selfhost/sasacode/config.js';
import { SasacodeTranslator } from '../../src/selfhost/sasacode/events.js';
import {
  environmentNote,
  turnPrompt,
} from '../../src/selfhost/sasacode/harness.js';
import {
  agentHarness,
  permissionMode,
  privatePaths,
  sshHosts,
} from '../../src/selfhost/sasacode/index.js';
import { RunRegistry, roleForModel } from '../../src/selfhost/sasacode/runs.js';
import { SasacodeSessions } from '../../src/selfhost/sasacode/sessions.js';
import type { SasacodeLine } from '../../src/selfhost/sasacode/events.js';
import {
  assistant,
  sasacodeRun,
  toolResult,
  user,
  type Event,
} from './sasacode-helpers.js';

const text = (delta: string): SasacodeLine => ({
  type: 'message_update',
  event: { type: 'text_delta', index: 0, delta },
});
const callStart = (id: string, name: string, index = 0): SasacodeLine => ({
  type: 'message_update',
  event: { type: 'toolcall_start', index, id, name },
});
const callDelta = (delta: string, index = 0): SasacodeLine => ({
  type: 'message_update',
  event: { type: 'toolcall_delta', index, delta },
});
const assistantEnd = (extra: object = {}): SasacodeLine => ({
  type: 'message_end',
  message: { role: 'assistant', content: [], ...extra },
});
const toolEnd = (
  toolCallId: string,
  toolName: string,
  content: { type: string; text?: string }[],
  isError = false,
): SasacodeLine => ({
  type: 'message_end',
  message: { role: 'tool', toolCallId, toolName, content, isError },
});

function feed(translator: SasacodeTranslator, lines: SasacodeLine[]) {
  return lines.flatMap((line) => translator.push(line)) as Event[];
}
const types = (events: Event[]) => events.map((event) => event.type);

describe('SasacodeTranslator', () => {
  it('emits text as chunks that share one message id per reply', () => {
    const translator = new SasacodeTranslator();
    const first = feed(translator, [
      { type: 'message_start' },
      text('Hel'),
      text('lo'),
      assistantEnd(),
    ]);
    const second = feed(translator, [
      { type: 'message_start' },
      text('Again'),
      assistantEnd(),
    ]);
    expect(types(first)).toEqual([
      EventType.TEXT_MESSAGE_CHUNK,
      EventType.TEXT_MESSAGE_CHUNK,
    ]);
    expect(first.map((event) => event.delta)).toEqual(['Hel', 'lo']);
    expect(first.every((event) => event.role === 'assistant')).toBe(true);
    expect(first[0].messageId).toEqual(expect.any(String));
    expect(first[1].messageId).toBe(first[0].messageId);
    expect(second[0].messageId).not.toBe(first[0].messageId);
  });

  it('starts a fresh message id after an assistant message ends, even without message_start', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [text('one'), assistantEnd(), text('two')]);
    expect(events[0].messageId).not.toBe(events[1].messageId);
  });

  it('ignores empty deltas, thinking and unknown update events', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [
      { type: 'message_start' },
      text(''),
      {
        type: 'message_update',
        event: { type: 'thinking_delta', index: 0, delta: 'hmm' },
      },
      { type: 'message_update', event: { type: 'text_start', index: 0 } },
      { type: 'something_new' },
    ]);
    expect(events).toEqual([]);
  });

  it('parents tool calls to the reply and closes them when it ends', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [
      { type: 'message_start' },
      text('Let me check.'),
      callStart('call-a', 'read_space_page'),
      callDelta('{"pa'),
      callDelta('ge":1}'),
      callStart('call-b', 'search_web', 1),
      callDelta('{"q":"x"}', 1),
      assistantEnd({ stopReason: 'toolUse' }),
    ]);
    const [chunk, startA, argsA1, argsA2, startB, argsB, endA, endB] = events;
    expect(types(events)).toEqual([
      EventType.TEXT_MESSAGE_CHUNK,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_END,
    ]);
    expect(startA).toMatchObject({
      toolCallId: 'call-a',
      toolCallName: 'read_space_page',
      parentMessageId: chunk.messageId,
    });
    expect(startB).toMatchObject({
      toolCallId: 'call-b',
      toolCallName: 'search_web',
      parentMessageId: chunk.messageId,
    });
    expect([argsA1, argsA2].map((event) => event.delta).join('')).toBe(
      '{"page":1}',
    );
    expect([argsA1, argsA2].map((event) => event.toolCallId)).toEqual([
      'call-a',
      'call-a',
    ]);
    expect(argsB).toMatchObject({ toolCallId: 'call-b', delta: '{"q":"x"}' });
    expect([endA.toolCallId, endB.toolCallId]).toEqual(['call-a', 'call-b']);
    expect(translator.toolName('call-a')).toBe('read_space_page');
    expect(translator.toolName('nope')).toBeUndefined();
  });

  it('gives a tool call that opens a reply a message id of its own', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [
      { type: 'message_start' },
      callStart('call-a', 'echo'),
    ]);
    expect(events[0].parentMessageId).toEqual(expect.any(String));
  });

  it('drops argument deltas for unknown call indexes and empty deltas', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [
      { type: 'message_start' },
      callStart('call-a', 'echo'),
      callDelta('{}', 7),
      callDelta(''),
    ]);
    expect(types(events)).toEqual([EventType.TOOL_CALL_START]);
  });

  it('turns a tool-role message into exactly one TOOL_CALL_RESULT with its text', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [
      { type: 'message_start' },
      callStart('call-a', 'echo'),
      assistantEnd(),
      toolEnd('call-a', 'echo', [
        { type: 'text', text: 'first ' },
        { type: 'image' },
        { type: 'text', text: 'second' },
      ]),
    ]);
    const results = events.filter(
      (event) => event.type === EventType.TOOL_CALL_RESULT,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      role: 'tool',
      toolCallId: 'call-a',
      content: 'first second',
    });
    expect(results[0].messageId).toEqual(expect.any(String));
  });

  it('gives every tool result its own message id', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [
      toolEnd('a', 'echo', [{ type: 'text', text: '1' }]),
      toolEnd('b', 'echo', [{ type: 'text', text: '2' }]),
    ]);
    expect(events[0].messageId).not.toBe(events[1].messageId);
  });

  it('keeps an error result in the stream with its text', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [
      toolEnd('a', 'echo', [{ type: 'text', text: 'Invalid arguments' }], true),
    ]);
    expect(events[0]).toMatchObject({ content: 'Invalid arguments' });
  });

  it('hides results of the named tools only', () => {
    const translator = new SasacodeTranslator(['review_space_page']);
    const events = feed(translator, [
      { type: 'message_start' },
      callStart('r1', 'review_space_page'),
      callStart('e1', 'echo', 1),
      assistantEnd(),
      toolEnd('r1', 'review_space_page', [{ type: 'text', text: 'pending' }]),
      toolEnd('e1', 'echo', [{ type: 'text', text: 'hi' }]),
    ]);
    const results = events.filter(
      (event) => event.type === EventType.TOOL_CALL_RESULT,
    );
    expect(results.map((event) => event.toolCallId)).toEqual(['e1']);
    // The call itself is still visible; only its result is held back.
    expect(types(events)).toContain(EventType.TOOL_CALL_START);
  });

  it('shows every result when nothing is hidden', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [
      toolEnd('r1', 'review_space_page', [{ type: 'text', text: 'pending' }]),
    ]);
    expect(types(events)).toEqual([EventType.TOOL_CALL_RESULT]);
  });

  it('closes open calls at agent_end, once, and records the cause', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [
      { type: 'message_start' },
      callStart('call-a', 'echo'),
      { type: 'agent_end', cause: 'aborted' },
      { type: 'agent_end', cause: 'done' },
    ]);
    expect(types(events)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_END,
    ]);
    expect(events[1].toolCallId).toBe('call-a');
    expect(translator.cause).toBe('done');
  });

  it('closes open calls when a reply is discarded', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [
      { type: 'message_start' },
      callStart('call-a', 'echo'),
      { type: 'message_discarded' },
      assistantEnd(),
    ]);
    expect(types(events)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_END,
    ]);
  });

  it('captures the session id and ignores a null one', () => {
    const translator = new SasacodeTranslator();
    expect(translator.sessionId).toBeUndefined();
    expect(
      feed(translator, [{ type: 'session', id: null, path: null }]),
    ).toEqual([]);
    expect(translator.sessionId).toBeUndefined();
    feed(translator, [{ type: 'session', id: 'abc123', path: '/x' }]);
    expect(translator.sessionId).toBe('abc123');
  });

  it('remembers error lines and error replies', () => {
    const translator = new SasacodeTranslator();
    feed(translator, [{ type: 'error', error: 'boom' }]);
    expect(translator.lastError).toBe('boom');
    feed(translator, [
      assistantEnd({ stopReason: 'error', errorMessage: 'provider down' }),
    ]);
    expect(translator.lastError).toBe('provider down');
    feed(translator, [assistantEnd({ stopReason: 'error' })]);
    expect(translator.lastError).toBe('provider down');
  });

  it('passes over user messages and control lines', () => {
    const translator = new SasacodeTranslator();
    const events = feed(translator, [
      {
        type: 'message_end',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      { type: 'control_error', error: 'bad line' },
      { type: 'approval_cancelled', id: 'x' },
    ]);
    expect(events).toEqual([]);
  });
});

describe('turnPrompt', () => {
  it('sends only what follows the last assistant reply', () => {
    const prompt = turnPrompt(
      [user('first'), assistant('answer'), user('second'), user('third')],
      true,
    );
    expect(prompt).toBe('second\n\nthird');
  });

  it('sends every message when there is no assistant reply yet', () => {
    expect(turnPrompt([user('only')], false)).toBe('only');
    expect(turnPrompt([user('a'), user('b')], false)).toBe('a\n\nb');
  });

  it('adds a transcript of what came before only when the session is new', () => {
    const messages = [
      user('first question'),
      assistant('first answer'),
      user('second question'),
      assistant('second answer'),
      user('follow-up'),
    ];
    const fresh = turnPrompt(messages, false);
    expect(fresh).toBe(
      [
        'Earlier in this conversation (for context):',
        'Owner: first question',
        '',
        'You: first answer',
        '',
        'Owner: second question',
        '',
        'You: second answer',
        '',
        'follow-up',
      ].join('\n'),
    );
    const resumed = turnPrompt(messages, true);
    expect(resumed).toBe('follow-up');
    expect(resumed).not.toContain('Earlier in this conversation');
  });

  it('leaves tool messages and empty replies out of the transcript', () => {
    const prompt = turnPrompt(
      [
        user('look it up'),
        assistant('', [{ id: 'c1', name: 'search_web' }]),
        toolResult('c1', 'search result'),
        assistant('found it'),
        user('thanks'),
      ],
      false,
    );
    expect(prompt).toContain('Owner: look it up\n\nYou: found it');
    expect(prompt).not.toContain('search result');
    expect(prompt.endsWith('\n\nthanks')).toBe(true);
  });

  it('phrases the answer to a review card as the owner decision', () => {
    const prompt = turnPrompt(
      [
        user('write a page'),
        assistant('', [{ id: 'rev1', name: 'review_space_page' }]),
        toolResult('rev1', 'Approved. Saved at /space/p1'),
      ],
      true,
    );
    expect(prompt).toBe(
      "The owner's decision on your review_space_page draft: Approved. Saved at /space/p1",
    );
  });

  it('labels other tool results with their call id', () => {
    const prompt = turnPrompt(
      [
        user('go'),
        assistant('', [{ id: 'x1', name: 'ask_owner' }]),
        toolResult('x1', 'yes please'),
      ],
      true,
    );
    expect(prompt).toBe('Tool result (x1): yes please');
  });

  it('only treats a tool message as a review answer when its call was the review tool', () => {
    const prompt = turnPrompt(
      [
        assistant('', [
          { id: 'rev1', name: 'review_space_page' },
          { id: 'other', name: 'echo' },
        ]),
        toolResult('other', 'echoed'),
        toolResult('rev1', 'Declined'),
      ],
      true,
    );
    expect(prompt).toBe(
      [
        'Tool result (other): echoed',
        "The owner's decision on your review_space_page draft: Declined",
      ].join('\n\n'),
    );
  });

  it('reads text from array content and skips other parts', () => {
    const arrayUser = {
      id: 'u1',
      role: 'user',
      content: [
        { type: 'text', text: 'look at ' },
        { type: 'binary', mimeType: 'image/png', data: 'AAAA' },
        { type: 'text', text: 'this' },
      ],
    } as never;
    expect(turnPrompt([arrayUser], true)).toBe('look at this');
    const arrayAssistant = {
      id: 'a1',
      role: 'assistant',
      content: [{ type: 'text', text: 'earlier answer' }],
    } as never;
    expect(
      turnPrompt([user('q'), arrayAssistant, user('next')], false),
    ).toContain('You: earlier answer');
  });

  it('skips blank messages and falls back to Continue.', () => {
    expect(turnPrompt([user('   ')], true)).toBe('Continue.');
    expect(turnPrompt([], false)).toBe('Continue.');
    expect(turnPrompt([user('q'), assistant('a')], true)).toBe('Continue.');
  });

  it('ignores messages that are neither user nor tool after the last reply', () => {
    const activity = {
      id: 'x',
      role: 'activity',
      activityType: 'x',
      content: { note: 'n' },
    } as never;
    expect(turnPrompt([assistant('a'), activity, user('next')], true)).toBe(
      'next',
    );
  });

  it('keeps the newest part of a very long transcript', () => {
    const long = 'x'.repeat(30_000);
    const prompt = turnPrompt(
      [user(`${long}END`), assistant('ok'), user('now')],
      false,
    );
    const body = prompt.split('\n\nnow')[0];
    expect(body.length).toBeLessThan(20_100);
    expect(body).toContain('You: ok');
    expect(
      body.startsWith('Earlier in this conversation (for context):\n'),
    ).toBe(true);
  });
});

describe('environmentNote', () => {
  it('names the working directory and forbids revealing secrets', () => {
    const note = environmentNote('/srv/dots/dot-1');
    expect(note).toContain('Your working directory is /srv/dots/dot-1');
    expect(note).toContain('without sudo');
    expect(note).toContain('opendots MCP server');
    expect(note).toMatch(/Never reveal secrets/);
    expect(note).not.toContain('ssh');
  });

  it('lists the other servers the Dot can reach over ssh', () => {
    const note = environmentNote('/srv/dots/dot-1', ['bazzite', 'sasa-llm']);
    expect(note).toContain(
      'over SSH as an unprivileged user: bazzite, sasa-llm.',
    );
    expect(note).toContain('`ssh <host> <command>`');
    expect(note).toContain('sudo is not available there either');
  });
});

describe('sshHosts', () => {
  it('reads a comma-separated list, trimmed and without duplicates', () => {
    expect(sshHosts({})).toEqual([]);
    expect(sshHosts({ SASACODE_SSH_HOSTS: ' ' })).toEqual([]);
    expect(
      sshHosts({ SASACODE_SSH_HOSTS: 'bazzite, sasa-llm,,bazzite ,a.b_c' }),
    ).toEqual(['bazzite', 'sasa-llm', 'a.b_c']);
  });

  it('refuses names that are not plain host names', () => {
    for (const bad of ['root@bazzite', '-oProxyCommand=x', 'a b', 'a;b'])
      expect(() => sshHosts({ SASACODE_SSH_HOSTS: bad })).toThrow(
        'SASACODE_SSH_HOSTS has an invalid host name',
      );
  });
});

describe('sasacodeConfig', () => {
  const options = {
    home: '/data/sasacode',
    port: 4567,
    appDir: '/srv/opendots',
    homeDir: '/home/sasa',
  };
  const config = sasacodeConfig(options);

  it('registers the loopback relay as an OpenAI-chat provider keyed by the run token', () => {
    expect(PROVIDER).toBe('opendots');
    expect(config.providers).toEqual({
      opendots: {
        api: 'openai-chat',
        baseUrl: 'http://127.0.0.1:4567/llm/v1',
        apiKeyEnv: 'OPENDOTS_RUN_TOKEN',
      },
    });
    expect(config.model).toBe(`opendots/${roles.chat.model}`);
  });

  it('describes the three turn models with their prices', () => {
    expect(Object.keys(config.modelOverrides).sort()).toEqual(
      [roles.chat.model, roles.planner.model, roles.worker.model]
        .map((model) => `opendots/${model}`)
        .sort(),
    );
    const flash = config.modelOverrides[`opendots/${roles.chat.model}`];
    expect(flash).toMatchObject({
      contextWindow: 131_072,
      maxOutput: roles.chat.maxOutputTokens,
      reasoning: true,
      price: {
        input: prices[roles.chat.model].inputPerM,
        output: prices[roles.chat.model].outputPerM,
        cacheRead: prices[roles.chat.model].cacheReadPerM,
      },
    });
  });

  it('points the MCP server at the loopback port with the token header unexpanded', () => {
    expect(TOKEN_ENV).toBe('OPENDOTS_RUN_TOKEN');
    expect(config.mcpServers.opendots).toMatchObject({
      url: 'http://127.0.0.1:4567/mcp',
      headers: { Authorization: 'Bearer ${OPENDOTS_RUN_TOKEN}' },
      toolNames: 'plain',
      alwaysLoad: true,
    });
    // The token itself must never be written into the file.
    expect(JSON.stringify(config)).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
  });

  it('allows the OpenDots tools by their plain names', () => {
    expect(OPENDOTS_TOOLS).toEqual(
      expect.arrayContaining([
        'list_space_pages',
        'review_space_page',
        'delegate_tasks',
        'computer_*',
      ]),
    );
    for (const name of OPENDOTS_TOOLS) {
      expect(name).toMatch(/^[a-z_*]+$/);
      expect(name).not.toMatch(/^mcp__|^opendots/);
      expect(config.permissions.allow).toContain(name);
    }
  });

  it('lets the model judge by default and keeps secrets out of reach', () => {
    expect(config.permissions.mode).toBe('agent');
    expect(config.judgeModel).toBe(`opendots/${roles.worker.model}`);
    expect(sasacodeConfig({ ...options, mode: 'edits' }).permissions.mode).toBe(
      'edits',
    );
    const { deny } = config.permissions;
    for (const verb of ['read', 'write', 'edit']) {
      expect(deny).toContain(`${verb}(/srv/opendots/.env*)`);
      expect(deny).toContain(`${verb}(/srv/opendots/data/*.sqlite*)`);
      // The default Dot working directories live in data/dots; they must stay writable.
      expect(deny).not.toContain(`${verb}(/srv/opendots/data/**)`);
      expect(deny).toContain(`${verb}(/home/sasa/.ssh/**)`);
      expect(deny).toContain(`${verb}(/home/sasa/.config/**)`);
      expect(deny).toContain(`${verb}(/data/sasacode/.env)`);
    }
    expect(deny).toEqual(
      expect.arrayContaining([
        'bash(*.env*)',
        'bash(*.ssh*)',
        'bash(*TOKEN*)',
        'bash(*API_KEY*)',
        'bash(sudo *)',
        'bash(ssh *sudo*)',
      ]),
    );
  });

  it('auto-allows only read-only shell commands', () => {
    const bash = config.permissions.allow.filter((rule) =>
      rule.startsWith('bash('),
    );
    expect(bash).toEqual(
      READ_ONLY_COMMANDS.map((command) => `bash(${command})`),
    );
    expect(bash).toEqual(
      expect.arrayContaining([
        'bash(uptime)',
        'bash(df *)',
        'bash(systemctl status*)',
        'bash(docker ps*)',
        'bash(ls *)',
      ]),
    );
    // These can read arbitrary files or leak the environment through arguments.
    expect(config.permissions.allow).not.toContain('bash(ps *)');
    expect(config.permissions.allow).not.toContain('bash(grep *)');
    for (const rule of bash) {
      expect(rule).not.toMatch(
        /^bash\((\*|cat \*|grep|env|printenv|sudo|rm|sh|bash|curl|wget|find|xargs|tee|dd|mv|cp)/,
      );
    }
    // Not even cat of an arbitrary path, only specific /proc files.
    expect(bash.filter((rule) => rule.startsWith('bash(cat '))).toEqual([
      'bash(cat /proc/loadavg)',
      'bash(cat /proc/meminfo)',
      'bash(cat /proc/cpuinfo)',
    ]);
  });

  it('turns off plugins and update checks', () => {
    expect(config.plugins.disabled).toEqual(
      expect.arrayContaining(['openai-codex', 'browsr']),
    );
    expect(config.updateCheck).toBe(false);
  });
});

describe('writeSasacodeConfig', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it('writes config.json under a private home, creating parents', () => {
    const root = mkdtempSync(join(tmpdir(), 'sasacode-config-'));
    dirs.push(root);
    const home = join(root, 'deep', 'sasacode');
    const options = { home, port: 1234, appDir: root, homeDir: '/home/x' };
    const path = writeSasacodeConfig(options);
    expect(path).toBe(join(home, 'config.json'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(sasacodeConfig(options))),
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true);
  });

  it('replaces the file when the port changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'sasacode-config-'));
    dirs.push(root);
    const options = { home: root, port: 1, appDir: root, homeDir: root };
    writeSasacodeConfig(options);
    const path = writeSasacodeConfig({ ...options, port: 2 });
    expect(readFileSync(path, 'utf8')).toContain('http://127.0.0.1:2/mcp');
    expect(readFileSync(path, 'utf8')).not.toContain('127.0.0.1:1/');
  });
});

describe('agentHarness', () => {
  it('defaults to the built-in harness', () => {
    expect(agentHarness({})).toBe('builtin');
    expect(agentHarness({ AGENT_HARNESS: undefined })).toBe('builtin');
    expect(agentHarness({ AGENT_HARNESS: '' })).toBe('builtin');
    expect(agentHarness({ AGENT_HARNESS: '   ' })).toBe('builtin');
  });

  it('accepts builtin and sasacode, trimming whitespace', () => {
    expect(agentHarness({ AGENT_HARNESS: 'builtin' })).toBe('builtin');
    expect(agentHarness({ AGENT_HARNESS: 'sasacode' })).toBe('sasacode');
    expect(agentHarness({ AGENT_HARNESS: ' sasacode\n' })).toBe('sasacode');
  });

  it('rejects anything else', () => {
    for (const value of ['codex', 'Sasacode', 'sasacode,builtin', 'true'])
      expect(() => agentHarness({ AGENT_HARNESS: value })).toThrow(
        'AGENT_HARNESS must be builtin or sasacode.',
      );
  });
});

describe('permissionMode', () => {
  it('defaults to agent and accepts the sasacode modes', () => {
    expect(permissionMode({})).toBe('agent');
    expect(permissionMode({ SASACODE_PERMISSION: ' edits ' })).toBe('edits');
    expect(permissionMode({ SASACODE_PERMISSION: 'ask' })).toBe('ask');
    expect(permissionMode({ SASACODE_PERMISSION: 'auto' })).toBe('auto');
  });

  it('rejects anything else', () => {
    expect(() => permissionMode({ SASACODE_PERMISSION: 'yolo' })).toThrow(
      'SASACODE_PERMISSION must be one of agent, edits, ask, auto.',
    );
  });
});

describe('roleForModel', () => {
  it('allows the model of each turn role', () => {
    const run = sasacodeRun({ role: 'worker', model: roles.worker.model });
    expect(roleForModel(roles.chat.model, run)).toBe('chat');
    expect(roleForModel(roles.planner.model, run)).toBe('planner');
    expect(roleForModel(roles.worker.model, run)).toBe('worker');
  });

  it("allows the run's own model under the run's role", () => {
    const run = sasacodeRun({ role: 'worker', model: 'vendor/special-model' });
    expect(roleForModel('vendor/special-model', run)).toBe('worker');
  });

  it("prefers the run's own role when its model is shared", () => {
    const run = sasacodeRun({ role: 'worker', model: roles.planner.model });
    expect(roleForModel(roles.planner.model, run)).toBe('worker');
  });

  it('refuses the router and escalation models and unknown ones', () => {
    const run = sasacodeRun();
    expect(roleForModel(roles.router.model, run)).toBeUndefined();
    expect(roleForModel(roles.escalation.model, run)).toBeUndefined();
    expect(roleForModel('openai/gpt-5.5', run)).toBeUndefined();
    expect(roleForModel('', run)).toBeUndefined();
  });

  it('refuses a model that is not a string', () => {
    const run = sasacodeRun();
    for (const value of [undefined, null, 42, {}, [roles.chat.model]])
      expect(roleForModel(value, run)).toBeUndefined();
  });
});

describe('RunRegistry', () => {
  it('hands out unguessable, distinct tokens that resolve to their run', () => {
    const runs = new RunRegistry();
    const first = sasacodeRun({ runId: 'a' });
    const second = sasacodeRun({ runId: 'b' });
    const tokenA = runs.open(first);
    const tokenB = runs.open(second);
    expect(tokenA).not.toBe(tokenB);
    expect(tokenA).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(runs.get(tokenA)).toBe(first);
    expect(runs.get(tokenB)).toBe(second);
    expect(runs.size).toBe(2);
  });

  it('stops resolving a token once its run is closed', () => {
    const runs = new RunRegistry();
    const token = runs.open(sasacodeRun());
    runs.close(token);
    expect(runs.get(token)).toBeUndefined();
    expect(runs.size).toBe(0);
    runs.close(token);
  });

  it('resolves nothing for a missing or unknown token', () => {
    const runs = new RunRegistry();
    runs.open(sasacodeRun());
    expect(runs.get(undefined)).toBeUndefined();
    expect(runs.get('')).toBeUndefined();
    expect(runs.get('nope')).toBeUndefined();
  });
});

describe('SasacodeSessions', () => {
  it('saves, reads, upserts and deletes a session per thread', () => {
    let now = 1000;
    const sessions = new SasacodeSessions(
      new DatabaseSync(':memory:'),
      () => now,
    );
    expect(sessions.get('t1')).toBeUndefined();
    sessions.save({ threadId: 't1', dotId: 'd1', sessionId: 's1' });
    expect(sessions.get('t1')).toEqual({
      thread_id: 't1',
      dot_id: 'd1',
      session_id: 's1',
      updated_at: 1000,
    });
    now = 2000;
    sessions.save({ threadId: 't1', dotId: 'd2', sessionId: 's2' });
    expect(sessions.get('t1')).toEqual({
      thread_id: 't1',
      dot_id: 'd2',
      session_id: 's2',
      updated_at: 2000,
    });
    sessions.save({ threadId: 't2', dotId: 'd1', sessionId: 's3' });
    sessions.delete('t1');
    expect(sessions.get('t1')).toBeUndefined();
    expect(sessions.get('t2')?.session_id).toBe('s3');
  });

  it('can be constructed twice over one database', () => {
    const db = new DatabaseSync(':memory:');
    new SasacodeSessions(db).save({
      threadId: 't',
      dotId: 'd',
      sessionId: 's',
    });
    expect(new SasacodeSessions(db).get('t')?.session_id).toBe('s');
  });
});

describe('approval reasons', () => {
  it('turns sasacode reasons into sentences for the web and Discord', () => {
    const cases: [string, string, string][] = [
      [
        'mode edits',
        'Not on the list of actions that run without asking.',
        '確認なしで実行できる操作の一覧に入っていません。',
      ],
      [
        'agent judged risky: deletes files outside the workspace',
        'The safety check judged this risky: deletes files outside the workspace',
        '安全チェックで危険と判断されました: deletes files outside the workspace',
      ],
      [
        'judge failed: timeout',
        'The safety check failed: timeout',
        '安全チェックに失敗しました: timeout',
      ],
      [
        'rule ask: bash(git push*)',
        'A permission rule asks first: bash(git push*).',
        '権限ルールで確認が必要です: bash(git push*)',
      ],
    ];
    for (const [raw, english, japanese] of cases) {
      expect(explainReason(raw)).toBe(english);
      expect(japaneseReason(english)).toBe(japanese);
    }
  });
});

describe('privatePaths', () => {
  it('reads absolute directories and keeps them from the Dot', () => {
    expect(privatePaths({})).toEqual([]);
    expect(
      privatePaths({
        SASACODE_PRIVATE_PATHS: ' /mnt/ssd/opendots/google/ ,/a',
      }),
    ).toEqual(['/mnt/ssd/opendots/google', '/a']);
    const config = sasacodeConfig({
      home: '/data/sasacode',
      port: 4567,
      appDir: '/srv/opendots',
      homeDir: '/home/sasa',
      privatePaths: ['/mnt/ssd/opendots/google'],
    });
    expect(config.permissions.deny).toEqual(
      expect.arrayContaining([
        'read(/mnt/ssd/opendots/google)',
        'read(/mnt/ssd/opendots/google/**)',
        'write(/mnt/ssd/opendots/google/**)',
        'bash(*/mnt/ssd/opendots/google*)',
      ]),
    );
  });

  it('refuses relative paths and wildcards', () => {
    for (const bad of ['google', '/mnt/*'])
      expect(() => privatePaths({ SASACODE_PRIVATE_PATHS: bad })).toThrow(
        'SASACODE_PRIVATE_PATHS needs absolute paths without wildcards',
      );
  });
});
