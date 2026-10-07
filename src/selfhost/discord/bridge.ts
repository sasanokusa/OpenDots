import type { DatabaseSync } from 'node:sqlite';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { safeFailure } from '../../server/slack-channel.js';
import {
  japaneseReason,
  type ApprovalAnswer,
  type ApprovalBroker,
  type ApprovalChannel,
  type PendingApproval,
} from '../approvals/broker.js';
import type { SelfhostEvents } from '../threads/events.js';
import { splitMessage } from './format.js';

const THREAD_TITLE = 'Discord DM';
const READY_TIMEOUT_MS = 30_000;
const TYPING_INTERVAL_MS = 8_000;

const TEXT = {
  paused: 'OpenDotsは一時停止中です。再開するにはWebアプリで操作してください。',
  busy: '前のメッセージを処理中です。終わってからもう一度送ってください。',
  threadBusy:
    'この会話はいまWebで実行中です。終わってからもう一度送ってください。',
  failed: '処理中にエラーが起きました。少し待ってからもう一度送ってください。',
  empty: '返答が空でした。もう一度送ってみてください。',
  textOnly: 'テキストのメッセージだけ受け付けています。',
  newThread: '新しい会話を始めました。',
  noUrl: 'WebアプリのURLは未設定です（PUBLIC_APP_URL）。',
  help: [
    '使えるコマンド',
    '/new: 新しい会話を始める',
    '/web: Webアプリを開くURLを返す',
    '/help: この一覧を表示する',
    'それ以外のメッセージはそのままエージェントに渡します。',
  ].join('\n'),
  approvalTitle: '**確認が必要です**',
  approvalReason: '理由',
  approvalThread: '会話',
  approvalAllow: '許可',
  approvalDeny: '拒否',
  approved: '→ 許可しました',
  denied: '→ 拒否しました',
  closed: 'この承認はすでに締め切られています',
  webAllowed: '→ Webで許可されました',
  webDenied: '→ Webで拒否されました',
  timedOut: '→ 時間切れで拒否しました',
  cancelled: '→ 実行が止まったため取り消しました',
};

const APPROVAL_PREFIX = 'opendots-approval';
const APPROVAL_ID = new RegExp(`^${APPROVAL_PREFIX}:([^:]+):(allow|deny)$`);
const REASON_MAX = 300;
const TITLE_MAX = 100;

export interface DiscordChannelLike {
  type: number;
  send(text: string): Promise<unknown>;
  sendTyping(): Promise<unknown>;
}

export interface DiscordMessageLike {
  author: { id: string; bot: boolean };
  channelId: string;
  channel: DiscordChannelLike;
  content: string;
}

type ApprovalButtons = ActionRowBuilder<ButtonBuilder>;

/** A message the bot sent; approvals edit it once they are settled. */
export interface DiscordSentMessageLike {
  edit(options: { content: string; components: [] }): Promise<unknown>;
}

/** A Discord user the bot can open a DM with. */
export interface DiscordUserLike {
  send(options: {
    content: string;
    components: ApprovalButtons[];
  }): Promise<DiscordSentMessageLike>;
}

/** What the bridge reads from a discord.js `Interaction`. */
export interface DiscordInteractionLike {
  user: { id: string };
  isButton(): boolean;
  /** Only buttons carry these; check `isButton()` first. */
  customId: string;
  message?: { content: string };
  update(options: { content: string; components: [] }): Promise<unknown>;
}

/** The slice of discord.js `Client` the bridge relies on. */
export interface DiscordClientLike {
  on(
    event: 'messageCreate',
    listener: (message: DiscordMessageLike) => void,
  ): unknown;
  on(
    event: 'interactionCreate',
    listener: (interaction: DiscordInteractionLike) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'clientReady', listener: () => void): unknown;
  off(
    event: 'messageCreate',
    listener: (message: DiscordMessageLike) => void,
  ): unknown;
  off(
    event: 'interactionCreate',
    listener: (interaction: DiscordInteractionLike) => void,
  ): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'clientReady', listener: () => void): unknown;
  users: { fetch(userId: string): Promise<DiscordUserLike> };
  login(token: string): Promise<unknown>;
  destroy(): Promise<void> | void;
}

export interface DiscordBridgeOptions {
  token: string;
  /** Only this Discord user is served. */
  ownerUserId: string;
  /** Dot that answers DMs. */
  dotId: string;
  db: DatabaseSync;
  createThread: (dotId: string, title: string) => { id: string };
  threadExists: (threadId: string) => boolean;
  turn: (
    threadId: string,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<string>;
  paused: () => boolean;
  /** Web app URL, returned by `/web` and for approvals. */
  publicUrl?: string;
  /** With `events`, owner approvals are sent as DMs with buttons. */
  approvals?: ApprovalBroker;
  events?: SelfhostEvents;
  /** Title of a conversation, shown in approval DMs. */
  threadTitle?: (threadId: string) => string | undefined;
  client?: DiscordClientLike;
  now?: () => number;
}

interface InFlight {
  controller: AbortController;
  stopTyping: () => void;
}

interface SentApproval {
  message: DiscordSentMessageLike;
  content: string;
}

/** Keeps the text of a code block from ending it early. */
function codeSafe(text: string): string {
  // Discord closes a fenced block at the first run of three backticks, and a
  // backslash does not escape inside it. A zero-width space is invisible.
  return text.replace(/`/g, '`\u200b');
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function approvalButtons(id: string): ApprovalButtons {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPROVAL_PREFIX}:${id}:allow`)
      .setLabel(TEXT.approvalAllow)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${APPROVAL_PREFIX}:${id}:deny`)
      .setLabel(TEXT.approvalDeny)
      .setStyle(ButtonStyle.Danger),
  );
}

const outcomeText = (
  decision: ApprovalAnswer,
  by: Exclude<ApprovalChannel, 'discord'>,
): string => {
  if (by === 'timeout') return TEXT.timedOut;
  if (by === 'cancelled') return TEXT.cancelled;
  return decision === 'allow' ? TEXT.webAllowed : TEXT.webDenied;
};

function createDefaultClient(): DiscordClientLike {
  // DMs arrive without the privileged MessageContent intent.
  return new Client({
    intents: [GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  }) as unknown as DiscordClientLike;
}

export class DiscordBridge {
  private client: DiscordClientLike;
  private inFlight = new Map<string, InFlight>();
  /** Approval DMs by approval id; the send may still be in flight. */
  private approvalMessages = new Map<
    string,
    Promise<SentApproval | undefined>
  >();
  private unsubscribe: (() => void) | undefined;
  private started = false;
  private stopped = false;
  private now: () => number;

  constructor(private options: DiscordBridgeOptions) {
    this.client = options.client ?? createDefaultClient();
    this.now = options.now ?? Date.now;
    options.db.exec(`CREATE TABLE IF NOT EXISTS sh_discord_threads(
      channel_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL)`);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    const { client } = this;
    client.on('messageCreate', this.onMessage);
    client.on('interactionCreate', this.onInteraction);
    client.on('error', this.onError);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onReady: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Discord did not become ready within ${READY_TIMEOUT_MS / 1000} seconds.`,
              ),
            ),
          READY_TIMEOUT_MS,
        );
        onReady = resolve;
        client.once('clientReady', onReady);
        // The login error can carry request details; report only its class.
        client.login(this.options.token).catch((error: unknown) => {
          reject(new Error(`Discord login failed: ${safeFailure(error)}.`));
        });
      });
    } catch (error) {
      this.started = false;
      await this.teardown();
      throw error;
    } finally {
      clearTimeout(timer);
      if (onReady) client.off('clientReady', onReady);
    }
    if (!this.stopped) this.watchApprovals();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    for (const run of this.inFlight.values()) {
      run.stopTyping();
      run.controller.abort();
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.approvalMessages.clear();
    this.client.off('messageCreate', this.onMessage);
    this.client.off('interactionCreate', this.onInteraction);
    this.client.off('error', this.onError);
    try {
      await this.client.destroy();
    } catch (error) {
      console.error('Discord client shutdown failed:', safeFailure(error));
    }
  }

  /** Sends every approval request, from any conversation, to the owner's DM. */
  private watchApprovals() {
    const { approvals, events } = this.options;
    if (!approvals || !events || this.unsubscribe) return;
    this.unsubscribe = events.subscribe((event) => {
      if (event.type === 'approval_requested') this.announce(event.approval);
      else if (event.type === 'approval_resolved' && event.by !== 'discord')
        this.settled(event.id, event.decision, event.by);
      else if (event.type === 'approval_resolved')
        this.approvalMessages.delete(event.id);
    });
    // Requests opened before Discord was ready still need an answer.
    for (const approval of approvals.pending()) this.announce(approval);
  }

  private announce(approval: PendingApproval) {
    if (this.stopped || this.approvalMessages.has(approval.id)) return;
    const content = this.approvalText(approval);
    const sent = this.client.users
      .fetch(this.options.ownerUserId)
      .then((owner) =>
        owner.send({ content, components: [approvalButtons(approval.id)] }),
      )
      .then((message): SentApproval => ({ message, content }))
      .catch((error: unknown) => {
        console.error('Discord approval request failed:', safeFailure(error));
        this.approvalMessages.delete(approval.id);
        return undefined;
      });
    this.approvalMessages.set(approval.id, sent);
  }

  private approvalText(approval: PendingApproval): string {
    const title = this.options.threadTitle?.(approval.threadId);
    const minutes = Math.max(
      1,
      Math.round((approval.expiresAt - approval.createdAt) / 60_000),
    );
    const reason = oneLine(japaneseReason(approval.reason), REASON_MAX);
    return [
      TEXT.approvalTitle,
      '```',
      codeSafe(approval.summary),
      '```',
      ...(reason ? [`${TEXT.approvalReason}: ${reason}`] : []),
      `${TEXT.approvalThread}: ${oneLine(title || approval.threadId, TITLE_MAX)}`,
      `${minutes}分以内に答えがないと、自動で拒否されます。`,
    ].join('\n');
  }

  /** The request closed somewhere other than Discord: take the buttons away. */
  private settled(
    id: string,
    decision: ApprovalAnswer,
    by: Exclude<ApprovalChannel, 'discord'>,
  ) {
    const entry = this.approvalMessages.get(id);
    this.approvalMessages.delete(id);
    void entry
      ?.then((sent) =>
        sent?.message.edit({
          content: `${sent.content}\n\n${outcomeText(decision, by)}`,
          components: [],
        }),
      )
      .catch((error: unknown) => {
        console.error('Discord approval update failed:', safeFailure(error));
      });
  }

  private onInteraction = (interaction: DiscordInteractionLike) => {
    this.handleInteraction(interaction).catch((error: unknown) => {
      console.error('Discord interaction handling failed:', safeFailure(error));
    });
  };

  private async handleInteraction(
    interaction: DiscordInteractionLike,
  ): Promise<void> {
    const { approvals } = this.options;
    if (this.stopped || !approvals) return;
    if (interaction.user.id !== this.options.ownerUserId) return;
    if (!interaction.isButton()) return;
    const match = APPROVAL_ID.exec(interaction.customId);
    if (!match) return;
    const id = match[1]!;
    const decision = match[2] as ApprovalAnswer;

    // Resolving forgets the message, so look it up first.
    const stored = this.approvalMessages.get(id);
    const answered = approvals.resolve(id, decision, 'discord');
    const original =
      (await stored)?.content ?? interaction.message?.content ?? '';
    const outcome = answered
      ? decision === 'allow'
        ? TEXT.approved
        : TEXT.denied
      : TEXT.closed;
    await interaction.update({
      content: `${original}\n\n${outcome}`,
      components: [],
    });
  }

  private onError = (error: Error) => {
    console.error('Discord client error:', safeFailure(error));
  };

  private onMessage = (message: DiscordMessageLike) => {
    this.handle(message).catch((error: unknown) => {
      console.error('Discord message handling failed:', safeFailure(error));
    });
  };

  private async handle(message: DiscordMessageLike): Promise<void> {
    if (this.stopped) return;
    if (message.author.bot || message.author.id !== this.options.ownerUserId)
      return;
    if (message.channel.type !== ChannelType.DM) return;

    const { channel, channelId } = message;
    const text = message.content.trim();
    if (!text) {
      await this.reply(channel, TEXT.textOnly);
      return;
    }

    const command = text.split(/\s/, 1)[0]!.toLowerCase();
    if (command === '/help') return this.reply(channel, TEXT.help);
    if (command === '/web')
      return this.reply(channel, this.options.publicUrl ?? TEXT.noUrl);
    if (command === '/new') {
      try {
        this.createMapped(channelId);
      } catch (error) {
        console.error('Discord thread creation failed:', safeFailure(error));
        return this.reply(channel, TEXT.failed);
      }
      return this.reply(channel, TEXT.newThread);
    }

    if (this.options.paused()) return this.reply(channel, TEXT.paused);
    if (this.inFlight.has(channelId)) return this.reply(channel, TEXT.busy);
    await this.runTurn(channel, channelId, text);
  }

  private async runTurn(
    channel: DiscordChannelLike,
    channelId: string,
    prompt: string,
  ): Promise<void> {
    const controller = new AbortController();
    const typing = this.startTyping(channel);
    const run: InFlight = { controller, stopTyping: typing };
    this.inFlight.set(channelId, run);
    let answer: string | undefined;
    let failure: unknown;
    try {
      const threadId = this.threadFor(channelId);
      answer = await this.options.turn(threadId, prompt, controller.signal);
    } catch (error) {
      failure = error;
    } finally {
      typing();
      // A newer run for the same channel cannot exist while this one is listed.
      this.inFlight.delete(channelId);
    }
    if (controller.signal.aborted) return;

    if (failure !== undefined) {
      console.error('Discord turn failed:', safeFailure(failure));
      const lines = [
        failure instanceof Error && failure.message === 'Thread already running'
          ? TEXT.threadBusy
          : TEXT.failed,
      ];
      if (this.mentionsApproval(failure)) this.addApprovalLine(lines);
      return this.reply(channel, lines.join('\n\n'));
    }

    const lines = [answer?.trim() ? answer : TEXT.empty];
    if (answer?.includes('review_space_page')) this.addApprovalLine(lines);
    await this.reply(channel, lines.join('\n\n'));
  }

  private mentionsApproval(error: unknown): boolean {
    return error instanceof Error && /approv/i.test(error.message);
  }

  private addApprovalLine(lines: string[]) {
    const url = this.options.publicUrl;
    if (url) lines.push(`承認が必要な操作はWebで行ってください: ${url}`);
  }

  private startTyping(channel: DiscordChannelLike): () => void {
    const ping = () => {
      try {
        Promise.resolve(channel.sendTyping()).catch(() => undefined);
      } catch {
        // Typing is cosmetic; never let it break a turn.
      }
    };
    ping();
    const timer = setInterval(ping, TYPING_INTERVAL_MS);
    return () => clearInterval(timer);
  }

  private threadFor(channelId: string): string {
    const row = this.options.db
      .prepare('SELECT thread_id FROM sh_discord_threads WHERE channel_id = ?')
      .get(channelId) as { thread_id: string } | undefined;
    if (row && this.options.threadExists(row.thread_id)) return row.thread_id;
    return this.createMapped(channelId);
  }

  private createMapped(channelId: string): string {
    const { id } = this.options.createThread(this.options.dotId, THREAD_TITLE);
    this.options.db
      .prepare(
        `INSERT INTO sh_discord_threads(channel_id, thread_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           thread_id = excluded.thread_id, updated_at = excluded.updated_at`,
      )
      .run(channelId, id, this.now());
    return id;
  }

  private async reply(channel: DiscordChannelLike, text: string) {
    try {
      for (const chunk of splitMessage(text)) await channel.send(chunk);
    } catch (error) {
      console.error('Discord reply failed:', safeFailure(error));
    }
  }
}

export function discordConfigFromEnv(
  env: Record<string, string | undefined>,
):
  | { token: string; ownerUserId: string; dotId?: string; publicUrl?: string }
  | undefined {
  const token = env.DISCORD_BOT_TOKEN?.trim();
  if (!token) return undefined;
  const ownerUserId = env.DISCORD_OWNER_USER_ID?.trim() ?? '';
  if (!/^\d{17,20}$/.test(ownerUserId))
    throw new Error(
      'DISCORD_OWNER_USER_ID must be your numeric Discord user ID (17-20 digits) when DISCORD_BOT_TOKEN is set.',
    );
  const dotId = env.DISCORD_DOT_ID?.trim();
  const publicUrl = env.PUBLIC_APP_URL?.trim();
  return {
    token,
    ownerUserId,
    ...(dotId ? { dotId } : {}),
    ...(publicUrl ? { publicUrl } : {}),
  };
}
