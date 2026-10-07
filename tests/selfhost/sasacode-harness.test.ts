import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from '@ag-ui/client';
import { EventType } from '@ag-ui/core';
import type {
  BuiltInAgentFactoryContext,
  ToolDefinition,
} from '@copilotkit/runtime/v2';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { roles } from '../../src/selfhost/config/models.js';
import { CommandCodeClient } from '../../src/selfhost/llm/commandcode.js';
import type {
  HarnessRunInput,
  TurnPlan,
  TurnPlanInput,
} from '../../src/selfhost/router/types.js';
import { writeSasacodeConfig } from '../../src/selfhost/sasacode/config.js';
import {
  createSasacodeHarness,
  environmentNote,
  type ApprovalRequest,
  type SasacodeHarnessDeps,
} from '../../src/selfhost/sasacode/harness.js';
import { createSasacode } from '../../src/selfhost/sasacode/index.js';
import {
  startInternalServer,
  type InternalServer,
} from '../../src/selfhost/sasacode/internal-server.js';
import { RunRegistry } from '../../src/selfhost/sasacode/runs.js';
import { SasacodeSessions } from '../../src/selfhost/sasacode/sessions.js';
import { pageReviewTool } from '../../src/shared/page-review.js';
import {
  startFakeCommandCode,
  type FakeCommandCode,
} from './fake-commandcode.js';
import {
  MemoryRecorder,
  assistant,
  collect,
  ofType,
  testTools,
  textOf,
  toolResult,
  user,
  type Event,
} from './sasacode-helpers.js';

const FAKE = join(import.meta.dirname, 'fake-sasacode.mjs');
const FLASH = roles.chat.model;

interface Invocation {
  argv: string[];
  prompt: string;
  model?: string;
  resume?: string;
  maxTurns?: string;
  cwd: string;
  home?: string;
  system: string;
  systemMode: number;
  scratchMode: number;
}

let root: string;
let home: string;
let workRoot: string;
let logPath: string;
let fake: FakeCommandCode;
let recorder: MemoryRecorder;
let runs: RunRegistry;
let sessions: SasacodeSessions;
let server: InternalServer;
let tools: ToolDefinition[];
let toolCalls: ReturnType<typeof testTools>['calls'];
let planTurn: Mock<(input: TurnPlanInput) => Promise<TurnPlan>>;
let plan: Partial<TurnPlan>;

beforeEach(async () => {
  // realpath: the child reports its cwd with symlinks resolved (macOS /var).
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sasacode-harness-')));
  home = join(root, 'home');
  workRoot = join(root, 'work');
  logPath = join(root, 'invocations.jsonl');
  mkdirSync(home);
  fake = await startFakeCommandCode();
  recorder = new MemoryRecorder();
  runs = new RunRegistry();
  sessions = new SasacodeSessions(new DatabaseSync(':memory:'));
  server = await startInternalServer({
    runs,
    client: new CommandCodeClient({
      apiKey: 'commandcode-key',
      baseURL: fake.baseURL,
      recorder,
    }),
  });
  writeSasacodeConfig({
    home,
    port: server.port,
    appDir: root,
    homeDir: join(root, 'user'),
  });
  ({ tools, calls: toolCalls } = testTools());
  plan = {};
  planTurn = vi.fn<(input: TurnPlanInput) => Promise<TurnPlan>>(async () => ({
    role: 'chat',
    model: FLASH,
    tools,
    systemPromptSuffix: 'SUFFIX',
    maxIterations: 5,
    adapter: undefined as never,
    ...plan,
  }));
});
afterEach(async () => {
  await server.close();
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

const harness = (overrides: Partial<SasacodeHarnessDeps> = {}) =>
  createSasacodeHarness({
    binary: FAKE,
    home,
    workRoot,
    runs,
    sessions,
    planTurn,
    env: {
      FAKE_SASACODE_LOG: logPath,
      FAKE_SASACODE_REVIEW_WAIT_MS: '400',
    },
    killAfterMs: 100,
    ...overrides,
  });

interface TurnOptions {
  threadId?: string;
  runId?: string;
  dotId?: string;
  messages?: Message[];
  offerReview?: boolean;
  signal?: AbortSignal;
  systemPrompt?: string;
}
function turn(options: TurnOptions = {}): HarnessRunInput {
  const signal = options.signal ?? new AbortController().signal;
  return {
    dotId: options.dotId ?? 'dot-1',
    check: vi.fn(),
    baseTools: [],
    systemPrompt: options.systemPrompt ?? 'SYSTEM PROMPT',
    ctx: {
      input: {
        threadId: options.threadId ?? 'thread-1',
        runId: options.runId ?? 'run-1',
        messages: options.messages ?? [user('hello')],
        tools: options.offerReview
          ? [{ name: pageReviewTool.name, description: '', parameters: {} }]
          : [],
        state: {},
        context: [],
        forwardedProps: {},
      },
      abortSignal: signal,
      abortController: new AbortController(),
      learnedSkills: {},
      interrupt: async () => [],
    } as unknown as BuiltInAgentFactoryContext,
  };
}
const run = (
  options: TurnOptions = {},
  deps: Partial<SasacodeHarnessDeps> = {},
) => collect(harness(deps)(turn(options)));
/** A turn whose prompt is `text`. */
const say = (
  text: string,
  options: TurnOptions = {},
  deps: Partial<SasacodeHarnessDeps> = {},
) => run({ ...options, messages: [user(text)] }, deps);

function invocations(): Invocation[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Invocation);
}

describe('a plain text run', () => {
  it('streams the reply as chunks of one message and cleans up', async () => {
    const events = await say('hello there');
    expect(
      events.every((event) => event.type === EventType.TEXT_MESSAGE_CHUNK),
    ).toBe(true);
    expect(new Set(events.map((event) => event.messageId)).size).toBe(1);
    expect(events.every((event) => event.role === 'assistant')).toBe(true);
    expect(events.length).toBeGreaterThan(3);
    expect(textOf(events)).toContain('fake: hello there');
    // The run token is gone and the per-run scratch directory removed.
    expect(runs.size).toBe(0);
    expect(readdirSync(home).filter((name) => name.startsWith('run-'))).toEqual(
      [],
    );
  });

  it('spawns sasacode with the documented arguments in a private per-Dot directory', async () => {
    await say('hello there');
    const [call] = invocations();
    expect(invocations()).toHaveLength(1);
    expect(call.argv).toEqual([
      '-p',
      'hello there',
      '--output',
      'jsonl',
      '--control',
      'stdio',
      '-m',
      `opendots/${FLASH}`,
      '--max-turns',
      '5',
      '--append-system-prompt-file',
      expect.stringMatching(/\/run-[^/]+\/system\.md$/),
    ]);
    expect(call.argv[11].startsWith(`${home}/`)).toBe(true);
    expect(call.cwd).toBe(join(workRoot, 'dot-1'));
    expect(statSync(call.cwd).mode & 0o777).toBe(0o700);
    expect(call.home).toBe(home);
  });

  it('puts the system prompt, the plan suffix and the environment note in the prompt file', async () => {
    const events = await say('[system]');
    const cwd = join(workRoot, 'dot-1');
    const [call] = invocations();
    expect(call.system).toBe(
      ['SYSTEM PROMPT', 'SUFFIX', environmentNote(cwd)].join('\n\n'),
    );
    expect(textOf(events)).toContain('system=SYSTEM PROMPT');
    // Without a suffix there is no empty paragraph between the other two.
    plan = { systemPromptSuffix: undefined };
    await say('[system]');
    expect(invocations()[1].system).toBe(
      ['SYSTEM PROMPT', environmentNote(cwd)].join('\n\n'),
    );
  });

  it('names the other servers in the prompt file when ssh hosts are set', async () => {
    await say('[system]', {}, { sshHosts: ['bazzite', 'sasa-llm'] });
    const cwd = join(workRoot, 'dot-1');
    expect(invocations()[0].system).toBe(
      [
        'SYSTEM PROMPT',
        'SUFFIX',
        environmentNote(cwd, ['bazzite', 'sasa-llm']),
      ].join('\n\n'),
    );
  });

  it('keeps the prompt file and its directory private to the user', async () => {
    await say('hi');
    const [call] = invocations();
    expect(call.systemMode).toBe(0o600);
    expect(call.scratchMode).toBe(0o700);
    // The scratch directory is gone once the run is over.
    expect(existsSync(call.argv[11])).toBe(false);
  });

  it('plans the turn from the filtered conversation and checks permissions', async () => {
    const input = turn({
      messages: [
        { id: 's', role: 'system', content: 'client system' },
        { id: 'd', role: 'developer', content: 'client developer' },
        user('hello'),
      ],
      systemPrompt: 'THE PROMPT',
    });
    const events = await collect(harness()(input));
    expect(planTurn).toHaveBeenCalledOnce();
    expect(planTurn.mock.calls[0][0]).toMatchObject({
      dotId: 'dot-1',
      threadId: 'thread-1',
      runId: 'run-1',
      messages: [user('hello')],
      check: input.check,
      baseTools: input.baseTools,
      systemPrompt: 'THE PROMPT',
    });
    expect(planTurn.mock.calls[0][0].signal).toBe(input.ctx.abortSignal);
    expect(input.check).toHaveBeenCalled();
    expect(textOf(events)).not.toContain('client system');
    expect(invocations()[0].prompt).toBe('hello');
  });

  it('does not start sasacode when the permission check throws', async () => {
    const input = turn();
    vi.mocked(input.check).mockImplementation(() => {
      throw new Error('paused');
    });
    await expect(collect(harness()(input))).rejects.toThrow('paused');
    expect(invocations()).toEqual([]);
    expect(runs.size).toBe(0);
  });

  it('takes the model, role and turn limit from the plan', async () => {
    plan = { role: 'planner', model: roles.planner.model, maxIterations: 12 };
    const events = await say('[llm]');
    const [call] = invocations();
    expect(call.model).toBe(`opendots/${roles.planner.model}`);
    expect(call.maxTurns).toBe('12');
    expect(textOf(events)).toContain('llm replied: ok');
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      role: 'planner',
      model: roles.planner.model,
    });
  });

  it('allows 20 turns when the plan sets no limit', async () => {
    plan = { maxIterations: undefined };
    await say('hi');
    expect(invocations()[0].maxTurns).toBe('20');
  });

  it('keeps each Dot in its own directory below the work root', async () => {
    await say('hi', { dotId: 'dot-a' });
    await say('hi', { dotId: '../../etc/passwd', threadId: 't2' });
    await say('hi', { dotId: '', threadId: 't3' });
    await say('hi', { dotId: 'x'.repeat(200), threadId: 't4' });
    const cwds = invocations().map((call) => call.cwd);
    expect(cwds).toEqual([
      join(workRoot, 'dot-a'),
      join(workRoot, '______etc_passwd'),
      join(workRoot, 'dot'),
      join(workRoot, 'x'.repeat(80)),
    ]);
    expect(readdirSync(workRoot).sort()).toHaveLength(4);
  });
});

describe('the child process environment', () => {
  const KEY = 'COMMAND_CODE_API_KEY';
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("does not inherit the parent's CommandCode key but gets the run token and home", async () => {
    process.env[KEY] = 'parent-secret-for-test';
    const events = await say('hi');
    const text = textOf(events);
    expect(text).toContain('apikey=hidden');
    expect(text).not.toContain('parent-secret-for-test');
    expect(text).toContain('token=set');
    expect(text).toContain(`home=${home}`);
  });

  it('passes through only the extra variables it is given', async () => {
    process.env[KEY] = 'parent-secret-for-test';
    // The fake reports the key if it can see it; deps.env is the only way to pass one on.
    const events = await say('hi', {}, { env: { [KEY]: 'explicit' } });
    expect(textOf(events)).toContain('apikey=visible');
  });
});

describe('sessions', () => {
  it('saves the session id and resumes it on the next turn of the thread', async () => {
    const first = await say('first question');
    expect(textOf(first)).toContain('resumed=no');
    expect(sessions.get('thread-1')).toMatchObject({
      thread_id: 'thread-1',
      dot_id: 'dot-1',
      session_id: 'fake1234',
    });
    const second = await run({
      messages: [user('first question'), assistant('an answer'), user('next')],
    });
    const calls = invocations();
    expect(calls[1].argv.slice(-2)).toEqual(['-r', 'fake1234']);
    // sasacode already holds the earlier turns, so only the new message is sent.
    expect(calls[1].prompt).toBe('next');
    expect(textOf(second)).toContain('resumed=fake1234');
    expect(sessions.get('thread-1')?.session_id).toBe('fake1234');
  });

  it('starts a new session, with a transcript, for a thread it has not seen', async () => {
    await say('one', { threadId: 'thread-a' });
    await run({
      threadId: 'thread-b',
      messages: [user('earlier'), assistant('reply'), user('now')],
    });
    const calls = invocations();
    expect(calls[1].argv).not.toContain('-r');
    expect(calls[1].prompt).toBe(
      [
        'Earlier in this conversation (for context):',
        'Owner: earlier',
        '',
        'You: reply',
        '',
        'now',
      ].join('\n'),
    );
    expect(sessions.get('thread-b')?.session_id).toBe('fake1234');
  });

  it('retries once without -r when the stored session is stale', async () => {
    sessions.save({ threadId: 'thread-1', dotId: 'dot-1', sessionId: 'stale' });
    const events = await run({
      messages: [user('q1'), assistant('a1'), user('q2')],
    });
    const calls = invocations();
    expect(calls).toHaveLength(2);
    expect(calls[0].argv.slice(-2)).toEqual(['-r', 'stale']);
    expect(calls[0].prompt).toBe('q2');
    expect(calls[1].argv).not.toContain('-r');
    // The fresh session has not seen q1 and a1, so they come along as a transcript.
    expect(calls[1].prompt).toContain('Owner: q1');
    expect(calls[1].prompt).toContain('You: a1');
    expect(calls[1].prompt.endsWith('q2')).toBe(true);
    expect(textOf(events)).toContain('resumed=no');
    expect(sessions.get('thread-1')?.session_id).toBe('fake1234');
    expect(runs.size).toBe(0);
  });

  it('does not retry a resumed run that already produced output before failing', async () => {
    sessions.save({ threadId: 'thread-1', dotId: 'dot-1', sessionId: 'good' });
    await expect(
      run({ messages: [user('q1'), assistant('a1'), user('[fail]')] }),
    ).rejects.toThrow('boom');
    expect(invocations()).toHaveLength(1);
    expect(sessions.get('thread-1')?.session_id).toBe('good');
  });

  it('gives up after one retry when a fresh run fails too', async () => {
    sessions.save({ threadId: 'thread-1', dotId: 'dot-1', sessionId: 'stale' });
    await expect(
      run({ messages: [user('q1'), assistant('a1'), user('[crash]')] }),
    ).rejects.toThrow(/sasacode exited with code 3: segfault, probably/);
    expect(invocations()).toHaveLength(2);
    expect(sessions.get('thread-1')).toBeUndefined();
  });
});

describe('tools over MCP', () => {
  it('runs a tool call through the MCP endpoint and reports it as AG-UI events', async () => {
    const events = await say('[tool:echo {"text":"hi there"}]');
    const order = events.map((event) => event.type);
    const start = ofType(events, EventType.TOOL_CALL_START);
    const args = ofType(events, EventType.TOOL_CALL_ARGS);
    const end = ofType(events, EventType.TOOL_CALL_END);
    const result = ofType(events, EventType.TOOL_CALL_RESULT);
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({
      toolCallId: 'call_1',
      toolCallName: 'echo',
    });
    expect(args.map((event) => event.delta).join('')).toBe(
      '{"text":"hi there"}',
    );
    expect(end).toHaveLength(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_1',
      content: '{"echoed":"hi there"}',
    });
    expect(order.indexOf(EventType.TOOL_CALL_START)).toBeLessThan(
      order.indexOf(EventType.TOOL_CALL_ARGS),
    );
    expect(order.indexOf(EventType.TOOL_CALL_END)).toBeLessThan(
      order.indexOf(EventType.TOOL_CALL_RESULT),
    );
    expect(order.indexOf(EventType.TOOL_CALL_RESULT)).toBeLessThan(
      order.indexOf(EventType.TEXT_MESSAGE_CHUNK),
    );
    // The call hangs off a reply of its own, apart from the closing text.
    const closing = ofType(events, EventType.TEXT_MESSAGE_CHUNK);
    expect(start[0].parentMessageId).not.toBe(closing[0].messageId);
    expect(textOf(events)).toBe('tools said: {"echoed":"hi there"}');
    expect(toolCalls).toEqual([{ tool: 'echo', args: { text: 'hi there' } }]);
  });

  it('runs several calls in order', async () => {
    const events = await say(
      '[tool:shout {"text":"abc]"}] then [tool:quiet {}] [tool:echo {"text":"z"}]',
    );
    expect(
      ofType(events, EventType.TOOL_CALL_RESULT).map((event) => event.content),
    ).toEqual(['ABC]', 'done', '{"echoed":"z"}']);
    expect(toolCalls.map((call) => call.tool)).toEqual([
      'shout',
      'quiet',
      'echo',
    ]);
  });

  it('shows a failed tool call as a result and still finishes the run', async () => {
    const events = await say(
      '[tool:echo {"text":5}] [tool:explode {}] [tool:nope {}]',
    );
    const results = ofType(events, EventType.TOOL_CALL_RESULT).map(
      (event) => event.content as string,
    );
    expect(results[0]).toMatch(/^Invalid arguments: /);
    expect(results[1]).toBe('kaboom');
    expect(results[2]).toBe('Unknown tool: nope');
    expect(toolCalls).toEqual([]);
    expect(textOf(events)).toContain('tools said:');
  });

  it('serves exactly the tools of the plan, without the review tool unless offered', async () => {
    const plain = await say('[tools]');
    expect(textOf(plain)).toBe(
      `tools: ${tools.map((tool) => tool.name).join(',')}`,
    );
    const offered = await say('[tools]', { offerReview: true });
    expect(textOf(offered)).toBe(
      `tools: ${[...tools.map((tool) => tool.name), 'review_space_page'].join(',')}`,
    );
  });

  it('relays model calls through the loopback relay and attributes the usage', async () => {
    fake.onChat(() => ({
      content: 'from commandcode',
      usage: { prompt_tokens: 30, completion_tokens: 6 },
    }));
    const events = await say('[llm]', { threadId: 'th-7', runId: 'ru-7' });
    expect(textOf(events)).toBe('llm replied: from commandcode');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].headers.authorization).toBe(
      'Bearer commandcode-key',
    );
    expect(fake.requests[0].body.model).toBe(FLASH);
    await recorder.settled(1);
    expect(recorder.records[0]).toMatchObject({
      role: 'chat',
      model: FLASH,
      threadId: 'th-7',
      runId: 'ru-7',
      inputTokens: 30,
      outputTokens: 6,
    });
  });

  it('refuses a model the Dot may not use', async () => {
    const events = await say(`[llm:${roles.router.model}]`);
    expect(textOf(events)).toBe(
      `llm error 400: Model ${roles.router.model} is not available to this Dot.`,
    );
    expect(fake.requests).toHaveLength(0);
  });
});

describe('approvals', () => {
  it('denies an approval request when there is no approver', async () => {
    const events = await say('[approve]');
    expect(textOf(events)).toMatch(
      /^approval deny: Approval from the owner is not available/,
    );
    // The request itself is not an AG-UI event.
    expect(
      events.every((event) => event.type === EventType.TEXT_MESSAGE_CHUNK),
    ).toBe(true);
  });

  it('answers with the approver decision and feedback', async () => {
    const live: boolean[] = [];
    const approve = vi.fn(
      async (_request: ApprovalRequest, signal: AbortSignal) => {
        live.push(!signal.aborted);
        return { decision: 'allow' as const, feedback: 'go ahead' };
      },
    );
    const events = await say('[approve]', {}, { approve });
    expect(textOf(events)).toBe('approval allow: go ahead');
    expect(approve).toHaveBeenCalledOnce();
    const [request] = approve.mock.calls[0];
    expect(request).toEqual({
      id: 'ap1',
      threadId: 'thread-1',
      dotId: 'dot-1',
      tool: 'bash',
      args: { command: 'rm -rf /tmp/scratch' },
      reason: 'deletes files',
    });
    // The signal is live while the run is, and only ends with it.
    expect(live).toEqual([true]);
  });

  it('passes a refusal on with its feedback', async () => {
    const events = await say(
      '[approve]',
      {},
      {
        approve: async () => ({ decision: 'deny', feedback: 'not now' }),
      },
    );
    expect(textOf(events)).toBe('approval deny: not now');
  });

  it('denies when the approver throws', async () => {
    const events = await say(
      '[approve]',
      {},
      {
        approve: async () => {
          throw new Error('card dismissed');
        },
      },
    );
    expect(textOf(events)).toMatch(
      /^approval deny: Approval from the owner is not available/,
    );
  });

  it('cancels a pending approval when the run is aborted', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    let markRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    const approve = (_request: ApprovalRequest, signal: AbortSignal) => {
      seen = signal;
      markRequested();
      return new Promise<never>(() => undefined);
    };
    const pending = run(
      { signal: controller.signal, messages: [user('[approve]')] },
      { approve },
    );
    await requested;
    controller.abort();
    expect(await pending).toEqual([]);
    expect(seen?.aborted).toBe(true);
  });
});

describe('aborting', () => {
  it('ends quietly when the run is aborted mid-turn', async () => {
    const controller = new AbortController();
    const events: Event[] = [];
    for await (const event of harness()(
      turn({ signal: controller.signal, messages: [user('[slow]')] }),
    )) {
      events.push(event as Event);
      if (textOf(events).includes('working')) controller.abort();
    }
    expect(textOf(events)).toBe('working');
    expect(runs.size).toBe(0);
  });

  it('stops a run that was aborted before it started', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await run({
      signal: controller.signal,
      messages: [user('[slow]')],
    });
    expect(events.map((event) => event.type)).not.toContain(
      EventType.RUN_ERROR,
    );
    expect(runs.size).toBe(0);
  });

  it('kills a child that ignores the abort message', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const events: Event[] = [];
    for await (const event of harness({ killAfterMs: 50 })(
      turn({ signal: controller.signal, messages: [user('[stubborn]')] }),
    )) {
      events.push(event as Event);
      controller.abort();
    }
    expect(textOf(events)).toBe('stubborn');
    expect(Date.now() - started).toBeLessThan(4000);
    expect(runs.size).toBe(0);
  });

  it('closes the run token and removes the scratch files after an abort', async () => {
    const controller = new AbortController();
    const iterator = harness()(
      turn({ signal: controller.signal, messages: [user('[slow]')] }),
    )[Symbol.asyncIterator]();
    await iterator.next();
    expect(runs.size).toBe(1);
    controller.abort();
    while (!(await iterator.next()).done);
    expect(runs.size).toBe(0);
    expect(readdirSync(home).filter((name) => name.startsWith('run-'))).toEqual(
      [],
    );
  });

  it('cleans up when the consumer stops reading early', async () => {
    const iterator = harness()(turn({ messages: [user('[slow]')] }))[
      Symbol.asyncIterator
    ]();
    await iterator.next();
    expect(runs.size).toBe(1);
    await iterator.return?.(undefined);
    expect(runs.size).toBe(0);
  });
});

describe('the review card', () => {
  const draft = { title: 'Notes', content: '# Notes', spaceId: 'space-1' };
  const reviewPrompt = `[tool:review_space_page ${JSON.stringify(draft)}]`;

  it('ends the run after the review tool and shows no result for it', async () => {
    const started = Date.now();
    const events = await say(reviewPrompt, { offerReview: true });
    expect(
      ofType(events, EventType.TOOL_CALL_START).map(
        (event) => event.toolCallName,
      ),
    ).toEqual(['review_space_page']);
    expect(ofType(events, EventType.TOOL_CALL_END)).toHaveLength(1);
    expect(ofType(events, EventType.TOOL_CALL_RESULT)).toEqual([]);
    expect(ofType(events, EventType.TEXT_MESSAGE_CHUNK)).toEqual([]);
    // The fake would keep "working" for 400 ms; the harness stopped it sooner.
    expect(Date.now() - started).toBeLessThan(4000);
    expect(runs.size).toBe(0);
  });

  it('continues the same session with the owner decision on the next turn', async () => {
    await say(reviewPrompt, { offerReview: true });
    expect(sessions.get('thread-1')?.session_id).toBe('fake1234');
    const events = await run({
      offerReview: true,
      messages: [
        user('write notes'),
        assistant('', [{ id: 'call_1', name: 'review_space_page' }]),
        toolResult('call_1', 'Approved and saved at /space-1/notes'),
      ],
    });
    const calls = invocations();
    expect(calls[1].argv.slice(-2)).toEqual(['-r', 'fake1234']);
    expect(calls[1].prompt).toBe(
      "The owner's decision on your review_space_page draft: Approved and saved at /space-1/notes",
    );
    expect(textOf(events)).toContain('resumed=fake1234');
  });

  it('is not offered, and not stopped, when the browser did not send the review tool', async () => {
    const events = await say(reviewPrompt);
    const results = ofType(events, EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Unknown tool: review_space_page');
    expect(textOf(events)).toContain('tools said: Unknown tool');
  });

  it('keeps running when the review draft is invalid', async () => {
    const events = await say(
      '[tool:review_space_page {"title":"","content":"x","spaceId":"s"}]',
      { offerReview: true },
    );
    // Nothing was handed over for review, so there is nothing to wait for.
    expect(textOf(events)).toContain('tools said:');
    expect(ofType(events, EventType.TOOL_CALL_RESULT)).toEqual([]);
  });

  it('only passes an onReview handler to the run registry when the review tool was offered', async () => {
    const open = vi.spyOn(runs, 'open');
    await say('hi');
    await say('hi', { offerReview: true, threadId: 't2' });
    expect(open.mock.calls[0][0].onReview).toBeUndefined();
    expect(open.mock.calls[1][0].onReview).toBeTypeOf('function');
  });
});

describe('failures', () => {
  it('throws the error message sasacode reports', async () => {
    await expect(say('[fail]')).rejects.toThrow(new Error('boom'));
    expect(runs.size).toBe(0);
    expect(readdirSync(home).filter((name) => name.startsWith('run-'))).toEqual(
      [],
    );
  });

  it('reports the exit code and stderr when sasacode dies without a word', async () => {
    await expect(say('[crash]')).rejects.toThrow(
      'sasacode exited with code 3: segfault, probably',
    );
    expect(sessions.get('thread-1')).toBeUndefined();
  });

  it('gives a clear error when the binary does not exist', async () => {
    const missing = join(root, 'no-such-sasacode');
    await expect(say('hi', {}, { binary: missing })).rejects.toThrow(
      `sasacode could not start (${missing}): `,
    );
    expect(runs.size).toBe(0);
  });

  it('does not forget the session when the binary is missing', async () => {
    sessions.save({ threadId: 'thread-1', dotId: 'dot-1', sessionId: 'keep' });
    await expect(
      run(
        { messages: [user('a'), assistant('b'), user('c')] },
        { binary: join(root, 'no-such-sasacode') },
      ),
    ).rejects.toThrow(/could not start/);
    expect(sessions.get('thread-1')?.session_id).toBe('keep');
  });
});

describe('createSasacode', () => {
  const dbs: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  function build() {
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    return createSasacode({
      db,
      client: new CommandCodeClient({
        apiKey: 'commandcode-key',
        baseURL: fake.baseURL,
        recorder,
      }),
      planTurn: Object.assign(planTurn, { log: undefined as never }),
      binary: FAKE,
      home: join(root, 'cs-home'),
      workRoot: join(root, 'cs-work'),
      appDir: root,
    });
  }

  it('writes the config, serves the relay and runs a turn after start()', async () => {
    const sasacode = build();
    await sasacode.start();
    try {
      const config = JSON.parse(
        readFileSync(join(root, 'cs-home', 'config.json'), 'utf8'),
      ) as { providers: { opendots: { baseUrl: string } } };
      expect(config.providers.opendots.baseUrl).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/llm\/v1$/,
      );
      const events = await collect(
        sasacode.runHarness(turn({ messages: [user('[llm]')] })),
      );
      expect(textOf(events)).toBe('llm replied: ok');
      expect(sasacode.sessions.get('thread-1')?.session_id).toBe('fake1234');
      expect(sasacode.runs.size).toBe(0);
    } finally {
      await sasacode.stop();
    }
  });

  it('holds a turn that arrives before start() until the server is up', async () => {
    const sasacode = build();
    let settled = false;
    const early = collect(
      sasacode.runHarness(turn({ messages: [user('[llm]')] })),
    ).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    expect(planTurn).not.toHaveBeenCalled();
    await sasacode.start();
    try {
      expect(textOf(await early)).toBe('llm replied: ok');
    } finally {
      await sasacode.stop();
    }
  });

  it('stop() is harmless before start()', async () => {
    await expect(build().stop()).resolves.toBeUndefined();
  });
});
