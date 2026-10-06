export const TOKYO_OFFSET_MS = 9 * 3600_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * CommandCode's 5-hour and 7-day windows open on the first request and reset
 * exactly that long afterwards; there is no fixed clock or calendar boundary.
 */
export const SESSION_WINDOWS = {
  fiveHour: 5 * HOUR_MS,
  week: 7 * DAY_MS,
} as const;
export type SessionWindow = keyof typeof SESSION_WINDOWS;

/**
 * Start of the window active at `now`, given a way to find the first request
 * at or after a time. Walks forward from `from`; undefined = no open window.
 */
export function sessionStart(
  length: number,
  now: number,
  from: number,
  firstRequestAt: (from: number) => number | undefined,
  knownStart?: number,
): number | undefined {
  let start = knownStart ?? firstRequestAt(from);
  while (start !== undefined && start + length <= now)
    start = firstRequestAt(start + length);
  return start !== undefined && start <= now ? start : undefined;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function monthStartLocal(
  year: number,
  month: number,
  startDay: number,
): number {
  const day = Math.min(
    Math.max(1, Math.trunc(startDay)),
    daysInMonth(year, month),
  );
  return Date.UTC(year, month, day);
}

export function monthStart(now: number, startDay = 1): number {
  const localNow = now + TOKYO_OFFSET_MS;
  const local = new Date(localNow);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const start = monthStartLocal(year, month, startDay);
  if (start <= localNow) return start - TOKYO_OFFSET_MS;
  const previous = new Date(Date.UTC(year, month - 1, 1));
  return (
    monthStartLocal(
      previous.getUTCFullYear(),
      previous.getUTCMonth(),
      startDay,
    ) - TOKYO_OFFSET_MS
  );
}

/** The billing-month boundary after `start` (a value returned by monthStart). */
export function nextMonthStart(start: number, startDay = 1): number {
  return monthStart(start + 32 * DAY_MS, startDay);
}

export function dayOfMonth(now: number): number {
  return new Date(now + TOKYO_OFFSET_MS).getUTCDate();
}

export function localHour(now: number): number {
  return new Date(now + TOKYO_OFFSET_MS).getUTCHours();
}
