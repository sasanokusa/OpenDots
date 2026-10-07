import type { DatabaseSync } from 'node:sqlite';

export interface SessionRow {
  thread_id: string;
  dot_id: string;
  session_id: string;
  updated_at: number;
}

/** Which sasacode session continues each OpenDots conversation. */
export class SasacodeSessions {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS sh_sasacode_sessions(
      thread_id TEXT PRIMARY KEY, dot_id TEXT NOT NULL, session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL);`);
  }

  get(threadId: string): SessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM sh_sasacode_sessions WHERE thread_id = ?')
      .get(threadId) as SessionRow | undefined;
  }

  save(entry: { threadId: string; dotId: string; sessionId: string }) {
    this.db
      .prepare(
        `INSERT INTO sh_sasacode_sessions (thread_id, dot_id, session_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET dot_id = excluded.dot_id,
           session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(entry.threadId, entry.dotId, entry.sessionId, this.now());
  }

  delete(threadId: string) {
    this.db
      .prepare('DELETE FROM sh_sasacode_sessions WHERE thread_id = ?')
      .run(threadId);
  }
}
