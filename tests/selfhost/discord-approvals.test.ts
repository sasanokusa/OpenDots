import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ButtonStyle } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
} from '../../src/selfhost/approvals/broker.js';
import {
  DiscordBridge,
  type DiscordBridgeOptions,
  type DiscordClientLike,
  type DiscordInteractionLike,
  type DiscordSentMessageLike,
  type DiscordUserLike,
} from '../../src/selfhost/discord/bridge.js';
import { SelfhostEvents } from '../../src/selfhost/threads/events.js';

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.secret-token-value';
const OWNER = '123456789012345678';
const OTHER = '987654321098765432';
const MINUTE = 60_000;

class FakeSentMessage implements DiscordSentMessageLike {
  edits: { content: string; components: unknown[] }[] = [];
  editError: Error | undefined;

  constructor(
    readonly content: string,
    readonly components: { toJSON(): unknown }[],
  ) {}

  edit(options: { content: string; components: [] }) {
    if (this.editError) return Promise.reject(this.editError);
    this.edits.push(options);
    return Promise.resolve();
  }

  /** The buttons as Discord receives them. */
  get buttons() {
    return this.components.flatMap(
      (row) =>
        (
          row.toJSON() as {
            components: {
              label: string;
              style: number;
              custom_id: string;
            }[];
          }
        ).components,
    );
  }
}

class FakeUser implements DiscordUserLike {
  sent: FakeSentMessage[] = [];
  sendError: Error | undefined;
  gate: Promise<void> | undefined;

  async send(options: {
    content: string;
    components: { toJSON(): unknown }[];
  }) {
    if (this.gate) await this.gate;
    if (this.sendError) throw this.sendError;
    const message = new FakeSentMessage(options.content, options.components);
    this.sent.push(message);
    return message;
  }

  createDM(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
}

class FakeClient extends EventEmitter implements DiscordClientLike {
  owner = new FakeUser();
  fetched: string[] = [];
  users = {
    fetch: (userId: string) => {
      this.fetched.push(userId);
      return Promise.resolve(this.owner);
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

// Handlers run detached from the emitter, so wait for the macrotask queue.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const request = (
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest => ({
  threadId: 'thread-1',
  dotId: 'dot-1',
  tool: 'bash',
  args: { command: 'rm -rf build' },
  reason: 'Deleting a build directory changes files.',
  ...overrides,
});

function setup(overrides: Partial<DiscordBridgeOptions> = {}) {
  const client = new FakeClient();
  const events = new SelfhostEvents();
  const broker = new ApprovalBroker(events);
  const bridge = new DiscordBridge({
    token: TOKEN,
    ownerUserId: OWNER,
    dotId: 'dot-1',
    db: new DatabaseSync(':memory:'),
    createThread: () => ({ id: 'unused' }),
    threadExists: () => true,
    turn: async () => 'reply',
    paused: () => false,
    approvals: broker,
    events,
    threadTitle: (id) => (id === 'thread-1' ? 'Cleaning the repo' : undefined),
    client,
    ...overrides,
  });

  /** Opens an approval and waits until the DM went out. */
  async function ask(overrides: Partial<ApprovalRequest> = {}) {
    const result = broker.request(request(overrides));
    await settle();
    const [approval] = broker.pending().slice(-1);
    return { result, id: approval!.id };
  }

  async function click(
    customId: string,
    options: {
      userId?: string;
      button?: boolean;
      message?: string;
      updateError?: Error;
    } = {},
  ) {
    const update = vi.fn(async (_options: { content: string }) => {
      if (options.updateError) throw options.updateError;
    });
    const interaction: DiscordInteractionLike = {
      user: { id: options.userId ?? OWNER },
      isButton: () => options.button ?? true,
      customId,
      message: { content: options.message ?? 'stale message text' },
      update,
    };
    client.emit('interactionCreate', interaction);
    await settle();
    return update;
  }

  return { client, events, broker, bridge, ask, click };
}

async function started(overrides: Partial<DiscordBridgeOptions> = {}) {
  const harness = setup(overrides);
  await harness.bridge.start();
  return harness;
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('approval requests', () => {
  it('DMs the owner a message with an allow and a deny button', async () => {
    const { client, ask } = await started();
    const { id } = await ask();

    expect(client.fetched).toEqual([OWNER]);
    expect(client.owner.sent).toHaveLength(1);
    const message = client.owner.sent[0]!;
    expect(message.buttons).toEqual([
      {
        type: 2,
        label: '許可',
        style: ButtonStyle.Success,
        custom_id: `opendots-approval:${id}:allow`,
      },
      {
        type: 2,
        label: '拒否',
        style: ButtonStyle.Danger,
        custom_id: `opendots-approval:${id}:deny`,
      },
    ]);
    // Both buttons share one action row.
    expect(message.components).toHaveLength(1);
  });

  it('shows the command, the reason, the conversation and the time limit', async () => {
    const { client, ask } = await started();
    await ask();
    const text = client.owner.sent[0]!.content;
    expect(text).toContain('確認が必要です');
    expect(text).toContain('```\nbash: rm -rf build\n```');
    expect(text).toContain('理由: Deleting a build directory changes files.');
    expect(text).toContain('会話: Cleaning the repo');
    expect(text).toContain('5分以内');
  });

  it('falls back to the thread id when the conversation has no title', async () => {
    const { client, ask } = await started();
    await ask({ threadId: 'scheduled-9' });
    expect(client.owner.sent[0]!.content).toContain('会話: scheduled-9');
  });

  it('sends requests from every conversation, not only Discord ones', async () => {
    const { client, ask } = await started();
    await ask({ threadId: 'thread-1' });
    await ask({ threadId: 'web-thread', tool: 'write_file' });
    expect(client.owner.sent).toHaveLength(2);
    expect(client.owner.sent[1]!.content).toContain('write_file');
  });

  it('cannot be tricked into closing the code block early', async () => {
    const { client, ask } = await started();
    await ask({
      args: { command: 'echo ```\n@everyone``` && `whoami`' },
      reason: 'line one\nline two',
    });
    const text = client.owner.sent[0]!.content;
    // Exactly one fenced block: the opening and the closing fence.
    const parts = text.split('```');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toContain('whoami');
    expect(parts[1]!.replaceAll('\u200b', '')).toContain(
      'echo ```\n@everyone``` && `whoami`',
    );
    expect(text).toContain('理由: line one line two');
  });

  it('keeps the message inside Discord’s length limit', async () => {
    const { client, ask } = await started();
    await ask({
      args: { command: 'x'.repeat(5000) },
      reason: 'y'.repeat(5000),
    });
    expect(client.owner.sent[0]!.content.length).toBeLessThan(1500);
  });

  it('sends requests that were already open when Discord became ready', async () => {
    const harness = setup();
    void harness.broker.request(request());
    expect(harness.client.owner.sent).toHaveLength(0);
    await harness.bridge.start();
    await settle();
    expect(harness.client.owner.sent).toHaveLength(1);
  });

  it('sends nothing without an approval broker and event source', async () => {
    const harness = await started({ approvals: undefined, events: undefined });
    void harness.broker.request(request());
    await settle();
    expect(harness.client.owner.sent).toEqual([]);
    expect(harness.events.size).toBe(0);
  });

  it('logs a failed DM by class only and leaves the web path working', async () => {
    const { client, broker, ask } = await started();
    client.owner.sendError = new Error(`Cannot send ${TOKEN}`);
    const { id } = await ask();
    expect(consoleError).toHaveBeenCalledWith(
      'Discord approval request failed:',
      'Error',
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(TOKEN);
    expect(broker.resolve(id, 'allow', 'web')).toBe(true);
  });
});

describe('answering from Discord', () => {
  it('lets the owner allow: the run continues and the message loses its buttons', async () => {
    const { client, ask, click } = await started();
    const { id, result } = await ask();
    const original = client.owner.sent[0]!.content;

    const update = await click(`opendots-approval:${id}:allow`);
    await expect(result).resolves.toEqual({ decision: 'allow' });
    expect(update).toHaveBeenCalledTimes(1);
    const body = update.mock.calls[0]![0] as {
      content: string;
      components: unknown[];
    };
    expect(body.components).toEqual([]);
    expect(body.content).toBe(`${original}\n\n→ 許可しました`);
    // The interaction answered the message; no second edit is needed.
    expect(client.owner.sent[0]!.edits).toEqual([]);
  });

  it('lets the owner deny, with feedback for the agent', async () => {
    const { ask, click } = await started();
    const { id, result } = await ask();
    const update = await click(`opendots-approval:${id}:deny`);
    const decision: ApprovalDecision = await result;
    expect(decision.decision).toBe('deny');
    expect(decision.feedback).toBeTruthy();
    expect(update.mock.calls[0]![0].content).toMatch(/→ 拒否しました$/);
  });

  it('ignores clicks from anyone but the owner', async () => {
    const { broker, ask, click } = await started();
    const { id } = await ask();
    const update = await click(`opendots-approval:${id}:allow`, {
      userId: OTHER,
    });
    expect(update).not.toHaveBeenCalled();
    expect(broker.pending()).toHaveLength(1);
  });

  it('ignores other buttons, other interactions and malformed ids', async () => {
    const { broker, ask, click } = await started();
    const { id } = await ask();
    const updates = [
      await click(`other-bot-feature:${id}:allow`),
      await click(`opendots-approval:${id}:maybe`),
      await click(`opendots-approval:${id}`),
      await click(`opendots-approval:${id}:allow`, { button: false }),
    ];
    for (const update of updates) expect(update).not.toHaveBeenCalled();
    expect(broker.pending()).toHaveLength(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('says the approval is closed when it was already answered', async () => {
    const { broker, ask, click } = await started();
    const { id } = await ask();
    expect(broker.resolve(id, 'deny', 'web')).toBe(true);
    const update = await click(`opendots-approval:${id}:allow`, {
      message: 'The old message',
    });
    expect(update).toHaveBeenCalledTimes(1);
    const body = update.mock.calls[0]![0] as {
      content: string;
      components: unknown[];
    };
    expect(body.content).toContain('この承認はすでに締め切られています');
    expect(body.components).toEqual([]);
  });

  it('says the approval is closed after it timed out', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { ask, click } = await started();
    const { id, result } = await ask();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    await expect(result).resolves.toMatchObject({ decision: 'deny' });
    const update = await click(`opendots-approval:${id}:allow`);
    expect(update.mock.calls[0]![0].content).toContain(
      'この承認はすでに締め切られています',
    );
  });

  it('answers an id nobody knows (for example after a restart) as closed', async () => {
    const { click } = await started();
    const update = await click('opendots-approval:gone:allow', {
      message: 'Survived the restart',
    });
    expect(update.mock.calls[0]![0].content).toBe(
      'Survived the restart\n\nこの承認はすでに締め切られています',
    );
  });

  it('lets only the first of two clicks decide', async () => {
    const { ask, click } = await started();
    const { id, result } = await ask();
    const first = await click(`opendots-approval:${id}:allow`);
    const second = await click(`opendots-approval:${id}:deny`);
    await expect(result).resolves.toEqual({ decision: 'allow' });
    expect(first.mock.calls[0]![0].content).toContain('→ 許可しました');
    expect(second.mock.calls[0]![0].content).toContain(
      'この承認はすでに締め切られています',
    );
  });

  it('logs a failing update by class only', async () => {
    const { broker, ask, click } = await started();
    const { id, result } = await ask();
    await click(`opendots-approval:${id}:allow`, {
      updateError: new Error(`Unknown interaction ${TOKEN}`),
    });
    // The decision stands even when Discord refused the message update.
    await expect(result).resolves.toEqual({ decision: 'allow' });
    expect(broker.pending()).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      'Discord interaction handling failed:',
      'Error',
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(TOKEN);
  });
});

describe('answering elsewhere', () => {
  const lastEdit = (message: FakeSentMessage) => message.edits.at(-1)!;

  it('takes the buttons away when the web app answers', async () => {
    const { client, broker, ask } = await started();
    const { id } = await ask();
    const message = client.owner.sent[0]!;

    broker.resolve(id, 'allow', 'web');
    await settle();
    expect(message.edits).toHaveLength(1);
    expect(lastEdit(message).components).toEqual([]);
    expect(lastEdit(message).content).toBe(
      `${message.content}\n\n→ Webで許可されました`,
    );
  });

  it('says so when the web app refused', async () => {
    const { client, broker, ask } = await started();
    const { id } = await ask();
    broker.resolve(id, 'deny', 'web');
    await settle();
    expect(lastEdit(client.owner.sent[0]!).content).toContain(
      '→ Webで拒否されました',
    );
  });

  it('says so when the request timed out', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { client, ask } = await started();
    await ask();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const message = client.owner.sent[0]!;
    expect(lastEdit(message).content).toContain('→ 時間切れで拒否しました');
    expect(lastEdit(message).components).toEqual([]);
  });

  it('says so when the run stopped', async () => {
    const { client, broker } = await started();
    const controller = new AbortController();
    void broker.request(request(), controller.signal);
    await settle();
    controller.abort();
    await settle();
    expect(lastEdit(client.owner.sent[0]!).content).toContain(
      '→ 実行が止まったため取り消しました',
    );
  });

  it('edits the message once the DM went out, even if the answer came first', async () => {
    const { client, broker } = await started();
    let release!: () => void;
    client.owner.gate = new Promise<void>((resolve) => (release = resolve));
    void broker.request(request());
    const [approval] = broker.pending();
    broker.resolve(approval!.id, 'allow', 'web');
    release();
    await settle();
    const message = client.owner.sent[0]!;
    expect(message.edits).toHaveLength(1);
    expect(lastEdit(message).content).toContain('Webで許可されました');
  });

  it('forgets the message after the first edit', async () => {
    const { client, broker, events, ask } = await started();
    const { id } = await ask();
    broker.resolve(id, 'allow', 'web');
    await settle();
    // A repeated event for the same id must not edit again.
    events.emit({
      type: 'approval_resolved',
      id,
      threadId: 'thread-1',
      decision: 'deny',
      by: 'timeout',
    });
    await settle();
    expect(client.owner.sent[0]!.edits).toHaveLength(1);
  });

  it('logs a failing edit by class only', async () => {
    const { client, broker, ask } = await started();
    const { id } = await ask();
    client.owner.sent[0]!.editError = new Error(`Missing Access ${TOKEN}`);
    broker.resolve(id, 'allow', 'web');
    await settle();
    expect(consoleError).toHaveBeenCalledWith(
      'Discord approval update failed:',
      'Error',
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(TOKEN);
  });
});

describe('lifecycle', () => {
  it('stops listening for approvals and buttons when stopped', async () => {
    const { client, events, bridge, broker, click } = await started();
    expect(events.size).toBe(1);
    expect(client.listenerCount('interactionCreate')).toBe(1);
    await bridge.stop();
    expect(events.size).toBe(0);
    expect(client.listenerCount('interactionCreate')).toBe(0);

    void broker.request(request());
    await settle();
    expect(client.owner.sent).toEqual([]);
    const [approval] = broker.pending();
    const update = await click(`opendots-approval:${approval!.id}:allow`);
    expect(update).not.toHaveBeenCalled();
    expect(broker.pending()).toHaveLength(1);
  });

  it('does not listen when start failed', async () => {
    const harness = setup();
    harness.client.login = () => Promise.reject(new Error(`bad ${TOKEN}`));
    await expect(harness.bridge.start()).rejects.toThrow(/login failed/i);
    expect(harness.events.size).toBe(0);
    expect(harness.client.listenerCount('interactionCreate')).toBe(0);
  });
});
