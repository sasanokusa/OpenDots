export const TOKYO_OFFSET_MS = 9 * 3600_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

export function fiveHourStart(now: number): number {
  return now - 5 * HOUR_MS;
}

export function weekStart(
  now: number,
  startDay: 'mon' | 'sun' = 'mon',
): number {
  const local = now + TOKYO_OFFSET_MS;
  const midnight = Math.floor(local / DAY_MS) * DAY_MS;
  const weekday = new Date(midnight).getUTCDay();
  const back = startDay === 'mon' ? (weekday + 6) % 7 : weekday;
  return midnight - back * DAY_MS - TOKYO_OFFSET_MS;
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

export function dayOfMonth(now: number): number {
  return new Date(now + TOKYO_OFFSET_MS).getUTCDate();
}

export function localHour(now: number): number {
  return new Date(now + TOKYO_OFFSET_MS).getUTCHours();
}
