import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ChannelType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DiscordBridge,
  discordConfigFromEnv,
  type DiscordBridgeOptions,
  type DiscordChannelLike,
  type DiscordClientLike,
  type DiscordMessageLike,
} from '../../src/selfhost/discord/bridge.js';
import { splitMessage } from '../../src/selfhost/discord/format.js';

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.secret-token-value';
const OWNER = '123456789012345678';
const OTHER = '987654321098765432';
const URL = 'https://opendots.example.test';

class FakeClient extends EventEmitter implements DiscordClientLike {
  loginCalls: string[] = [];
  destroyed = 0;
  /** Emit `clientReady` right after login unless a test wants to hold it back. */
  readyOnLogin = true;
  loginError: Error | undefined;

  login(token: string) {
    this.loginCalls.push(token);
    if (this.loginError) return Promise.reject(this.loginError);
    if (this.readyOnLogin) queueMicrotask(() => this.emit('clientReady'));
    return Promise.resolve('ok');
  }

  destroy() {
    this.destroyed += 1;
    return Promise.resolve();
  }
}

class FakeChannel implements DiscordChannelLike {
  sent: string[] = [];
  typing = 0;
  sendError: Error | undefined;

  constructor(
    readonly id: string,
    readonly type: number = ChannelType.DM,
  ) {}

  send(text: string) {
    if (this.sendError) return Promise.reject(this.sendError);
    this.sent.push(text);
    return Promise.resolve();
  }

  sendTyping() {
    this.typing += 1;
    return Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Handlers run detached from the emitter, so wait for the macrotask queue.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(overrides: Partial<DiscordBridgeOptions> = {}) {
  const client = new FakeClient();
  const db = new DatabaseSync(':memory:');
  const live = new Set<string>();
  let counter = 0;
  const createThread = vi.fn((_dotId: string, _title: string) => {
    const id = `thread-${++counter}`;
    live.add(id);
    return { id };
  });
  const turn = vi.fn(
    async (_threadId: string, _prompt: string, _signal: AbortSignal) => 'reply',
  );
  const bridge = new DiscordBridge({
    token: TOKEN,
    ownerUserId: OWNER,
    dotId: 'dot-1',
    db,
    createThread,
    threadExists: (id) => live.has(id),
    turn,
    paused: () => false,
    publicUrl: URL,
    client,
    ...overrides,
  });
  const channel = new FakeChannel('dm-1');

  function send(
    content: string,
    options: {
      channel?: FakeChannel;
      authorId?: string;
      bot?: boolean;
    } = {},
  ) {
    const target = options.channel ?? channel;
    const message: DiscordMessageLike = {
      author: { id: options.authorId ?? OWNER, bot: options.bot ?? false },
      channelId: target.id,
      channel: target,
      content,
    };
    client.emit('messageCreate', message);
    return settle();
  }

  return { client, db, live, createThread, turn, bridge, channel, send };
}

async function started(overrides: Partial<DiscordBridgeOptions> = {}) {
  const harness = setup(overrides);
  await harness.bridge.start();
  return harness;
}

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DiscordBridge conversations', () => {
  it('creates one thread for the first DM and reuses it', async () => {
    const { createThread, turn, channel, send, db } = await started();
    await send('hello');
    await send('again');
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledWith('dot-1', 'Discord DM');
    expect(turn).toHaveBeenCalledTimes(2);
    expect(turn.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['thread-1', 'hello'],
      ['thread-1', 'again'],
    ]);
    expect(channel.sent).toEqual(['reply', 'reply']);
    expect(
      db.prepare('SELECT channel_id, thread_id FROM sh_discord_threads').all(),
    ).toEqual([{ channel_id: 'dm-1', thread_id: 'thread-1' }]);
  });

  it('keeps separate threads for separate DM channels', async () => {
    const { turn, send } = await started();
    await send('a');
    await send('b', { channel: new FakeChannel('dm-2') });
    expect(turn.mock.calls.map((call) => call[0])).toEqual([
      'thread-1',
      'thread-2',
    ]);
  });

  it('reuses a mapping that already exists in the database', async () => {
    const first = await started();
    await first.send('hello');
    const second = setup({ db: first.db, threadExists: () => true });
    await second.bridge.start();
    await second.send('after restart');
    expect(second.createThread).not.toHaveBeenCalled();
    expect(second.turn.mock.calls[0]?.[0]).toBe('thread-1');
  });

  it('creates a new thread when the mapped one no longer exists', async () => {
    const { live, createThread, turn, send, db } = await started();
    await send('one');
    live.delete('thread-1');
    await send('two');
    expect(createThread).toHaveBeenCalledTimes(2);
    expect(turn.mock.calls[1]?.[0]).toBe('thread-2');
    expect(
      db.prepare('SELECT thread_id FROM sh_discord_threads').get(),
    ).toEqual({ thread_id: 'thread-2' });
  });

  it('passes /plan and /escalate to the agent unchanged', async () => {
    const { turn, send } = await started();
    await send('/plan   restructure the docs');
    await send('/escalate now');
    await send('/newsletter please');
    expect(turn.mock.calls.map((call) => call[1])).toEqual([
      '/plan   restructure the docs',
      '/escalate now',
      '/newsletter please',
    ]);
  });
});

describe('DiscordBridge filtering', () => {
  it('silently ignores non-owners, bots and non-DM channels', async () => {
    const { createThread, turn, channel, send } = await started();
    const guild = new FakeChannel('guild-1', ChannelType.GuildText);
    await send('secret-content-1', { authorId: OTHER });
    await send('secret-content-2', { bot: true });
    await send('secret-content-3', { bot: true, authorId: OWNER });
    await send('secret-content-4', { channel: guild });
    expect(turn).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
    expect(channel.sent).toEqual([]);
    expect(guild.sent).toEqual([]);
    expect(guild.typing + channel.typing).toBe(0);
    expect(JSON.stringify([...consoleError.mock.calls])).not.toContain(
      'secret-content',
    );
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('asks for text when the message has no content', async () => {
    const { turn, channel, send } = await started();
    await send('   ');
    expect(turn).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(1);
  });

  it('ignores messages once stopped', async () => {
    const { bridge, client, turn, send } = await started();
    await bridge.stop();
    await send('late');
    expect(turn).not.toHaveBeenCalled();
    expect(client.listenerCount('messageCreate')).toBe(0);
  });
});

describe('DiscordBridge commands', () => {
  it('/new switches to a fresh thread and confirms', async () => {
    const { turn, channel, send, db } = await started();
    await send('hello');
    await send('/NEW');
    expect(channel.sent.at(-1)).toContain('新しい会話');
    await send('next');
    expect(turn.mock.calls.map((call) => call[0])).toEqual([
      'thread-1',
      'thread-2',
    ]);
    expect(
      db.prepare('SELECT thread_id FROM sh_discord_threads').all(),
    ).toEqual([{ thread_id: 'thread-2' }]);
  });

  it('/new works on a channel without a mapping yet', async () => {
    const { turn, createThread, send } = await started();
    await send('/new');
    await send('hello');
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(turn.mock.calls[0]?.[0]).toBe('thread-1');
  });

  it('/web returns the public URL, or says it is not configured', async () => {
    const withUrl = await started();
    await withUrl.send('/web');
    expect(withUrl.channel.sent).toEqual([URL]);
    expect(withUrl.turn).not.toHaveBeenCalled();

    const without = await started({ publicUrl: undefined });
    await without.send('/Web extra words');
    expect(without.channel.sent).toHaveLength(1);
    expect(without.channel.sent[0]).toContain('PUBLIC_APP_URL');
  });

  it('/help lists the commands without calling the agent', async () => {
    const { turn, channel, send } = await started();
    await send('/help');
    expect(turn).not.toHaveBeenCalled();
    const text = channel.sent.join('\n');
    expect(text).toContain('/new');
    expect(text).toContain('/web');
    expect(text).toContain('/help');
  });

  it('replies that OpenDots is paused and does not run the turn', async () => {
    const { turn, createThread, channel, send } = await started({
      paused: () => true,
    });
    await send('hello');
    expect(turn).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toContain('一時停止');
    expect(channel.sent[0]).toContain('Web');
  });
});

describe('DiscordBridge turns', () => {
  it('refuses a second message while the channel is busy', async () => {
    const gate = deferred<string>();
    const { turn, channel, send } = await started();
    turn.mockImplementationOnce(() => gate.promise);
    await send('first');
    await send('second');
    expect(turn).toHaveBeenCalledTimes(1);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toContain('処理中');

    // Another DM channel is not blocked by this one.
    const other = new FakeChannel('dm-2');
    await send('elsewhere', { channel: other });
    expect(other.sent).toEqual(['reply']);

    gate.resolve('first answer');
    await settle();
    expect(channel.sent.at(-1)).toBe('first answer');
    await send('third');
    expect(turn).toHaveBeenCalledTimes(3);
    expect(turn.mock.calls.map((call) => call[1])).toEqual([
      'first',
      'elsewhere',
      'third',
    ]);
  });

  it('frees the channel after a failed turn', async () => {
    const { turn, channel, send } = await started();
    turn.mockRejectedValueOnce(new Error('boom'));
    await send('one');
    await send('two');
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[1]).toBe('reply');
  });

  it('shows typing immediately and every 8 seconds until the turn ends', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const gate = deferred<string>();
    const { turn, channel, send } = await started();
    turn.mockImplementationOnce(() => gate.promise);
    await send('slow');
    expect(channel.typing).toBe(1);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(channel.typing).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(channel.typing).toBe(2);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(channel.typing).toBe(4);

    gate.resolve('done');
    await settle();
    expect(channel.sent).toEqual(['done']);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(channel.typing).toBe(4);
  });

  it('survives a failing typing indicator', async () => {
    const { channel, send } = await started();
    channel.sendTyping = () => Promise.reject(new Error('no typing'));
    await send('hello');
    expect(channel.sent).toEqual(['reply']);
  });

  it('splits long replies into chunks of at most 1,900 characters', async () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) =>
      `${index}`.repeat(1200),
    );
    const { turn, channel, send } = await started();
    turn.mockResolvedValueOnce(paragraphs.join('\n\n'));
    await send('long');
    expect(channel.sent).toEqual(paragraphs);
  });

  it('falls back to a short line for an empty reply', async () => {
    const { turn, channel, send } = await started();
    turn.mockResolvedValueOnce('  \n ');
    await send('hello');
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toContain('空');
  });

  it('does not let a failing send crash the handler', async () => {
    const { channel, send } = await started();
    channel.sendError = new Error('Missing Access sk-hidden');
    await send('hello');
    expect(consoleError).toHaveBeenCalledWith('Discord reply failed:', 'Error');
  });

  it('hides provider details when the turn fails', async () => {
    const { turn, channel, send } = await started();
    turn.mockRejectedValueOnce(
      Object.assign(new Error('401 invalid key sk-LIVE-1234'), {
        status: 401,
      }),
    );
    await send('hello');
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toContain('エラー');
    expect(channel.sent[0]).not.toMatch(/sk-LIVE|401|invalid key/);
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).toContain('Error (HTTP 401)');
    expect(logged).not.toMatch(/sk-LIVE|invalid key/);
  });

  it('tells the user when the web UI is running the same thread', async () => {
    const { turn, channel, send } = await started();
    turn.mockRejectedValueOnce(new Error('Thread already running'));
    await send('hello');
    expect(channel.sent[0]).toContain('Web');
    expect(channel.sent[0]).not.toContain('エラーが起きました');
  });

  it('points to the web app when the reply needs a page review', async () => {
    const { turn, channel, send } = await started();
    turn.mockResolvedValueOnce('Draft is ready via review_space_page.');
    await send('write a page');
    expect(channel.sent.join('\n')).toContain('review_space_page');
    expect(channel.sent.join('\n')).toContain(URL);

    turn.mockResolvedValueOnce('plain answer');
    await send('hello');
    expect(channel.sent.at(-1)).toBe('plain answer');
  });

  it('points to the web app when the turn fails over an approval', async () => {
    const { turn, channel, send } = await started();
    turn.mockRejectedValueOnce(new Error('Tool needs approval'));
    await send('do it');
    expect(channel.sent.join('\n')).toContain(URL);
    expect(channel.sent.join('\n')).not.toContain('Tool needs approval');
  });

  it('omits the approval link when no public URL is configured', async () => {
    const { turn, channel, send } = await started({ publicUrl: undefined });
    turn.mockResolvedValueOnce('see review_space_page');
    await send('do it');
    expect(channel.sent).toEqual(['see review_space_page']);
  });

  it('reports a thread creation failure without provider details', async () => {
    const { createThread, channel, send } = await started();
    createThread.mockImplementationOnce(() => {
      throw new Error('disk path /secret/db');
    });
    await send('hello');
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).not.toContain('/secret');
  });
});

describe('DiscordBridge lifecycle', () => {
  it('logs in with the token and resolves after clientReady', async () => {
    const { client, bridge } = setup();
    client.readyOnLogin = false;
    let resolved = false;
    const starting = bridge.start().then(() => {
      resolved = true;
    });
    await settle();
    expect(client.loginCalls).toEqual([TOKEN]);
    expect(resolved).toBe(false);
    client.emit('clientReady');
    await starting;
    expect(resolved).toBe(true);
    expect(client.listenerCount('clientReady')).toBe(0);
  });

  it('rejects after 30 seconds without leaking the token', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { client, bridge } = setup();
    client.readyOnLogin = false;
    const outcome = bridge.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.destroyed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/30 seconds/);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(client.destroyed).toBe(1);
  });

  it('rejects a failed login without leaking the token', async () => {
    const { client, bridge } = setup();
    client.loginError = new Error(`Invalid token ${TOKEN}`);
    const error = await bridge.start().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).toMatch(/login failed/i);
    expect(client.destroyed).toBe(1);
  });

  it('stop() aborts an in-flight turn and destroys the client', async () => {
    const { client, bridge, turn, channel, send } = await started();
    let signal: AbortSignal | undefined;
    turn.mockImplementationOnce(
      (_threadId, _prompt, turnSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal = turnSignal;
          turnSignal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    await send('long job');
    expect(signal?.aborted).toBe(false);
    await bridge.stop();
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(client.destroyed).toBe(1);
    // Nobody is listening any more, so no failure reply for the abort.
    expect(channel.sent).toEqual([]);
  });

  it('logs client errors by class only', async () => {
    const { client } = await started();
    expect(() =>
      client.emit('error', new Error(`socket reset ${TOKEN}`)),
    ).not.toThrow();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(TOKEN);
  });
});

describe('splitMessage', () => {
  const LIMIT = 1900;
  const fenceLines = (chunk: string) =>
    chunk.split('\n').filter((line) => /^\s*```/.test(line)).length;

  it('returns nothing for empty text and one chunk for short text', () => {
    expect(splitMessage('')).toEqual([]);
    expect(splitMessage(' \n\n ')).toEqual([]);
    expect(splitMessage('hello\n')).toEqual(['hello']);
  });

  it('prefers blank lines, then line breaks, then a hard cut', () => {
    const a = 'a'.repeat(1000);
    const b = 'b'.repeat(1000);
    expect(splitMessage(`${a}\n\n${b}`)).toEqual([a, b]);
    expect(splitMessage(`${a}\n${b}`)).toEqual([a, b]);

    const lines = Array.from(
      { length: 80 },
      (_, i) => `line ${i} ${'x'.repeat(40)}`,
    );
    const byLine = splitMessage(lines.join('\n'));
    expect(byLine.length).toBeGreaterThan(1);
    expect(byLine.every((chunk) => chunk.length <= LIMIT)).toBe(true);
    expect(byLine.join('\n').split('\n')).toEqual(lines);

    const hard = splitMessage('z'.repeat(5000));
    expect(hard.map((chunk) => chunk.length)).toEqual([1900, 1900, 1200]);
  });

  it('prefers the last blank line within the limit', () => {
    const a = 'a'.repeat(900);
    const b = 'b'.repeat(800);
    const c = 'c'.repeat(500);
    expect(splitMessage(`${a}\n\n${b}\n\n${c}`)).toEqual([`${a}\n\n${b}`, c]);
  });

  it('does not cut a surrogate pair in half', () => {
    const chunks = splitMessage(`a${'😀'.repeat(2000)}`);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/[\ud800-\udbff]$/);
      expect(chunk).not.toMatch(/^[\udc00-\udfff]/);
    }
    expect(chunks.join('')).toBe(`a${'😀'.repeat(2000)}`);
  });

  it('keeps a fenced block that fits whole, cutting before it instead', () => {
    const intro = 'b'.repeat(1500);
    const code = `\`\`\`js\n${'const x = 1;\n'.repeat(60)}\`\`\``;
    const chunks = splitMessage(`${intro}\n${code}\nafter`);
    expect(chunks).toEqual([intro, `${code}\nafter`]);
  });

  it('splits a fence larger than the limit and reopens it each time', () => {
    const body = Array.from(
      { length: 300 },
      (_, i) => `row ${i} ${'y'.repeat(20)}`,
    );
    const text = `before\n\`\`\`py\n${body.join('\n')}\n\`\`\`\nafter`;
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(LIMIT);
      expect(fenceLines(chunk) % 2).toBe(0);
    }
    const codeChunks = chunks.filter((chunk) => chunk.includes('```py'));
    expect(codeChunks.length).toBe(chunks.length - 1);
    expect(
      codeChunks.slice(0, -1).every((chunk) => chunk.endsWith('\n```')),
    ).toBe(true);
    expect(chunks.at(-1)).toMatch(/```\nafter$/);
    const recovered = chunks.flatMap((chunk) =>
      chunk.split('\n').filter((line) => !line.startsWith('```')),
    );
    expect(recovered).toEqual(['before', ...body, 'after']);
  });

  it('closes and reopens a fence around a single over-long line', () => {
    const chunks = splitMessage(`\`\`\`\n${'q'.repeat(4500)}\n\`\`\``);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(LIMIT);
      expect(chunk.startsWith('```\n')).toBe(true);
      expect(chunk.endsWith('\n```')).toBe(true);
    }
    const content = chunks.map((chunk) => chunk.slice(4, -4)).join('');
    expect(content).toBe('q'.repeat(4500));
  });

  it('is never longer than the limit for mixed content', () => {
    const text = Array.from({ length: 40 }, (_, i) =>
      i % 3 === 0
        ? `\`\`\`ts\n${`const v${i} = ${i};\n`.repeat(30)}\`\`\``
        : `Paragraph ${i}. ${'word '.repeat(60)}`,
    ).join('\n\n');
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(LIMIT);
      expect(chunk.trim()).not.toBe('');
      expect(fenceLines(chunk) % 2).toBe(0);
    }
  });
});

describe('discordConfigFromEnv', () => {
  it('is disabled without a token', () => {
    expect(discordConfigFromEnv({})).toBeUndefined();
    expect(discordConfigFromEnv({ DISCORD_BOT_TOKEN: '  ' })).toBeUndefined();
    expect(
      discordConfigFromEnv({ DISCORD_OWNER_USER_ID: 'garbage' }),
    ).toBeUndefined();
  });

  it('reads the optional values', () => {
    expect(
      discordConfigFromEnv({
        DISCORD_BOT_TOKEN: ` ${TOKEN} `,
        DISCORD_OWNER_USER_ID: ` ${OWNER} `,
        DISCORD_DOT_ID: 'dot-9',
        PUBLIC_APP_URL: URL,
      }),
    ).toEqual({
      token: TOKEN,
      ownerUserId: OWNER,
      dotId: 'dot-9',
      publicUrl: URL,
    });
    expect(
      discordConfigFromEnv({
        DISCORD_BOT_TOKEN: TOKEN,
        DISCORD_OWNER_USER_ID: OWNER,
        DISCORD_DOT_ID: '',
        PUBLIC_APP_URL: ' ',
      }),
    ).toEqual({ token: TOKEN, ownerUserId: OWNER });
  });

  it('requires a numeric snowflake owner ID when the token is set', () => {
    const bad = [undefined, '', 'someone', '1234567890123456', '1'.repeat(21)];
    for (const owner of bad) {
      expect(() =>
        discordConfigFromEnv({
          DISCORD_BOT_TOKEN: TOKEN,
          DISCORD_OWNER_USER_ID: owner,
        }),
      ).toThrow(/DISCORD_OWNER_USER_ID/);
    }
    for (const owner of ['1'.repeat(17), '1'.repeat(20)]) {
      expect(
        discordConfigFromEnv({
          DISCORD_BOT_TOKEN: TOKEN,
          DISCORD_OWNER_USER_ID: owner,
        })?.ownerUserId,
      ).toBe(owner);
    }
  });

  it('never puts the token in an error message', () => {
    expect(() => discordConfigFromEnv({ DISCORD_BOT_TOKEN: TOKEN })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(TOKEN) }),
    );
  });
});
