import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ChannelType } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiscordBridge,
  type DiscordChannelLike,
  type DiscordClientLike,
} from '../../src/selfhost/discord/bridge.js';

const OWNER = '123456789012345678';

class FakeChannel implements DiscordChannelLike {
  id = 'dm-owner';
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

class FakeClient extends EventEmitter implements DiscordClientLike {
  channel = new FakeChannel();
  fetched: string[] = [];
  users = {
    fetch: (id: string) => {
      this.fetched.push(id);
      return Promise.resolve({
        send: () => Promise.reject(new Error('unused')),
        createDM: () => Promise.resolve(this.channel),
      });
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

const bridges: DiscordBridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
});

async function setup() {
  const client = new FakeClient();
  let release: ((text: string) => void) | undefined;
  const turn = vi.fn(
    (
      _threadId: string,
      _prompt: string,
      _signal: AbortSignal,
      _metadata?: Record<string, unknown>,
    ) =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const bridge = new DiscordBridge({
    token: 'token',
    ownerUserId: OWNER,
    dotId: 'dot-1',
    db: new DatabaseSync(':memory:'),
    createThread: () => ({ id: 'thread-1' }),
    threadExists: () => true,
    turn,
    paused: () => false,
    client,
  });
  bridges.push(bridge);
  return { bridge, client, turn, release: (text: string) => release?.(text) };
}

describe('DiscordBridge.proactive', () => {
  it('does nothing before Discord is ready', async () => {
    const { bridge, turn } = await setup();
    expect(await bridge.proactive('朝のまとめをお願いします。')).toBe(
      'unavailable',
    );
    expect(turn).not.toHaveBeenCalled();
  });

  it('runs a scheduled turn in the owner DM and posts the reply there', async () => {
    const { bridge, client, turn, release } = await setup();
    await bridge.start();
    const sent = bridge.proactive('朝のまとめをお願いします。');
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1));
    expect(client.fetched).toEqual([OWNER]);
    const [threadId, prompt, , metadata] = turn.mock.calls[0]!;
    expect(threadId).toBe('thread-1');
    expect(prompt).toBe('朝のまとめをお願いします。');
    expect(metadata).toEqual({ opendotsSource: 'scheduled_task' });
    // A second brief while the first is still running is skipped.
    expect(await bridge.proactive('もう一度')).toBe('busy');
    release('今日やること: 1. レポート');
    expect(await sent).toBe('sent');
    expect(client.channel.sent).toEqual(['今日やること: 1. レポート']);
  });
});
