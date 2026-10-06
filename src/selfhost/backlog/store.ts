import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type BacklogStatus =
  'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BacklogItem {
  id: string;
  threadId: string;
  prompt: string;
  status: BacklogStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  result: string | null;
  error: string | null;
}

interface BacklogRow {
  id: string;
  thread_id: string;
  prompt: string;
  status: BacklogStatus;
  attempts: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  result: string | null;
  error: string | null;
}

export const RESULT_MAX_CHARS = 20_000;
export const ERROR_MAX_CHARS = 500;
const LIST_LIMIT = 200;

const toItem = (row: BacklogRow): BacklogItem => ({
  id: row.id,
  threadId: row.thread_id,
  prompt: row.prompt,
  status: row.status,
  attempts: row.attempts,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  result: row.result,
  error: row.error,
});

/**
 * Non-urgent heavy tasks the owner queued for the nightly window. Every state
 * change is one guarded UPDATE so a stale caller can never overwrite a newer
 * status.
 */
export class BacklogStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS sh_backlog(
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER, result TEXT, error TEXT)`);
  }

  add(threadId: string, prompt: string): BacklogItem {
    const id = randomUUID();
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO sh_backlog (id, thread_id, prompt, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
      )
      .run(id, threadId, prompt, at, at);
    return this.get(id)!;
  }

  /** Queued items first (oldest first), then everything else, most recently touched first. */
  list(): BacklogItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sh_backlog
         ORDER BY (status = 'queued') DESC,
           CASE WHEN status = 'queued' THEN created_at END ASC,
           updated_at DESC, created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(LIST_LIMIT) as unknown as BacklogRow[];
    return rows.map(toItem);
  }

  get(id: string): BacklogItem | undefined {
    const row = this.db
      .prepare('SELECT * FROM sh_backlog WHERE id = ?')
      .get(id) as unknown as BacklogRow | undefined;
    return row && toItem(row);
  }

  cancel(id: string): BacklogItem | undefined {
    const at = this.now();
    return this.update(
      `UPDATE sh_backlog SET status='cancelled', updated_at=?, finished_at=?
       WHERE id=? AND status='queued' RETURNING *`,
      at,
      at,
      id,
    );
  }

  requeue(id: string): BacklogItem | undefined {
    return this.update(
      `UPDATE sh_backlog SET status='queued', updated_at=?, started_at=NULL,
         finished_at=NULL, result=NULL, error=NULL
       WHERE id=? AND status IN ('failed', 'cancelled') RETURNING *`,
      this.now(),
      id,
    );
  }

  /** Oldest queued item to running. Returns undefined when nothing is queued. */
  claimNext(): BacklogItem | undefined {
    const at = this.now();
    return this.update(
      `UPDATE sh_backlog SET status='running', attempts=attempts+1,
         started_at=?, updated_at=?, finished_at=NULL
       WHERE status='queued' AND id = (
         SELECT id FROM sh_backlog WHERE status='queued'
         ORDER BY created_at ASC, rowid ASC LIMIT 1
       ) RETURNING *`,
      at,
      at,
    );
  }

  /** Claims one specific item; undefined when it is not queued. */
  claim(id: string): BacklogItem | undefined {
    const at = this.now();
    return this.update(
      `UPDATE sh_backlog SET status='running', attempts=attempts+1,
         started_at=?, updated_at=?, finished_at=NULL
       WHERE id=? AND status='queued' RETURNING *`,
      at,
      at,
      id,
    );
  }

  /** Only a running item can finish; a late result after stop() or recovery is dropped. */
  finish(id: string, result: string): BacklogItem | undefined {
    const at = this.now();
    return this.update(
      `UPDATE sh_backlog SET status='done', result=?, error=NULL,
         updated_at=?, finished_at=?
       WHERE id=? AND status='running' RETURNING *`,
      result.slice(0, RESULT_MAX_CHARS),
      at,
      at,
      id,
    );
  }

  fail(id: string, error: string): BacklogItem | undefined {
    const at = this.now();
    return this.update(
      `UPDATE sh_backlog SET status='failed', error=?, updated_at=?, finished_at=?
       WHERE id=? AND status='running' RETURNING *`,
      error.slice(0, ERROR_MAX_CHARS),
      at,
      at,
      id,
    );
  }

  /** Startup only: a row still running belongs to a process that no longer exists. */
  recoverInterrupted(): number {
    return Number(
      this.db
        .prepare(
          `UPDATE sh_backlog SET status='queued', updated_at=?, started_at=NULL
           WHERE status='running'`,
        )
        .run(this.now()).changes,
    );
  }

  private update(
    sql: string,
    ...params: (string | number)[]
  ): BacklogItem | undefined {
    const row = this.db.prepare(sql).get(...params) as unknown as
      BacklogRow | undefined;
    return row && toItem(row);
  }
}
