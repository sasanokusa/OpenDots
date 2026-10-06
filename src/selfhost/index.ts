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

export interface SelfhostBackend {
  readonly db: DatabaseSync;
  readonly runner: SelfhostAgentRunner;
  readonly threads: ThreadService;
  readonly events: SelfhostEvents;
  readonly pageThreads: PageIntelligence;
  readonly meter: UsageMeter;
  turn(
    agent: AbstractAgent,
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string>;
  close(): void;
}

export interface SelfhostBackendOptions {
  databasePath: string;
  workspace: WorkspaceStore;
  now?: () => number;
  usage?: Omit<UsageMeterOptions, 'now' | 'onRecord'>;
}

/** Conversation storage and bookkeeping that replace CopilotKit Intelligence. */
export function createSelfhostBackend({
  databasePath,
  workspace,
  now,
  usage,
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
  return {
    db,
    runner,
    threads,
    events,
    meter,
    pageThreads: pageThreads(threads, runner),
    turn: (agent, threadId, prompt, signal, metadata) =>
      runTurnInProcess(runner, agent, threadId, prompt, signal, metadata),
    close() {
      meter.close();
      db.close();
    },
  };
}
