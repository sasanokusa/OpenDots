import type { DatabaseSync } from 'node:sqlite';
import type { RouteDecision } from './jev.js';

export interface DecisionRow {
  id: number;
  created_at: number;
  thread_id: string;
  run_id: string;
  questions_version: string;
  input_excerpt: string;
  jev_choice: string | null;
  jev_probabilities: string | null;
  jev_high_impact: number | null;
  jev_latency_ms: number | null;
  jev_error: string | null;
  final_role: string;
  reason: string;
  handed_over: number;
}

/** Every routing decision, kept for the weekly threshold review. */
export class DecisionLog {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS sh_route_decisions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
      thread_id TEXT NOT NULL, run_id TEXT NOT NULL, questions_version TEXT NOT NULL,
      input_excerpt TEXT NOT NULL,
      jev_choice TEXT, jev_probabilities TEXT, jev_high_impact REAL,
      jev_latency_ms INTEGER, jev_error TEXT,
      final_role TEXT NOT NULL, reason TEXT NOT NULL,
      handed_over INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS sh_route_decisions_run ON sh_route_decisions(run_id);`);
  }

  record(entry: {
    threadId: string;
    runId: string;
    version: string;
    text: string;
    decision: RouteDecision;
  }) {
    const jev = entry.decision.jev;
    this.db
      .prepare(
        `INSERT INTO sh_route_decisions (created_at, thread_id, run_id, questions_version, input_excerpt,
          jev_choice, jev_probabilities, jev_high_impact, jev_latency_ms, jev_error, final_role, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(),
        entry.threadId,
        entry.runId,
        entry.version,
        entry.text.slice(0, 500),
        jev?.choice ?? null,
        jev?.probabilities ? JSON.stringify(jev.probabilities) : null,
        jev?.highImpact ?? null,
        jev?.latencyMs ?? null,
        jev?.error ?? null,
        entry.decision.role,
        entry.decision.reason,
      );
  }

  markHandover(runId: string) {
    this.db
      .prepare('UPDATE sh_route_decisions SET handed_over=1 WHERE run_id=?')
      .run(runId);
  }

  recent(limit = 100): DecisionRow[] {
    return this.db
      .prepare('SELECT * FROM sh_route_decisions ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as DecisionRow[];
  }
}
