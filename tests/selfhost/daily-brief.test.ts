import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATCH_UP_MS,
  DailyBrief,
  briefPrompt,
  localDay,
  nextBriefAt,
  parseBriefTime,
} from '../../src/selfhost/brief/daily.js';

// Local times, so the tests hold in any time zone.
const at = (day: number, hours: number, minutes = 0) =>
  new Date(2026, 9, day, hours, minutes).getTime();
const SEVEN_THIRTY = 7 * 60 + 30;

describe('parseBriefTime', () => {
  it('reads HH:MM as minutes after midnight', () => {
    expect(parseBriefTime('07:30')).toBe(450);
    expect(parseBriefTime(' 7:05 ')).toBe(425);
    expect(parseBriefTime('23:59')).toBe(1439);
  });

  it('refuses anything else', () => {
    for (const bad of ['7', '24:00', '07:60', 'morning'])
      expect(() => parseBriefTime(bad)).toThrow('MORNING_BRIEF_AT');
  });
});

describe('nextBriefAt', () => {
  it('is today at the time when it is still ahead', () => {
    expect(nextBriefAt(at(8, 6), SEVEN_THIRTY, undefined)).toBe(at(8, 7, 30));
  });

  it('catches up a missed brief for a few hours, then waits for tomorrow', () => {
    expect(nextBriefAt(at(8, 9), SEVEN_THIRTY, '2026-10-07')).toBe(at(8, 9));
    expect(
      nextBriefAt(at(8, 7, 30) + CATCH_UP_MS + 1, SEVEN_THIRTY, '2026-10-07'),
    ).toBe(at(9, 7, 30));
  });

  it('runs once a day', () => {
    expect(nextBriefAt(at(8, 7, 31), SEVEN_THIRTY, '2026-10-08')).toBe(
      at(9, 7, 30),
    );
  });
});

describe('briefPrompt', () => {
  it('names the local date and weekday', () => {
    expect(briefPrompt(at(8, 7, 30))).toContain('今日は10月8日(木)です。');
    expect(localDay(at(8, 23, 59))).toBe('2026-10-08');
  });
});

describe('DailyBrief', () => {
  afterEach(() => vi.useRealTimers());

  it('sends at the time, records the day, and schedules the next one', async () => {
    vi.useFakeTimers({ now: at(8, 7) });
    const send = vi.fn(async () => {});
    const brief = new DailyBrief({
      db: new DatabaseSync(':memory:'),
      minutes: SEVEN_THIRTY,
      send,
      paused: () => false,
    });
    brief.start();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(brief.lastDay()).toBe('2026-10-08');
    expect(brief.nextAt()).toBe(at(9, 7, 30));
    brief.stop();
  });

  it('skips the send while paused but still counts the day', async () => {
    vi.useFakeTimers({ now: at(8, 7, 30) });
    const send = vi.fn(async () => {});
    const brief = new DailyBrief({
      db: new DatabaseSync(':memory:'),
      minutes: SEVEN_THIRTY,
      send,
      paused: () => true,
    });
    await brief.run();
    expect(send).not.toHaveBeenCalled();
    expect(brief.lastDay()).toBe('2026-10-08');
    brief.stop();
  });

  it('keeps going after a failed send', async () => {
    vi.useFakeTimers({ now: at(8, 7, 30) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brief = new DailyBrief({
      db: new DatabaseSync(':memory:'),
      minutes: SEVEN_THIRTY,
      send: () => Promise.reject(new TypeError('offline')),
      paused: () => false,
    });
    brief.start();
    await brief.run();
    expect(error).toHaveBeenCalledWith('Morning brief failed:', 'TypeError');
    expect(brief.nextAt()).toBe(at(9, 7, 30));
    brief.stop();
    error.mockRestore();
  });
});
