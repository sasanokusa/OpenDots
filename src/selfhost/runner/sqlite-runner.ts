import type { DatabaseSync } from 'node:sqlite';
import {
  AgentRunner,
  finalizeRunEvents,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type LocalThreadEndpointRecord,
  type LocalThreadEndpointRunner,
} from '@copilotkit/runtime/v2';
import {
  EventType,
  compactEvents,
  type AbstractAgent,
  type BaseEvent,
  type Message,
  type RunStartedEvent,
} from '@ag-ui/client';
import { Observable, ReplaySubject } from 'rxjs';

export interface RunFinished {
  threadId: string;
  runId: string;
  agentId: string;
  /** True when the agent threw or the owner stopped the run. */
  interrupted: boolean;
  at: number;
}

export interface SelfhostRunnerOptions {
  /** Thread records for `GET /threads`; ThreadService owns names and archive state. */
  directory?: () => LocalThreadEndpointRecord[];
  onRunFinished?: (run: RunFinished) => void;
  now?: () => number;
}

interface ActiveRun {
  runId: string;
  agent: AbstractAgent;
  events: BaseEvent[];
  subject: ReplaySubject<BaseEvent>;
  stopRequested: boolean;
}

interface RunRow {
  events: string;
  messages: string;
}

const messageIdOf = (event: BaseEvent) =>
  'messageId' in event && typeof event.messageId === 'string'
    ? event.messageId
    : undefined;

/**
 * Persists AG-UI runs in SQLite, following @copilotkit/sqlite-runner but on
 * node:sqlite, with the local thread endpoints the runtime needs for
 * `GET /threads` when Intelligence is absent. Active runs live in memory, so a
 * crash never leaves a thread marked as running after restart.
 */
export class SelfhostAgentRunner
  extends AgentRunner
  implements LocalThreadEndpointRunner
{
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private active = new Map<string, ActiveRun>();
  private now: () => number;

  constructor(
    private db: DatabaseSync,
    private options: SelfhostRunnerOptions = {},
  ) {
    super();
    this.now = options.now ?? Date.now;
    db.exec(`CREATE TABLE IF NOT EXISTS sh_agent_runs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, parent_run_id TEXT,
        agent_id TEXT NOT NULL, events TEXT NOT NULL, messages TEXT NOT NULL,
        input TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sh_agent_runs_thread ON sh_agent_runs(thread_id, id);`);
  }

  setDirectory(directory: () => LocalThreadEndpointRecord[]) {
    this.options.directory = directory;
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId, agent, input } = request;
    if (this.active.has(threadId)) throw new Error('Thread already running');
    const historicIds = new Set(
      this.getThreadMessages(threadId).map((message) => message.id),
    );
    const parentRunId = this.latestRunId(threadId);
    const run: ActiveRun = {
      runId: input.runId,
      agent,
      events: [],
      subject: new ReplaySubject<BaseEvent>(Infinity),
      stopRequested: false,
    };
    this.active.set(threadId, run);
    const emit = (event: BaseEvent) => {
      run.subject.next(event);
      run.events.push(event);
    };
    const finish = (interruptionMessage?: string) => {
      for (const event of finalizeRunEvents(run.events, {
        stopRequested: run.stopRequested,
        ...(interruptionMessage !== undefined ? { interruptionMessage } : {}),
      }))
        emit(event);
      let stored = false;
      if (run.events.length) {
        try {
          this.storeRun(threadId, run, input, parentRunId);
          stored = true;
        } catch (error) {
          console.error(
            'Self-host runner could not persist a run:',
            error instanceof Error ? error.name : 'Error',
          );
        }
      }
      this.active.delete(threadId);
      run.subject.complete();
      if (stored)
        this.options.onRunFinished?.({
          threadId,
          runId: input.runId,
          agentId: agent.agentId ?? 'default',
          interrupted: interruptionMessage !== undefined || run.stopRequested,
          at: this.now(),
        });
    };
    void (async () => {
      try {
        await agent.runAgent(input, {
          onEvent: ({ event }) => {
            if (event.type === EventType.RUN_STARTED) {
              const started = event as RunStartedEvent;
              if (!started.input)
                event = {
                  ...started,
                  input: {
                    ...input,
                    messages: input.messages.filter(
                      (message) => !historicIds.has(message.id),
                    ),
                  },
                } as RunStartedEvent;
            }
            emit(event);
          },
        });
        finish();
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error));
      }
    })();
    return run.subject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const connection = new ReplaySubject<BaseEvent>(Infinity);
    const emitted = new Set<string>();
    for (const event of this.getThreadEvents(request.threadId)) {
      connection.next(event);
      const id = messageIdOf(event);
      if (id) emitted.add(id);
    }
    const run = this.active.get(request.threadId);
    if (run)
      run.subject.subscribe({
        next: (event) => {
          const id = messageIdOf(event);
          if (!id || !emitted.has(id)) connection.next(event);
        },
        error: (error) => connection.error(error),
        complete: () => connection.complete(),
      });
    else connection.complete();
    return connection.asObservable();
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return Promise.resolve(this.active.has(request.threadId));
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const run = this.active.get(request.threadId);
    if (
      !run ||
      run.stopRequested ||
      (request.runId !== undefined && request.runId !== run.runId)
    )
      return Promise.resolve(false);
    run.stopRequested = true;
    try {
      run.agent.abortRun();
      return Promise.resolve(true);
    } catch {
      run.stopRequested = false;
      return Promise.resolve(false);
    }
  }

  listThreads(): LocalThreadEndpointRecord[] {
    if (this.options.directory) return this.options.directory();
    const rows = this.db
      .prepare(
        'SELECT thread_id, agent_id, MIN(created_at) AS created, MAX(created_at) AS updated FROM sh_agent_runs GROUP BY thread_id ORDER BY updated DESC',
      )
      .all() as {
      thread_id: string;
      agent_id: string;
      created: number;
      updated: number;
    }[];
    return rows.map((row) => ({
      id: row.thread_id,
      name: null,
      agentId: row.agent_id,
      organizationId: '',
      createdById: '',
      archived: false,
      createdAt: new Date(row.created).toISOString(),
      updatedAt: new Date(row.updated).toISOString(),
    }));
  }

  /** Messages as of the end of the latest stored run. */
  getThreadMessages(threadId: string): Message[] {
    const row = this.db
      .prepare(
        'SELECT messages FROM sh_agent_runs WHERE thread_id=? ORDER BY id DESC LIMIT 1',
      )
      .get(threadId) as Pick<RunRow, 'messages'> | undefined;
    return row ? (JSON.parse(row.messages) as Message[]) : [];
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    const rows = this.db
      .prepare('SELECT events FROM sh_agent_runs WHERE thread_id=? ORDER BY id')
      .all(threadId) as Pick<RunRow, 'events'>[];
    if (!rows.length) return [];
    return compactEvents(
      rows.flatMap((row) => JSON.parse(row.events) as BaseEvent[]),
    );
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    const events = this.getThreadEvents(threadId);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event.type !== EventType.STATE_SNAPSHOT) continue;
      const snapshot = (event as { snapshot?: unknown }).snapshot;
      return snapshot &&
        typeof snapshot === 'object' &&
        !Array.isArray(snapshot)
        ? { ...(snapshot as Record<string, unknown>) }
        : null;
    }
    return null;
  }

  /** Persistent history is never wiped from a client request. */
  clearThreads(): void {}

  lastRunAt(threadId: string): number | undefined {
    const row = this.db
      .prepare(
        'SELECT created_at FROM sh_agent_runs WHERE thread_id=? ORDER BY id DESC LIMIT 1',
      )
      .get(threadId) as { created_at: number } | undefined;
    return row?.created_at;
  }

  deleteThread(threadId: string) {
    if (this.active.has(threadId))
      throw new Error('Stop the running turn before removing its history.');
    this.db
      .prepare('DELETE FROM sh_agent_runs WHERE thread_id=?')
      .run(threadId);
  }

  private latestRunId(threadId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT run_id FROM sh_agent_runs WHERE thread_id=? ORDER BY id DESC LIMIT 1',
      )
      .get(threadId) as { run_id: string } | undefined;
    return row?.run_id ?? null;
  }

  private storeRun(
    threadId: string,
    run: ActiveRun,
    input: AgentRunnerRunRequest['input'],
    parentRunId: string | null,
  ) {
    const messages = Array.isArray(run.agent.messages)
      ? run.agent.messages
      : input.messages;
    this.db
      .prepare(
        'INSERT INTO sh_agent_runs (thread_id, run_id, parent_run_id, agent_id, events, messages, input, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        threadId,
        run.runId,
        parentRunId,
        run.agent.agentId ?? 'default',
        JSON.stringify(compactEvents(run.events)),
        JSON.stringify(messages),
        JSON.stringify(input),
        this.now(),
      );
  }
}
