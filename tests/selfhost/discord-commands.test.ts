import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  MessageFlags,
} from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiscordBridge,
  slashCommands,
  type DiscordBridgeOptions,
  type DiscordChannelLike,
  type DiscordClientLike,
  type DiscordInteractionLike,
} from '../../src/selfhost/discord/bridge.js';

const OWNER = '123456789012345678';
const OTHER = '987654321098765432';

class FakeClient extends EventEmitter implements DiscordClientLike {
  registered: unknown[][] = [];
  registerError: Error | undefined;
  users = { fetch: () => Promise.reject(new Error('unused')) };
  application = {
    commands: {
      set: (commands: unknown[]) => {
        if (this.registerError) return Promise.reject(this.registerError);
        this.registered.push(commands);
        return Promise.resolve();
      },
    },
  };
  login() {
    queueMicrotask(() => this.emit('clientReady'));
    return Promise.resolve('ok');
  }
  destroy() {
    return Promise.resolve();
  }
}

class FakeChannel implements DiscordChannelLike {
  type = ChannelType.DM;
  sent: string[] = [];
  send(text: string) {
    this.sent.push(text);
    return Promise.resolve();
  }
  sendTyping() {
    return Promise.resolve();
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const bridges: DiscordBridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
});

async function setup(overrides: Partial<DiscordBridgeOptions> = {}) {
  const client = new FakeClient();
  const live = new Set<string>();
  let counter = 0;
  const createThread = vi.fn(() => {
    const id = `thread-${++counter}`;
    live.add(id);
    return { id };
  });
  let release: (() => void) | undefined;
  const turn = vi.fn(
    (_threadId: string, _prompt: string, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        release = () => resolve('done');
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  const bridge = new DiscordBridge({
    token: 'token',
    ownerUserId: OWNER,
    dotId: 'dot-1',
    db: new DatabaseSync(':memory:'),
    createThread,
    threadExists: (id) => live.has(id),
    turn,
    paused: () => false,
    publicUrl: 'https://opendots.example.test',
    client,
    ...overrides,
  });
  bridges.push(bridge);
  await bridge.start();
  const channel = new FakeChannel();

  async function command(
    name: string,
    options: { user?: string; request?: string } = {},
  ) {
    const replies: { content: string; flags?: number }[] = [];
    const interaction: DiscordInteractionLike = {
      user: { id: options.user ?? OWNER },
      isButton: () => false,
      customId: '',
      update: () => Promise.resolve(),
      isChatInputCommand: () => true,
      commandName: name,
      channelId: 'dm-1',
      channel,
      options: { getString: () => options.request ?? null },
      reply: (reply) => {
        replies.push(reply);
        return Promise.resolve();
      },
    };
    client.emit('interactionCreate', interaction);
    await settle();
    return replies;
  }

  // Text messages share the channel's in-flight state with slash commands.
  function message(content: string) {
    client.emit('messageCreate', {
      author: { id: OWNER, bot: false },
      channelId: 'dm-1',
      channel,
      content,
    });
  }

  return {
    client,
    channel,
    turn,
    createThread,
    command,
    message,
    release: () => release?.(),
  };
}

describe('slashCommands', () => {
  it('offers the basic commands only in the bot DM', () => {
    const commands = slashCommands(false);
    expect(commands.map((command) => command.name)).toEqual([
      'new',
      'stop',
      'web',
      'help',
    ]);
    for (const command of commands) {
      expect(command.contexts).toEqual([InteractionContextType.BotDM]);
      expect(command.integration_types).toEqual([
        ApplicationIntegrationType.GuildInstall,
      ]);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it('adds /plan and /escalate with a required request when the router is on', () => {
    const commands = slashCommands(true);
    const plan = commands.find((command) => command.name === 'plan');
    expect(commands.map((command) => command.name)).toContain('escalate');
    expect(plan?.options).toEqual([
      expect.objectContaining({ name: 'request', required: true }),
    ]);
  });
});

describe('Discord slash commands', () => {
  it('registers the commands once the client is ready', async () => {
    const { client } = await setup({ routerCommands: true });
    expect(client.registered).toHaveLength(1);
    expect(
      (client.registered[0] as { name: string }[]).map((c) => c.name),
    ).toContain('plan');
  });

  it('keeps running when registration fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new FakeClient();
    client.registerError = new Error('Missing Access');
    const bridge = new DiscordBridge({
      token: 'token',
      ownerUserId: OWNER,
      dotId: 'dot-1',
      db: new DatabaseSync(':memory:'),
      createThread: () => ({ id: 't' }),
      threadExists: () => true,
      turn: async () => 'ok',
      paused: () => false,
      client,
    });
    bridges.push(bridge);
    await expect(bridge.start()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'Discord slash command registration failed:',
      expect.any(String),
    );
    error.mockRestore();
  });

  it('answers /help, /web and /new', async () => {
    const { command, createThread } = await setup();
    expect((await command('help'))[0]!.content).toContain('/stop');
    expect((await command('web'))[0]!.content).toBe(
      'https://opendots.example.test',
    );
    expect((await command('new'))[0]!.content).toBe('新しい会話を始めました。');
    expect(createThread).toHaveBeenCalledTimes(1);
  });

  it('stops the running turn with /stop', async () => {
    const { command, message, turn } = await setup();
    expect((await command('stop'))[0]!.content).toBe(
      '実行中の処理はありません。',
    );
    message('長い作業をして');
    await settle();
    expect(turn).toHaveBeenCalledTimes(1);
    const signal = turn.mock.calls[0]![2];
    expect((await command('stop'))[0]!.content).toBe(
      '実行中の処理を止めました。',
    );
    expect(signal.aborted).toBe(true);
  });

  it('runs /plan as a turn after acknowledging it', async () => {
    const { command, turn, channel, release } = await setup({
      routerCommands: true,
    });
    const replies = await command('plan', { request: '旅行の計画を立てて' });
    expect(replies[0]!.content).toBe('受け付けました。');
    expect(turn.mock.calls[0]![1]).toBe('/plan 旅行の計画を立てて');
    release();
    await settle();
    expect(channel.sent).toEqual(['done']);
  });

  it('refuses everyone but the owner, privately', async () => {
    const { command, createThread } = await setup();
    const replies = await command('new', { user: OTHER });
    expect(replies).toEqual([
      {
        content: 'このボットはオーナー専用です。',
        flags: MessageFlags.Ephemeral,
      },
    ]);
    expect(createThread).not.toHaveBeenCalled();
  });

  it('accepts /stop typed as text too', async () => {
    const { message, channel } = await setup();
    message('/stop');
    await settle();
    expect(channel.sent).toEqual(['実行中の処理はありません。']);
  });
});
