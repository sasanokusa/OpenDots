import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  limits,
  policy,
  prices as defaultPrices,
  roles,
  type ModelPrice,
  type RoleName,
} from '../config/models.js';
import type { UsageRecord, UsageRecorder } from '../types.js';
import {
  SESSION_WINDOWS,
  monthStart,
  nextMonthStart,
  sessionStart,
  type SessionWindow,
} from './windows.js';

export interface WindowUsage {
  usedUSD: number;
  limitUSD: number;
  ratio: number;
  /** Window start; equals `at` when no window is open. */
  since: number;
  /** When the open window resets; null when no window is open. */
  resetsAt: number | null;
  /** Spend outside OpenDots, learned from an owner observation. */
  externalUSD: number;
}

export type WindowName = SessionWindow | 'month';

/** What CommandCode's own usage page showed at one moment. */
export interface UsageObservation {
  window: WindowName;
  /** null: the page said no window was open. */
  windowStart: number | null;
  usedUSD: number;
  observedAt: number;
  /** OpenDots' own spend in that window at `observedAt`. */
  localUSD: number;
}

export interface RoleUsage {
  weekUSD: number;
  monthUSD: number;
  fiveHourUSD: number;
  monthlyCapUSD?: number;
  weeklyTargetUSD?: number;
}

export interface UsageSummary {
  at: number;
  windows: { fiveHour: WindowUsage; week: WindowUsage; month: WindowUsage };
  byRole: Record<RoleName, RoleUsage>;
  pace: {
    dayOfMonth: number;
    idealToDateUSD: number;
    monthUSD: number;
    diffUSD: number;
  };
}

export interface StoredUsage extends UsageRecord {
  id: number;
  costUSD: number;
}

export interface UsageMeterOptions {
  now?: () => number;
  prices?: Record<string, ModelPrice>;
  monthStartDay?: number;
  onRecord?: (row: StoredUsage) => void;
}

export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const roleNames = Object.keys(roles) as RoleName[];
const windowLimits: Record<WindowName, number> = {
  fiveHour: limits.fiveHourUSD,
  week: limits.weekUSD,
  month: limits.monthUSD,
};
/** Without an observation, look this far back for the 5-hour chain: long
 * enough to contain a 5-hour gap (sleep), which realigns the chain exactly. */
const FIVE_HOUR_LOOKBACK_MS = 48 * 3600_000;

export class UsageMeter implements UsageRecorder {
  private db: DatabaseSync;
  private now: () => number;
  private prices: Record<string, ModelPrice>;
  private monthStartDay: number;
  private onRecord?: (row: StoredUsage) => void;

  constructor(path: string, options: UsageMeterOptions = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sh_usage(
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        role TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL,
        thread_id TEXT, run_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0, status INTEGER NOT NULL, error_type TEXT);
      CREATE INDEX IF NOT EXISTS sh_usage_at ON sh_usage(at);
      CREATE TABLE IF NOT EXISTS sh_calibration(
        model TEXT PRIMARY KEY, factor REAL NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sh_usage_observed(
        window TEXT PRIMARY KEY, window_start INTEGER, used_usd REAL NOT NULL,
        observed_at INTEGER NOT NULL, local_usd REAL NOT NULL);`);
    this.now = options.now ?? (() => Date.now());
    this.prices = options.prices ?? defaultPrices;
    this.monthStartDay = options.monthStartDay ?? 1;
    this.onRecord = options.onRecord;
  }

  record(record: UsageRecord): StoredUsage {
    const costUSD = this.cost(record.model, record);
    const result = this.db
      .prepare(
        `INSERT INTO sh_usage(at, role, model, endpoint, thread_id, run_id,
          input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
          cost_usd, status, error_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.at,
        record.role,
        record.model,
        record.endpoint,
        record.threadId ?? null,
        record.runId ?? null,
        record.inputTokens,
        record.cachedInputTokens,
        record.outputTokens,
        record.reasoningTokens,
        costUSD,
        record.status,
        record.errorType ?? null,
      );
    const row: StoredUsage = {
      ...record,
      id: Number(result.lastInsertRowid),
      costUSD,
    };
    try {
      this.onRecord?.(row);
    } catch {
      // A failing listener must not turn a recorded call into a failed one.
    }
    return row;
  }

  cost(model: string, tokens: TokenCounts): number {
    const price = this.prices[model];
    if (!price) return 0;
    const cached = tokens.cachedInputTokens;
    const fresh = Math.max(0, tokens.inputTokens - cached);
    const base =
      (fresh * price.inputPerM +
        cached * (price.cacheReadPerM ?? price.inputPerM) +
        tokens.outputTokens * price.outputPerM) /
      1e6;
    const row = this.db
      .prepare('SELECT factor FROM sh_calibration WHERE model = ?')
      .get(model) as { factor: number } | undefined;
    return base * (row?.factor ?? 1);
  }

  setCalibration(model: string, factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error(
        `calibration factor must be a positive number: ${factor}`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO sh_calibration(model, factor, updated_at) VALUES (?,?,?)
         ON CONFLICT(model) DO UPDATE SET factor=excluded.factor, updated_at=excluded.updated_at`,
      )
      .run(model, factor, this.now());
  }

  calibration(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT model, factor FROM sh_calibration')
      .all() as { model: string; factor: number }[];
    return Object.fromEntries(rows.map((row) => [row.model, row.factor]));
  }

  totalUSD(
    from: number,
    to: number,
    filter: { role?: RoleName; model?: string } = {},
  ): number {
    const where = ['at >= ?', 'at <= ?'];
    const args: (string | number)[] = [from, to];
    if (filter.role) {
      where.push('role = ?');
      args.push(filter.role);
    }
    if (filter.model) {
      where.push('model = ?');
      args.push(filter.model);
    }
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM sh_usage WHERE ${where.join(' AND ')}`,
      )
      .get(...args) as { total: number };
    return row.total;
  }

  statusTimes(role: RoleName, status: number, since: number): number[] {
    const rows = this.db
      .prepare(
        'SELECT at FROM sh_usage WHERE role = ? AND status = ? AND at >= ? ORDER BY at ASC, id ASC',
      )
      .all(role, status, since) as { at: number }[];
    return rows.map((row) => row.at);
  }

  /** Record what CommandCode's usage page shows, to include outside spend. */
  observe(
    window: WindowName,
    observation: { usedUSD: number; windowStart: number | null },
    at: number = this.now(),
  ): UsageObservation {
    if (!Number.isFinite(observation.usedUSD) || observation.usedUSD < 0)
      throw new Error('usedUSD must be a non-negative number.');
    const windowStart =
      window === 'month'
        ? monthStart(at, this.monthStartDay)
        : observation.windowStart;
    if (windowStart !== null && windowStart > at)
      throw new Error('The window cannot start after the observation.');
    const localUSD = windowStart === null ? 0 : this.totalUSD(windowStart, at);
    this.db
      .prepare(
        `INSERT INTO sh_usage_observed(window, window_start, used_usd, observed_at, local_usd)
         VALUES (?,?,?,?,?) ON CONFLICT(window) DO UPDATE SET window_start=excluded.window_start,
         used_usd=excluded.used_usd, observed_at=excluded.observed_at, local_usd=excluded.local_usd`,
      )
      .run(window, windowStart, observation.usedUSD, at, localUSD);
    return {
      window,
      windowStart,
      usedUSD: observation.usedUSD,
      observedAt: at,
      localUSD,
    };
  }

  observations(): UsageObservation[] {
    const rows = this.db.prepare('SELECT * FROM sh_usage_observed').all() as {
      window: WindowName;
      window_start: number | null;
      used_usd: number;
      observed_at: number;
      local_usd: number;
    }[];
    return rows.map((row) => ({
      window: row.window,
      windowStart: row.window_start,
      usedUSD: row.used_usd,
      observedAt: row.observed_at,
      localUSD: row.local_usd,
    }));
  }

  private firstRequestAt(from: number, to: number): number | undefined {
    const row = this.db
      .prepare(
        'SELECT MIN(at) AS at FROM sh_usage WHERE at >= ? AND at <= ? AND status >= 200 AND status < 300',
      )
      .get(from, to) as { at: number | null };
    return row.at ?? undefined;
  }

  private sessionWindowStart(
    window: SessionWindow,
    now: number,
    observed?: UsageObservation,
  ): number | undefined {
    const length = SESSION_WINDOWS[window];
    const first = (from: number) => this.firstRequestAt(from, now);
    if (observed && observed.observedAt <= now)
      return observed.windowStart === null
        ? sessionStart(length, now, observed.observedAt, first)
        : sessionStart(
            length,
            now,
            observed.windowStart,
            first,
            observed.windowStart,
          );
    return sessionStart(
      length,
      now,
      window === 'fiveHour' ? now - FIVE_HOUR_LOOKBACK_MS : 0,
      first,
    );
  }

  summary(now: number = this.now()): UsageSummary {
    const observed = new Map(
      this.observations().map((item) => [item.window, item]),
    );
    const monthSince = monthStart(now, this.monthStartDay);
    const since: Record<WindowName, number | undefined> = {
      fiveHour: this.sessionWindowStart(
        'fiveHour',
        now,
        observed.get('fiveHour'),
      ),
      week: this.sessionWindowStart('week', now, observed.get('week')),
      month: monthSince,
    };
    const windowUsage = (window: WindowName): WindowUsage => {
      const limitUSD = windowLimits[window];
      const start = since[window];
      if (start === undefined)
        return {
          usedUSD: 0,
          limitUSD,
          ratio: 0,
          since: now,
          resetsAt: null,
          externalUSD: 0,
        };
      const seen = observed.get(window);
      const externalUSD =
        seen && seen.windowStart === start && seen.observedAt <= now
          ? Math.max(0, seen.usedUSD - seen.localUSD)
          : 0;
      const usedUSD = this.totalUSD(start, now) + externalUSD;
      return {
        usedUSD,
        limitUSD,
        ratio: usedUSD / limitUSD,
        since: start,
        resetsAt:
          window === 'month'
            ? nextMonthStart(start, this.monthStartDay)
            : start + SESSION_WINDOWS[window],
        externalUSD,
      };
    };
    const perRole = (start: number | undefined) => {
      if (start === undefined) return new Map<string, number>();
      const rows = this.db
        .prepare(
          'SELECT role, SUM(cost_usd) AS total FROM sh_usage WHERE at >= ? AND at <= ? GROUP BY role',
        )
        .all(start, now) as { role: string; total: number }[];
      return new Map(rows.map((row) => [row.role, row.total]));
    };
    const fiveHourByRole = perRole(since.fiveHour);
    const weekByRole = perRole(since.week);
    const monthByRole = perRole(since.month);
    const byRole = {} as Record<RoleName, RoleUsage>;
    for (const role of roleNames) {
      const { monthlyCapUSD, weeklyTargetUSD } = roles[role];
      byRole[role] = {
        weekUSD: weekByRole.get(role) ?? 0,
        monthUSD: monthByRole.get(role) ?? 0,
        fiveHourUSD: fiveHourByRole.get(role) ?? 0,
        ...(monthlyCapUSD !== undefined && { monthlyCapUSD }),
        ...(weeklyTargetUSD !== undefined && { weeklyTargetUSD }),
      };
    }
    const month = windowUsage('month');
    // Day within the billing month, which may not start on the 1st.
    const day = Math.floor((now - monthSince) / 86_400_000) + 1;
    const idealToDateUSD = policy.idealDailyUSD * day;
    return {
      at: now,
      windows: {
        fiveHour: windowUsage('fiveHour'),
        week: windowUsage('week'),
        month,
      },
      byRole,
      pace: {
        dayOfMonth: day,
        idealToDateUSD,
        monthUSD: month.usedUSD,
        diffUSD: month.usedUSD - idealToDateUSD,
      },
    };
  }

  close(): void {
    this.db.close();
  }
}
