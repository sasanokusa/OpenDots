import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolicyFlags } from '../../src/selfhost/usage/policy';
import type { UsageSummary } from '../../src/selfhost/usage/meter';
import type { SelfhostClientEvent } from '../../src/client/selfhost/events';

const mocks = vi.hoisted(() => ({
  fetchUsage: vi.fn(),
  listener: undefined as undefined | ((event: SelfhostClientEvent) => void),
}));
vi.mock('../../src/client/selfhost/api', () => ({
  fetchSelfhostUsage: mocks.fetchUsage,
}));
vi.mock('../../src/client/selfhost/events', () => ({
  useSelfhostEvents: (
    _enabled: boolean,
    listener: (event: SelfhostClientEvent) => void,
  ) => {
    mocks.listener = listener;
  },
}));
import {
  UsagePanel,
  UsagePanelView,
  createThrottle,
  percent,
  policyChips,
  readCollapsed,
  toneFor,
  usd,
  writeCollapsed,
} from '../../src/client/selfhost/UsagePanel';

const role = (weekUSD: number, monthUSD: number, monthlyCapUSD?: number) => ({
  weekUSD,
  monthUSD,
  fiveHourUSD: 0,
  ...(monthlyCapUSD !== undefined && { monthlyCapUSD }),
});
const summary: UsageSummary = {
  at: 0,
  windows: {
    fiveHour: {
      usedUSD: 3.5,
      limitUSD: 14,
      ratio: 0.25,
      since: 0,
      resetsAt: 5 * 3600_000,
      externalUSD: 0,
    },
    week: {
      usedUSD: 29.75,
      limitUSD: 35,
      ratio: 0.85,
      since: 0,
      resetsAt: 7 * 86_400_000,
      externalUSD: 0,
    },
    month: {
      usedUSD: 70,
      limitUSD: 70,
      ratio: 1,
      since: 0,
      resetsAt: 30 * 86_400_000,
      externalUSD: 0,
    },
  },
  byRole: {
    router: role(0, 0),
    chat: role(1.25, 3.1, 20),
    planner: role(2, 17, 20),
    worker: role(5.5, 48.2, 60),
    escalation: role(0.5, 1, 10),
  },
  pace: { dayOfMonth: 12, idealToDateUSD: 28, monthUSD: 31.5, diffUSD: 3.5 },
};
const noFlags: PolicyFlags = {
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
};

describe('UsagePanelView', () => {
  const render = (props: Partial<Parameters<typeof UsagePanelView>[0]> = {}) =>
    renderToStaticMarkup(
      <UsagePanelView
        data={{ summary, policy: noFlags }}
        collapsed={false}
        onToggle={() => {}}
        {...props}
      />,
    );

  it('draws a bar per window with spend, limit and percentage', () => {
    const html = render();
    expect(html).toContain('$3.50 / $14.00');
    expect(html).toContain('25%');
    expect(html).toContain('$29.75 / $35.00');
    expect(html).toContain('85%');
    expect(html).toContain('$70.00 / $70.00');
    expect(html).toContain('100%');
    expect(html.match(/role="progressbar"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="5-hour usage"');
    expect(html).toContain('aria-valuenow="85"');
    expect(html).toContain('width:25%');
  });

  it('highlights bars at 80% or more, and marks a full one differently', () => {
    const html = render();
    expect(html).toContain('usage-row ok');
    expect(html).toContain('usage-row warn');
    expect(html).toContain('usage-row over');
    expect(html.match(/usage-row ok/g)).toHaveLength(1);
  });

  it('lists the four roles with week and month against the monthly cap', () => {
    const html = render();
    for (const name of ['chat', 'planner', 'worker', 'escalation'])
      expect(html).toContain(`>${name}</th>`);
    expect(html).not.toContain('>router</th>');
    expect(html).toContain('$1.25');
    expect(html).toContain('$3.10 / $20');
    expect(html).toContain('$48.20 / $60');
    // Planner is at 85% of its cap.
    expect(html).toMatch(/<td class="warn">\$17\.00 \/ \$20<\/td>/);
  });

  it('reports the pace against the ideal line', () => {
    expect(render()).toContain('$3.50 ahead of ideal pace');
    expect(render()).toContain('Day 12: $31.50 spent, $28.00 ideal');
    const behind = render({
      data: {
        summary: { ...summary, pace: { ...summary.pace, diffUSD: -4.25 } },
        policy: noFlags,
      },
    });
    expect(behind).toContain('$4.25 behind ideal pace');
  });

  it('shows active policy flags as chips and nothing when none are active', () => {
    expect(render()).not.toContain('usage-chips');
    const html = render({
      data: {
        summary,
        policy: {
          ...noFlags,
          pauseEscalation: true,
          chatExhausted: true,
          coolingDown: { worker: Date.now() + 60_000 },
          backlogWindowOpen: true,
        },
      },
    });
    expect(html).toContain('Escalation paused');
    expect(html).toContain('Chat cap reached');
    expect(html).toContain('worker cooling down');
    expect(html).toContain('Backlog window open');
    expect(html).not.toContain('Backlog stopped');
  });

  it('keeps a one-line summary when collapsed', () => {
    const html = render({ collapsed: true });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('5h 25% · Week 85% · Month 100%');
    expect(html).not.toContain('progressbar');
    expect(html).not.toContain('<table');
  });

  it('says so while loading and when the server cannot be reached', () => {
    expect(render({ data: undefined })).toContain('Loading usage');
    expect(render({ data: undefined, failed: true })).toContain(
      'Usage is unavailable right now.',
    );
    expect(render({ failed: true })).toContain(
      'Showing the last known numbers.',
    );
  });
});

describe('usage helpers', () => {
  it('formats money, percentages and tones', () => {
    expect(usd(3.5)).toBe('$3.50');
    expect(usd(20, true)).toBe('$20');
    expect(usd(2.5, true)).toBe('$2.50');
    expect(usd(Number.NaN)).toBe('$0.00');
    expect(percent(0.857)).toBe(86);
    expect(toneFor(0.79)).toBe('ok');
    expect(toneFor(0.8)).toBe('warn');
    expect(toneFor(1)).toBe('over');
  });

  it('turns each policy flag into a readable chip', () => {
    const all = policyChips({
      pauseEscalation: true,
      plannerUrgentOnly: true,
      stopBacklog: true,
      plannerOverWeekly: true,
      plannerReserved: true,
      advisorManualOnly: true,
      chatExhausted: true,
      coolingDown: { chat: 1, planner: 2 },
      behindPace: true,
      backlogWindowOpen: true,
    });
    expect(all.map((chip) => chip.label)).toEqual([
      'Escalation paused',
      'Planner: urgent only',
      'Backlog stopped',
      'Planner over weekly target',
      'Planner reserved',
      'Advisor: manual only',
      'Chat cap reached',
      'chat cooling down',
      'planner cooling down',
      'Behind pace',
      'Backlog window open',
    ]);
    expect(policyChips(noFlags)).toEqual([]);
  });

  it('remembers the collapsed state and survives blocked storage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    expect(readCollapsed()).toBe(true);
    writeCollapsed(false);
    expect(readCollapsed()).toBe(false);
    writeCollapsed(true);
    expect(readCollapsed()).toBe(true);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readCollapsed()).toBe(true);
    expect(() => writeCollapsed(false)).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(readCollapsed()).toBe(true);
    expect(() => writeCollapsed(false)).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe('createThrottle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs at once, then at most once per interval with a trailing run', () => {
    const fn = vi.fn();
    const throttle = createThrottle(fn, 5000);
    throttle.call();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    throttle.call();
    throttle.call();
    throttle.call();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3999);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(20_000);
    expect(fn).toHaveBeenCalledTimes(2);
    throttle.call();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('can be cancelled', () => {
    const fn = vi.fn();
    const throttle = createThrottle(fn, 5000);
    throttle.call();
    throttle.call();
    throttle.cancel();
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('UsagePanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', undefined);
    mocks.fetchUsage
      .mockReset()
      .mockResolvedValue({ summary, policy: noFlags });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads on mount, throttles usage_updated to once per 5s, and polls every minute', async () => {
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<UsagePanel />);
    });
    expect(mocks.fetchUsage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(root.toJSON())).toContain('Week 85%');

    await act(async () => {
      for (let i = 0; i < 10; i++) mocks.listener?.({ type: 'usage_updated' });
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.fetchUsage).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(mocks.fetchUsage).toHaveBeenCalledTimes(2);

    await act(async () => {
      mocks.listener?.({ type: 'thread_updated', threadId: 'x' });
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.fetchUsage).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.fetchUsage).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.fetchUsage).toHaveBeenCalledTimes(3);
  });

  it('keeps the last numbers and flags a failed refresh', async () => {
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<UsagePanel />);
    });
    mocks.fetchUsage.mockRejectedValue(new Error('down'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const html = JSON.stringify(root.toJSON());
    expect(html).toContain('Week 85%');
    await act(async () => root.unmount());
  });
});
