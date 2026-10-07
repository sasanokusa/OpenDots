import type { DatabaseSync } from 'node:sqlite';

/** "07:30" → minutes after local midnight. */
export function parseBriefTime(value: string): number {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match)
    throw new Error('MORNING_BRIEF_AT must be a local time like 07:30.');
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Local calendar day, e.g. 2026-10-08. */
export function localDay(time: number): string {
  const date = new Date(time);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function atMinutes(day: number, minutes: number): number {
  const date = new Date(day);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date.getTime();
}

/** A run missed while the server was down still goes out this long after. */
export const CATCH_UP_MS = 3 * 60 * 60_000;

/**
 * When the next brief is due: today's time if it has not run today and is
 * at most CATCH_UP_MS late, otherwise the next day's time.
 */
export function nextBriefAt(
  now: number,
  minutes: number,
  lastDay: string | undefined,
): number {
  const today = atMinutes(now, minutes);
  if (lastDay !== localDay(now) && now <= today + CATCH_UP_MS)
    return Math.max(today, now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.getTime();
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** What the owner "says" to start the brief; the environment note says how. */
export function briefPrompt(now: number): string {
  const date = new Date(now);
  return `朝のまとめをお願いします。今日は${date.getMonth() + 1}月${date.getDate()}日(${WEEKDAYS[date.getDay()]})です。残タスクを集めて、今日やることを優先度順に短くまとめてください。`;
}

export interface DailyBriefOptions {
  db: DatabaseSync;
  /** Minutes after local midnight (parseBriefTime). */
  minutes: number;
  /** Sends the brief; resolves once it was delivered or given up. */
  send: () => Promise<void>;
  paused: () => boolean;
  now?: () => number;
}

/** Sends the morning brief once a day at a fixed local time. */
export class DailyBrief {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true;
  readonly #now: () => number;

  constructor(private options: DailyBriefOptions) {
    this.#now = options.now ?? Date.now;
    options.db.exec(`CREATE TABLE IF NOT EXISTS sh_daily_brief(
      id INTEGER PRIMARY KEY CHECK (id = 1), last_day TEXT NOT NULL)`);
  }

  lastDay(): string | undefined {
    const row = this.options.db
      .prepare('SELECT last_day FROM sh_daily_brief WHERE id = 1')
      .get() as { last_day: string } | undefined;
    return row?.last_day;
  }

  nextAt(): number {
    return nextBriefAt(this.#now(), this.options.minutes, this.lastDay());
  }

  start() {
    this.#stopped = false;
    this.#schedule();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  #schedule() {
    if (this.#stopped) return;
    clearTimeout(this.#timer);
    const delay = Math.max(0, this.nextAt() - this.#now());
    this.#timer = setTimeout(() => void this.run(), delay);
    this.#timer.unref?.();
  }

  /** One brief now (the timer calls this); marks the day as done first. */
  async run() {
    const day = localDay(this.#now());
    this.options.db
      .prepare(
        `INSERT INTO sh_daily_brief(id, last_day) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_day = excluded.last_day`,
      )
      .run(day);
    try {
      if (!this.options.paused()) await this.options.send();
    } catch (error) {
      console.error(
        'Morning brief failed:',
        error instanceof Error ? error.name : 'Error',
      );
    } finally {
      this.#schedule();
    }
  }
}
