import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AbstractAgent } from '@ag-ui/client';
import type { PageIntelligence } from '../server/page-service.js';
import type { WorkspaceStore } from '../server/workspace.js';
import { SelfhostAgentRunner } from './runner/sqlite-runner.js';
import { SelfhostEvents } from './threads/events.js';
import { ThreadService } from './threads/service.js';
import { pageThreads } from './threads/page-adapter.js';
import { runTurnInProcess } from './headless.js';
import { UsageMeter, type UsageMeterOptions } from './usage/meter.js';
import { DecisionLog } from './router/decision-log.js';
import { BacklogStore } from './backlog/store.js';
import { BacklogRunner } from './backlog/runner.js';
import { evaluatePolicy } from './usage/policy.js';
import { DiscordBridge, type DiscordClientLike } from './discord/bridge.js';
import { ApprovalBroker } from './approvals/broker.js';

export interface DiscordSettings {
  token: string;
  ownerUserId: string;
  dotId?: string;
  publicUrl?: string;
  /** Offer /plan and /escalate in the DM (MODEL_ROUTER=on). */
  routerCommands?: boolean;
  /** Test seam. */
  client?: DiscordClientLike;
}

/** What the self-host services need from the running upstream app. */
export interface SelfhostHost {
  /** `Platform.turn`: one server-initiated turn in an existing thread. */
  turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string>;
  /** Upstream Settings.paused. */
  paused(): boolean;
}

export interface Service {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface SelfhostBackend {
  readonly db: DatabaseSync;
  readonly runner: SelfhostAgentRunner;
  readonly threads: ThreadService;
  readonly events: SelfhostEvents;
  readonly pageThreads: PageIntelligence;
  readonly meter: UsageMeter;
  readonly decisions: DecisionLog;
  readonly workspace: WorkspaceStore;
  /** Owner approvals for sasacode tool calls (web and Discord). */
  readonly approvals: ApprovalBroker;
  backlog?: { store: BacklogStore; runner: BacklogRunner };
  discord?: DiscordBridge;
  /** Adds a service started by `start()` and stopped by `close()`. */
  use(service: Service): void;
  /** Creates background services; call once the Platform exists. */
  attach(host: SelfhostHost): void;
  /** Starts background services; call once the server listens. */
  start(): void;
  turn(
    agent: AbstractAgent,
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string>;
  close(): Promise<void>;
}

export interface SelfhostBackendOptions {
  databasePath: string;
  workspace: WorkspaceStore;
  now?: () => number;
  usage?: Omit<UsageMeterOptions, 'now' | 'onRecord'>;
  discord?: DiscordSettings;
}

/** Conversation storage and bookkeeping that replace CopilotKit Intelligence. */
export function createSelfhostBackend({
  databasePath,
  workspace,
  now,
  usage,
  discord,
}: SelfhostBackendOptions): SelfhostBackend {
  if (databasePath !== ':memory:')
    mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const events = new SelfhostEvents();
  const runner = new SelfhostAgentRunner(db, {
    now,
    onRunFinished: (run) => threads.noteRun(run),
  });
  const threads = new ThreadService(db, workspace, runner, events, { now });
  const meter = new UsageMeter(databasePath, {
    ...usage,
    now,
    onRecord: () => events.emit({ type: 'usage_updated' }),
  });
  const services: Service[] = [];
  const backend: SelfhostBackend = {
    db,
    runner,
    threads,
    events,
    meter,
    workspace,
    approvals: new ApprovalBroker(events, { now }),
    decisions: new DecisionLog(db, now),
    pageThreads: pageThreads(threads, runner),
    use(service) {
      services.push(service);
    },
    attach(host) {
      const store = new BacklogStore(db, now);
      const backlogRunner = new BacklogRunner({
        store,
        policy: () => evaluatePolicy(meter),
        turn: (threadId, prompt, signal, metadata) =>
          host.turn(threadId, prompt, signal, metadata),
        paused: () => host.paused(),
      });
      backend.backlog = { store, runner: backlogRunner };
      services.push(backlogRunner);
      if (discord) {
        const dotId = discord.dotId ?? workspace.dots()[0]?.id;
        if (!dotId || !workspace.dot(dotId))
          throw new Error('DISCORD_DOT_ID does not identify an existing Dot.');
        backend.discord = new DiscordBridge({
          token: discord.token,
          ownerUserId: discord.ownerUserId,
          dotId,
          db,
          publicUrl: discord.publicUrl,
          routerCommands: discord.routerCommands,
          approvals: backend.approvals,
          events,
          threadTitle: (threadId) =>
            workspace.conversations().find((thread) => thread.id === threadId)
              ?.title,
          client: discord.client,
          now,
          createThread: (id, title) => threads.create(id, title),
          threadExists: (threadId) =>
            workspace.conversations().some((thread) => thread.id === threadId),
          turn: (threadId, prompt, signal) =>
            host.turn(threadId, prompt, signal),
          paused: () => host.paused(),
        });
        services.push(backend.discord);
      }
    },
    start() {
      for (const service of services)
        void Promise.resolve()
          .then(() => service.start())
          .catch(() =>
            console.error('A self-host service failed to start; see setup.'),
          );
    },
    turn: (agent, threadId, prompt, signal, metadata) =>
      runTurnInProcess(runner, agent, threadId, prompt, signal, metadata),
    async close() {
      events.emit({ type: 'shutdown' });
      for (const service of services.splice(0).reverse())
        await Promise.resolve()
          .then(() => service.stop())
          .catch(() => undefined);
      meter.close();
      db.close();
    },
  };
  return backend;
}
