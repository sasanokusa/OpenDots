import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { policy, type RoleName } from '../../src/selfhost/config/models.js';
import {
  UsageMeter,
  type StoredUsage,
  type UsageMeterOptions,
} from '../../src/selfhost/usage/meter.js';
import {
  evaluatePolicy,
  isCoolingDown,
} from '../../src/selfhost/usage/policy.js';
import {
  TOKYO_OFFSET_MS,
  dayOfMonth,
  fiveHourStart,
  localHour,
  monthStart,
  weekStart,
} from '../../src/selfhost/usage/windows.js';

const iso = (value: string) => Date.parse(value);
const MIN = 60_000;
const HOUR = 3600_000;

const meters: UsageMeter[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const meter of meters.splice(0)) meter.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function open(options: UsageMeterOptions = {}, path = ':memory:') {
  const meter = new UsageMeter(path, options);
  meters.push(meter);
  return meter;
}

// One output token costs one cent, which makes dollar amounts easy to write.
const testPrices = {
  'test/cent': { inputPerM: 0, outputPerM: 10_000 },
  'test/dollar': { inputPerM: 0, outputPerM: 1_000_000 },
};

function ledger(now: number, options: UsageMeterOptions = {}) {
  const meter = open({ now: () => now, prices: testPrices, ...options });
  const spend = (role: RoleName, usd: number, at = now - MIN, status = 200) =>
    meter.record({
      at,
      role,
      model: 'test/cent',
      endpoint: '/chat/completions',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: Math.round(usd * 100),
      reasoningTokens: 0,
      status,
    });
  return { meter, spend };
}

const usage = (model: string, at = 0) => ({
  at,
  role: 'worker' as const,
  model,
  endpoint: '/chat/completions',
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  status: 200,
});

describe('windows', () => {
  it('starts the five-hour window five hours back', () => {
    const now = iso('2026-10-05T15:30:00Z');
    expect(fiveHourStart(now)).toBe(iso('2026-10-05T10:30:00Z'));
  });

  it('uses Tokyo local midnight for the week start', () => {
    const tuesdayJst = iso('2026-10-05T15:30:00Z');
    expect(new Date(tuesdayJst + TOKYO_OFFSET_MS).getUTCDay()).toBe(2);
    expect(weekStart(tuesdayJst)).toBe(iso('2026-10-04T15:00:00Z'));
    expect(weekStart(tuesdayJst, 'mon')).toBe(iso('2026-10-04T15:00:00Z'));
    expect(weekStart(tuesdayJst, 'sun')).toBe(iso('2026-10-03T15:00:00Z'));
  });

  it('includes the exact midnight and excludes the instant before it', () => {
    const mondayMidnight = iso('2026-10-04T15:00:00Z');
    expect(weekStart(mondayMidnight)).toBe(mondayMidnight);
    expect(weekStart(mondayMidnight - 1)).toBe(iso('2026-09-27T15:00:00Z'));
  });

  it('handles Sunday for both week start days', () => {
    const sundayNoonJst = iso('2026-10-04T03:00:00Z');
    expect(weekStart(sundayNoonJst, 'sun')).toBe(iso('2026-10-03T15:00:00Z'));
    expect(weekStart(sundayNoonJst, 'mon')).toBe(iso('2026-09-27T15:00:00Z'));
  });

  it('starts the month at JST midnight on day 1 by default', () => {
    expect(monthStart(iso('2026-10-05T15:30:00Z'))).toBe(
      iso('2026-09-30T15:00:00Z'),
    );
    expect(monthStart(iso('2026-09-30T14:59:59.999Z'))).toBe(
      iso('2026-08-31T15:00:00Z'),
    );
    expect(monthStart(iso('2026-09-30T15:00:00Z'))).toBe(
      iso('2026-09-30T15:00:00Z'),
    );
  });

  it('falls back to the previous month before the start day', () => {
    expect(monthStart(iso('2027-01-10T03:00:00Z'), 15)).toBe(
      iso('2026-12-14T15:00:00Z'),
    );
    expect(monthStart(iso('2026-10-20T03:00:00Z'), 15)).toBe(
      iso('2026-10-14T15:00:00Z'),
    );
  });

  it('clamps a start day beyond the length of the month', () => {
    const nov = iso('2026-11-15T03:00:00Z');
    expect(monthStart(nov, 31)).toBe(iso('2026-10-30T15:00:00Z'));
    const lastDayOfNov = iso('2026-11-30T03:00:00Z');
    expect(monthStart(lastDayOfNov, 31)).toBe(iso('2026-11-29T15:00:00Z'));
    const march = iso('2027-03-01T03:00:00Z');
    expect(monthStart(march, 30)).toBe(iso('2027-02-27T15:00:00Z'));
  });

  it('reports the Tokyo day of month and hour', () => {
    const now = iso('2026-10-05T15:30:00Z');
    expect(dayOfMonth(now)).toBe(6);
    expect(localHour(now)).toBe(0);
    const lastMinute = iso('2026-10-31T14:59:00Z');
    expect(dayOfMonth(lastMinute)).toBe(31);
    expect(localHour(lastMinute)).toBe(23);
  });
});

describe('UsageMeter cost', () => {
  it('prices fresh input, cached input and output separately', () => {
    const meter = open();
    const cost = meter.cost('claude-sonnet-5-5', {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 100_000,
    });
    expect(cost).toBeCloseTo(2.1, 10);
  });

  it('charges cached tokens at the input price when no cache price exists', () => {
    const meter = open({
      prices: { 'x/m': { inputPerM: 1, outputPerM: 2 } },
    });
    const cost = meter.cost('x/m', {
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(1, 10);
  });

  it('never bills negative fresh input when cached exceeds input', () => {
    const meter = open();
    const cost = meter.cost('claude-sonnet-5-5', {
      inputTokens: 100,
      cachedInputTokens: 200,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo((200 * 0.2) / 1e6, 12);
  });

  it('applies the calibration factor and persists it', () => {
    const meter = open();
    const tokens = {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 100_000,
    };
    meter.setCalibration('claude-sonnet-5-5', 1.5);
    expect(meter.cost('claude-sonnet-5-5', tokens)).toBeCloseTo(3.15, 10);
    expect(meter.calibration()).toEqual({ 'claude-sonnet-5-5': 1.5 });
    meter.setCalibration('claude-sonnet-5-5', 0.5);
    expect(meter.calibration()).toEqual({ 'claude-sonnet-5-5': 0.5 });
    expect(meter.cost('claude-sonnet-5-5', tokens)).toBeCloseTo(1.05, 10);
  });

  it('rejects calibration factors that are not positive and finite', () => {
    const meter = open();
    for (const factor of [0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(() => meter.setCalibration('claude-sonnet-5-5', factor)).toThrow();
    }
    expect(meter.calibration()).toEqual({});
  });

  it('freezes the cost at record time', () => {
    const meter = open();
    const call = {
      ...usage('claude-sonnet-5-5', 1000),
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    };
    const before = meter.record(call);
    meter.setCalibration('claude-sonnet-5-5', 2);
    const after = meter.record({ ...call, at: 2000 });
    expect(before.costUSD).toBeCloseTo(3, 10);
    expect(after.costUSD).toBeCloseTo(6, 10);
    expect(meter.totalUSD(0, 5000)).toBeCloseTo(9, 10);
  });

  it('records unknown models at zero cost', () => {
    const meter = open();
    const row = meter.record({
      ...usage('mystery/model', 1000),
      inputTokens: 5000,
      outputTokens: 5000,
    });
    expect(row.costUSD).toBe(0);
    expect(row.id).toBeGreaterThan(0);
    expect(meter.totalUSD(0, 2000)).toBe(0);
    expect(meter.statusTimes('worker', 200, 0)).toEqual([1000]);
  });

  it('stores failed calls with their status', () => {
    const meter = open();
    meter.record({
      ...usage('claude-sonnet-5-5', 10),
      role: 'escalation',
      status: 429,
      errorType: 'rate_limit_error',
    });
    expect(meter.statusTimes('escalation', 429, 0)).toEqual([10]);
    expect(meter.statusTimes('escalation', 200, 0)).toEqual([]);
    expect(meter.statusTimes('worker', 429, 0)).toEqual([]);
  });

  it('keeps data in a file between instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'app.db');
    const first = open({}, path);
    first.setCalibration('claude-sonnet-5-5', 1.25);
    first.record({
      ...usage('claude-sonnet-5-5', 100),
      outputTokens: 1_000_000,
    });
    first.close();
    meters.splice(meters.indexOf(first), 1);
    const second = open({}, path);
    expect(second.calibration()).toEqual({ 'claude-sonnet-5-5': 1.25 });
    expect(second.totalUSD(0, 1000)).toBeCloseTo(12.5, 10);
  });

  it('calls onRecord with the stored row after each insert', () => {
    const seen: StoredUsage[] = [];
    const meter = open({ onRecord: (row) => seen.push(row) });
    const first = meter.record({
      ...usage('claude-sonnet-5-5', 1),
      outputTokens: 1_000_000,
    });
    meter.record(usage('claude-sonnet-5-5', 2));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(first);
    expect(seen[0].costUSD).toBeCloseTo(10, 10);
    expect(seen[1].id).toBe(first.id + 1);
  });

  it('still records the call when the listener throws', () => {
    const meter = open({
      onRecord: () => {
        throw new Error('ui went away');
      },
    });
    expect(() => meter.record(usage('claude-sonnet-5-5', 5))).not.toThrow();
    expect(meter.statusTimes('worker', 200, 0)).toEqual([5]);
  });
});

describe('UsageMeter summary', () => {
  const now = iso('2026-10-14T03:00:00Z');

  function populated() {
    const { meter, spend } = ledger(now);
    spend('planner', 1, now - HOUR);
    spend('worker', 2, now - 6 * HOUR);
    spend('chat', 4, iso('2026-10-10T00:00:00Z'));
    spend('escalation', 8, iso('2026-09-29T00:00:00Z'));
    spend('chat', 0.5, now + HOUR);
    return meter;
  }

  it('totals each window from its own start', () => {
    const { windows } = populated().summary();
    expect(windows.fiveHour.since).toBe(iso('2026-10-13T22:00:00Z'));
    expect(windows.week.since).toBe(iso('2026-10-11T15:00:00Z'));
    expect(windows.month.since).toBe(iso('2026-09-30T15:00:00Z'));
    expect(windows.fiveHour.usedUSD).toBeCloseTo(1, 9);
    expect(windows.week.usedUSD).toBeCloseTo(3, 9);
    expect(windows.month.usedUSD).toBeCloseTo(7, 9);
    expect(windows.fiveHour.limitUSD).toBe(14);
    expect(windows.week.limitUSD).toBe(35);
    expect(windows.month.limitUSD).toBe(70);
    expect(windows.fiveHour.ratio).toBeCloseTo(1 / 14, 9);
    expect(windows.week.ratio).toBeCloseTo(3 / 35, 9);
    expect(windows.month.ratio).toBeCloseTo(0.1, 9);
  });

  it('splits spend by role and copies the configured targets', () => {
    const summary = populated().summary();
    const { byRole } = summary;
    expect(summary.at).toBe(now);
    expect(Object.keys(byRole).sort()).toEqual(
      ['chat', 'escalation', 'planner', 'router', 'worker'].sort(),
    );
    expect(byRole.planner).toMatchObject({
      fiveHourUSD: expect.closeTo(1, 9),
      weekUSD: expect.closeTo(1, 9),
      monthUSD: expect.closeTo(1, 9),
      monthlyCapUSD: 20,
      weeklyTargetUSD: 3.75,
    });
    expect(byRole.worker).toMatchObject({
      fiveHourUSD: 0,
      weekUSD: expect.closeTo(2, 9),
      monthUSD: expect.closeTo(2, 9),
      monthlyCapUSD: 60,
    });
    expect(byRole.chat).toMatchObject({
      weekUSD: 0,
      monthUSD: expect.closeTo(4, 9),
    });
    expect(byRole.escalation).toMatchObject({
      fiveHourUSD: 0,
      weekUSD: 0,
      monthUSD: 0,
      monthlyCapUSD: 10,
    });
    expect(byRole.router).toEqual({
      fiveHourUSD: 0,
      weekUSD: 0,
      monthUSD: 0,
    });
  });

  it('reports pace against the ideal daily spend', () => {
    const { pace } = populated().summary();
    expect(pace.dayOfMonth).toBe(14);
    expect(pace.idealToDateUSD).toBeCloseTo((70 / 30) * 14, 9);
    expect(pace.monthUSD).toBeCloseTo(7, 9);
    expect(pace.diffUSD).toBeCloseTo(7 - (70 / 30) * 14, 9);
  });

  it('honours custom week and month start days', () => {
    const { meter, spend } = ledger(now, {
      weekStartDay: 'sun',
      monthStartDay: 10,
    });
    spend('worker', 5, iso('2026-10-11T00:00:00Z'));
    spend('worker', 1, iso('2026-10-09T00:00:00Z'));
    const { windows } = meter.summary();
    expect(windows.week.since).toBe(iso('2026-10-10T15:00:00Z'));
    expect(windows.month.since).toBe(iso('2026-10-09T15:00:00Z'));
    expect(windows.week.usedUSD).toBeCloseTo(5, 9);
    expect(windows.month.usedUSD).toBeCloseTo(5, 9);
  });

  it('filters totals by role and model', () => {
    const { meter, spend } = ledger(now);
    spend('planner', 1);
    spend('worker', 2);
    meter.record({
      ...usage('test/dollar', now - MIN),
      outputTokens: 1,
    });
    expect(meter.totalUSD(0, now)).toBeCloseTo(4, 9);
    expect(meter.totalUSD(0, now, { role: 'worker' })).toBeCloseTo(3, 9);
    expect(meter.totalUSD(0, now, { model: 'test/cent' })).toBeCloseTo(3, 9);
    expect(
      meter.totalUSD(0, now, { role: 'planner', model: 'test/dollar' }),
    ).toBe(0);
  });
});

describe('policy flags', () => {
  const wed = iso('2026-10-14T03:00:00Z');
  const earlier = (at: number) => at - 6 * HOUR;

  it('has no flags set on an empty ledger', () => {
    const { meter } = ledger(wed);
    expect(evaluatePolicy(meter)).toEqual({
      pauseEscalation: false,
      plannerUrgentOnly: false,
      stopBacklog: false,
      plannerOverWeekly: false,
      plannerReserved: false,
      advisorManualOnly: false,
      chatExhausted: false,
      coolingDown: {},
      behindPace: false,
      backlogWindowOpen: false,
    });
  });

  it('pauses escalation at 80% of the five-hour limit', () => {
    const { meter, spend } = ledger(wed);
    spend('worker', 11.19);
    expect(evaluatePolicy(meter)).toMatchObject({
      pauseEscalation: false,
      plannerUrgentOnly: false,
    });
    spend('worker', 0.01);
    expect(evaluatePolicy(meter)).toMatchObject({
      pauseEscalation: true,
      plannerUrgentOnly: true,
    });
  });

  it('stops the backlog at 80% of the weekly limit', () => {
    const { meter, spend } = ledger(wed);
    spend('worker', 27.99, earlier(wed));
    expect(evaluatePolicy(meter).stopBacklog).toBe(false);
    spend('worker', 0.01, earlier(wed));
    const flags = evaluatePolicy(meter);
    expect(flags.stopBacklog).toBe(true);
    expect(flags.pauseEscalation).toBe(false);
  });

  it('flags the planner above its weekly target only when strictly over', () => {
    const { meter, spend } = ledger(wed);
    spend('planner', 3.75, earlier(wed));
    expect(evaluatePolicy(meter).plannerOverWeekly).toBe(false);
    spend('planner', 0.01, earlier(wed));
    expect(evaluatePolicy(meter).plannerOverWeekly).toBe(true);
  });

  it('reserves the planner at $18 a month', () => {
    const { meter, spend } = ledger(wed);
    spend('planner', 17.99, iso('2026-10-02T00:00:00Z'));
    expect(evaluatePolicy(meter).plannerReserved).toBe(false);
    spend('planner', 0.01, iso('2026-10-02T00:00:00Z'));
    expect(evaluatePolicy(meter).plannerReserved).toBe(true);
  });

  it('limits the advisor to manual use at $8 a month', () => {
    const { meter, spend } = ledger(wed);
    spend('escalation', 7.99, iso('2026-10-02T00:00:00Z'));
    expect(evaluatePolicy(meter).advisorManualOnly).toBe(false);
    spend('escalation', 0.01, iso('2026-10-02T00:00:00Z'));
    expect(evaluatePolicy(meter).advisorManualOnly).toBe(true);
  });

  it('marks chat exhausted at its monthly cap', () => {
    const { meter, spend } = ledger(wed);
    spend('chat', 19.99, iso('2026-10-02T00:00:00Z'));
    expect(evaluatePolicy(meter).chatExhausted).toBe(false);
    spend('chat', 0.01, iso('2026-10-02T00:00:00Z'));
    expect(evaluatePolicy(meter).chatExhausted).toBe(true);
  });

  it('counts the cap on the role, not on the model it ran', () => {
    const { meter, spend } = ledger(wed);
    spend('worker', 25, iso('2026-10-02T00:00:00Z'));
    const flags = evaluatePolicy(meter);
    expect(flags.chatExhausted).toBe(false);
    expect(flags.plannerReserved).toBe(false);
  });

  describe('behind pace', () => {
    const day21 = iso('2026-10-21T03:00:00Z');

    it('needs day 21 and a month under $50', () => {
      const day20 = iso('2026-10-20T03:00:00Z');
      expect(evaluatePolicy(ledger(day20).meter).behindPace).toBe(false);
      expect(evaluatePolicy(ledger(day21).meter).behindPace).toBe(true);
    });

    it('clears once the month reaches $50', () => {
      const { meter, spend } = ledger(day21);
      spend('worker', 49.99, iso('2026-10-02T00:00:00Z'));
      expect(evaluatePolicy(meter).behindPace).toBe(true);
      spend('worker', 0.01, iso('2026-10-02T00:00:00Z'));
      expect(evaluatePolicy(meter).behindPace).toBe(false);
    });

    it('opens the backlog window only between 01:00 and 07:00 JST', () => {
      const openAt = (hourJst: number) =>
        evaluatePolicy(
          ledger(iso('2026-10-20T15:00:00Z') + hourJst * HOUR).meter,
        );
      expect(openAt(0).backlogWindowOpen).toBe(false);
      expect(openAt(0).behindPace).toBe(true);
      expect(openAt(1).backlogWindowOpen).toBe(true);
      expect(openAt(6).backlogWindowOpen).toBe(true);
      expect(openAt(7).backlogWindowOpen).toBe(false);
      expect(openAt(12).backlogWindowOpen).toBe(false);
    });

    it('keeps the window closed when the weekly limit stops the backlog', () => {
      const night = iso('2026-10-20T18:00:00Z');
      const { meter, spend } = ledger(night);
      expect(evaluatePolicy(meter).backlogWindowOpen).toBe(true);
      spend('worker', 28, earlier(night));
      const flags = evaluatePolicy(meter);
      expect(flags.stopBacklog).toBe(true);
      expect(flags.behindPace).toBe(true);
      expect(flags.backlogWindowOpen).toBe(false);
    });

    it('can evaluate at a time other than the meter clock', () => {
      const { meter } = ledger(wed);
      expect(evaluatePolicy(meter).behindPace).toBe(false);
      expect(evaluatePolicy(meter, day21).behindPace).toBe(true);
    });
  });

  describe('cool-down', () => {
    const t0 = iso('2026-10-14T03:00:00Z');

    it('starts after two 429s inside the cool-down period', () => {
      const { meter, spend } = ledger(t0 + 2 * MIN);
      spend('planner', 0, t0, 429);
      expect(evaluatePolicy(meter).coolingDown).toEqual({});
      spend('planner', 0, t0 + MIN, 429);
      const flags = evaluatePolicy(meter);
      expect(flags.coolingDown).toEqual({
        planner: t0 + MIN + policy.coolDownMs,
      });
      expect(isCoolingDown(flags, 'planner', t0 + 2 * MIN)).toBe(true);
      expect(isCoolingDown(flags, 'worker', t0 + 2 * MIN)).toBe(false);
    });

    it('ends coolDownMs after the last 429', () => {
      const { meter, spend } = ledger(t0);
      spend('planner', 0, t0, 429);
      spend('planner', 0, t0 + MIN, 429);
      const until = t0 + MIN + policy.coolDownMs;
      expect(evaluatePolicy(meter, until - 1).coolingDown.planner).toBe(until);
      const expired = evaluatePolicy(meter, until);
      expect(expired.coolingDown).toEqual({});
      expect(isCoolingDown(expired, 'planner', until)).toBe(false);
    });

    it('keeps cooling after the first 429 ages out of the burst window', () => {
      const { meter, spend } = ledger(t0);
      spend('planner', 0, t0, 429);
      spend('planner', 0, t0 + 9 * MIN, 429);
      const flags = evaluatePolicy(meter, t0 + 15 * MIN);
      expect(flags.coolingDown.planner).toBe(t0 + 19 * MIN);
    });

    it('ignores 429s that are too far apart or on other roles', () => {
      const { meter, spend } = ledger(t0);
      spend('planner', 0, t0, 429);
      spend('planner', 0, t0 + 11 * MIN, 429);
      spend('worker', 0, t0 + 11 * MIN, 429);
      spend('worker', 0, t0 + 11 * MIN, 500);
      expect(evaluatePolicy(meter, t0 + 12 * MIN).coolingDown).toEqual({});
    });

    it('cools down each role independently', () => {
      const { meter, spend } = ledger(t0 + 3 * MIN);
      spend('chat', 0, t0, 429);
      spend('chat', 0, t0 + MIN, 429);
      spend('worker', 0, t0 + MIN, 429);
      spend('worker', 0, t0 + 2 * MIN, 429);
      const flags = evaluatePolicy(meter);
      expect(Object.keys(flags.coolingDown).sort()).toEqual(['chat', 'worker']);
    });
  });
});

describe('billing month that does not start on the 1st', () => {
  it('counts pace and behindPace from the billing start day', () => {
    // 2026-10-07 12:00 JST; billing month began 2026-09-25 00:00 JST.
    const now = iso('2026-10-07T03:00:00Z');
    const meter = open({ now: () => now, monthStartDay: 25 });
    const summary = meter.summary();
    expect(summary.windows.month.since).toBe(iso('2026-09-24T15:00:00Z'));
    expect(summary.pace.dayOfMonth).toBe(13);
    expect(summary.pace.idealToDateUSD).toBeCloseTo(policy.idealDailyUSD * 13);
    expect(evaluatePolicy(meter).behindPace).toBe(false);

    const late = iso('2026-10-16T03:00:00Z'); // day 22 of the billing month
    expect(evaluatePolicy(meter, late).behindPace).toBe(true);
  });
});
