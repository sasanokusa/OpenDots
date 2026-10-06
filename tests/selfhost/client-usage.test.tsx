import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolicyFlags } from '../../src/selfhost/usage/policy';
import type { UsageSummary } from '../../src/selfhost/usage/meter';
import type { SelfhostClientEvent } from '../../src/client/selfhost/events';

const mocks = vi.hoisted(() => ({
  fetchUsage: vi.fn(),
  fetchObserved: vi.fn(),
  putObserved: vi.fn(),
  listener: undefined as undefined | ((event: SelfhostClientEvent) => void),
}));
vi.mock('../../src/client/selfhost/api', () => ({
  fetchSelfhostUsage: mocks.fetchUsage,
  fetchSelfhostObserved: mocks.fetchObserved,
  putSelfhostObserved: mocks.putObserved,
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
  EMPTY_SYNC_FIELDS,
  SyncForm,
  UsagePanel,
  UsagePanelView,
  buildObservedBody,
  createThrottle,
  monthResetText,
  percent,
  policyChips,
  readCollapsed,
  remainingText,
  sessionResetText,
  syncedAtText,
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
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 2026-10-07 00:21 in Asia/Tokyo.
const NOW = Date.UTC(2026, 9, 6, 15, 21);
// 2026-10-22 00:00 in Asia/Tokyo.
const MONTH_RESET = Date.UTC(2026, 9, 21, 15, 0);
const summary: UsageSummary = {
  at: NOW,
  windows: {
    fiveHour: {
      usedUSD: 3.5,
      limitUSD: 14,
      ratio: 0.25,
      since: NOW - HOUR,
      resetsAt: NOW + 3 * HOUR + 20 * MINUTE,
      externalUSD: 0,
    },
    week: {
      usedUSD: 29.75,
      limitUSD: 35,
      ratio: 0.85,
      since: NOW - 5 * 86_400_000,
      resetsAt: NOW + 39 * HOUR,
      externalUSD: 0,
    },
    month: {
      usedUSD: 70,
      limitUSD: 70,
      ratio: 1,
      since: NOW - 6 * 86_400_000,
      resetsAt: MONTH_RESET,
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
        now={NOW}
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

  it('shows when each window resets, in CommandCode wording', () => {
    const html = render();
    expect(html).toContain('あと3時間20分でリセット');
    expect(html).toContain('あと1日15時間でリセット');
    expect(html).toContain('10月22日にリセット');
    expect(html.match(/class="usage-reset"/g)).toHaveLength(3);
    // The collapsed glance stays as it was: it has no room for the reset.
    expect(render({ collapsed: true })).not.toContain('リセット');
  });

  it('counts the reset down from the clock it is given', () => {
    expect(render({ now: NOW + 3 * HOUR })).toContain('あと20分でリセット');
    expect(render({ now: NOW + 3 * HOUR + 20 * MINUTE })).toContain(
      'まもなくリセット',
    );
  });

  it('says a window is unused when the server reports none open', () => {
    const html = render({
      data: {
        summary: {
          ...summary,
          windows: {
            ...summary.windows,
            fiveHour: {
              ...summary.windows.fiveHour,
              usedUSD: 0,
              ratio: 0,
              resetsAt: null,
            },
            week: {
              ...summary.windows.week,
              usedUSD: 0,
              ratio: 0,
              resetsAt: null,
            },
          },
        },
        policy: noFlags,
      },
    });
    expect(html.match(/この枠はまだ使われていません/g)).toHaveLength(2);
    expect(html).not.toContain('でリセット');
    expect(html).toContain('10月22日にリセット');
  });

  it('adds the spend that happened outside OpenDots when there is some', () => {
    expect(render()).not.toContain('OpenDots外');
    const html = render({
      data: {
        summary: {
          ...summary,
          windows: {
            ...summary.windows,
            week: { ...summary.windows.week, externalUSD: 9 },
            month: { ...summary.windows.month, externalUSD: 0.004 },
          },
        },
        policy: noFlags,
      },
    });
    expect(html).toContain('（うちOpenDots外 $9.00）');
    expect(html).toContain('（うちOpenDots外 &lt;$0.01）');
    expect(html.match(/OpenDots外/g)).toHaveLength(2);
    // It sits with the window it belongs to.
    expect(html).toMatch(
      /あと1日15時間でリセット.*?（うちOpenDots外 \$9\.00）.*?10月22日にリセット/s,
    );
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

  it('words the time left in days and hours, or hours and minutes', () => {
    const left = (ms: number) => remainingText(NOW + ms, NOW);
    expect(left(39 * HOUR)).toBe('あと1日15時間');
    expect(left(24 * HOUR)).toBe('あと1日');
    expect(left(6 * 86_400_000 + 23 * HOUR + 59 * MINUTE)).toBe(
      'あと6日23時間',
    );
    expect(left(3 * HOUR + 20 * MINUTE)).toBe('あと3時間20分');
    expect(left(3 * HOUR)).toBe('あと3時間');
    expect(left(45 * MINUTE)).toBe('あと45分');
    // Rounds up to the minute, so "3h 20m" typed a moment ago still reads 3h 20m.
    expect(left(3 * HOUR + 19 * MINUTE + 40_000)).toBe('あと3時間20分');
    expect(left(1)).toBe('あと1分');
    expect(left(0)).toBe('まもなく');
    expect(left(-5 * MINUTE)).toBe('まもなく');
    expect(sessionResetText(NOW + 45 * MINUTE, NOW)).toBe('あと45分でリセット');
    expect(sessionResetText(NOW - 1, NOW)).toBe('まもなくリセット');
    expect(sessionResetText(null, NOW)).toBe('この枠はまだ使われていません');
  });

  it('dates the monthly reset and the last sync in Asia/Tokyo', () => {
    expect(monthResetText(MONTH_RESET)).toBe('10月22日にリセット');
    // 14:59 UTC is still the 31st in Tokyo; a minute later it is New Year.
    expect(monthResetText(Date.UTC(2026, 11, 31, 14, 59))).toBe(
      '12月31日にリセット',
    );
    expect(monthResetText(Date.UTC(2026, 11, 31, 15, 0))).toBe(
      '1月1日にリセット',
    );
    expect(monthResetText(null)).toBeUndefined();
    expect(syncedAtText(NOW)).toBe('10/7 00:21');
    expect(syncedAtText(Date.UTC(2026, 10, 30, 23, 5))).toBe('12/1 08:05');
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

describe('buildObservedBody', () => {
  const fields = (patch: Partial<typeof EMPTY_SYNC_FIELDS>) => ({
    ...EMPTY_SYNC_FIELDS,
    ...patch,
  });

  it('leaves empty fields out of the request', () => {
    expect(
      buildObservedBody(
        fields({
          fiveHourPercent: '12',
          fiveHourResets: ' 3h 20m ',
          monthPercent: '5.5',
        }),
      ),
    ).toStrictEqual({
      body: {
        fiveHour: { percent: 12, resetsIn: '3h 20m' },
        month: { percent: 5.5 },
      },
    });
    // A percent with no reset text sends the percent alone ("no window open" at 0).
    expect(buildObservedBody(fields({ weekPercent: '0' }))).toStrictEqual({
      body: { week: { percent: 0 } },
    });
    expect(buildObservedBody(fields({ monthPercent: '100' }))).toStrictEqual({
      body: { month: { percent: 100 } },
    });
  });

  it('accepts what a Japanese keyboard types', () => {
    expect(
      buildObservedBody(
        fields({ weekPercent: '１２％', weekResets: '１d １５h' }),
      ),
    ).toStrictEqual({
      body: { week: { percent: 12, resetsIn: '1d 15h' } },
    });
    expect(buildObservedBody(fields({ monthPercent: '7%' }))).toStrictEqual({
      body: { month: { percent: 7 } },
    });
  });

  it('rejects numbers outside 0-100 and half-filled rows', () => {
    for (const bad of ['101', '-1', 'abc', '1,5', '12px', '.5'])
      expect(buildObservedBody(fields({ weekPercent: bad }))).toEqual({
        error: '週: 使用率は0〜100の数字で入力してください。',
      });
    expect(buildObservedBody(fields({ fiveHourResets: '1h' }))).toEqual({
      error: '5時間: 使用率（%）も入力してください。',
    });
    expect(buildObservedBody(fields({ monthPercent: '150' }))).toEqual({
      error: '月: 使用率は0〜100の数字で入力してください。',
    });
    expect(buildObservedBody(EMPTY_SYNC_FIELDS)).toEqual({
      error: 'どれか1つ入力してください。',
    });
  });
});

describe('SyncForm', () => {
  type Rendered = ReturnType<typeof create>;
  const text = (root: Rendered) => JSON.stringify(root.toJSON());
  const toggle = (root: Rendered) =>
    root.root.findByProps({ className: 'usage-sync-toggle' });
  const type = (root: Rendered, name: string, value: string) =>
    act(() => {
      root.root.findByProps({ name }).props.onChange({ target: { value } });
    });
  const submit = (root: Rendered) =>
    act(async () => {
      root.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
  const button = (root: Rendered) =>
    root.root.findByProps({ className: 'usage-sync-submit' });
  const open = async (onSaved?: () => void) => {
    let root!: Rendered;
    await act(async () => {
      root = create(<SyncForm onSaved={onSaved} />);
    });
    await act(async () => {
      toggle(root).props.onClick();
    });
    return root;
  };
  const observation = (observedAt: number) => ({
    window: 'week' as const,
    windowStart: observedAt - HOUR,
    usedUSD: 1,
    observedAt,
    localUSD: 0,
  });

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.fetchObserved
      .mockReset()
      .mockResolvedValue([observation(NOW - 86_400_000), observation(NOW)]);
    mocks.putObserved.mockReset().mockResolvedValue([observation(NOW)]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stays closed, and quiet, until opened', async () => {
    let root!: Rendered;
    await act(async () => {
      root = create(<SyncForm />);
    });
    expect(text(root)).toContain('CommandCodeの表示と合わせる');
    expect(toggle(root).props['aria-expanded']).toBe(false);
    expect(root.root.findAllByType('input')).toHaveLength(0);
    expect(mocks.fetchObserved).not.toHaveBeenCalled();
  });

  it('offers 5-hour and week percent and reset fields, and month percent', async () => {
    const root = await open();
    expect(toggle(root).props['aria-expanded']).toBe(true);
    const inputs = root.root.findAllByType('input');
    expect(inputs.map((input) => input.props.name)).toEqual([
      'fiveHourPercent',
      'fiveHourResets',
      'weekPercent',
      'weekResets',
      'monthPercent',
    ]);
    expect(
      inputs
        .filter((input) => input.props.name.endsWith('Resets'))
        .map((input) => input.props.placeholder),
    ).toEqual(['1d 15h', '1d 15h']);
    const labels = root.root.findAllByType('label');
    expect(labels).toHaveLength(2);
    for (const label of labels)
      expect(label.findByType('span').children).toEqual(['リセットまで']);
    expect(button(root).props.disabled).toBe(false);
  });

  it('shows the newest sync time from the server', async () => {
    const root = await open();
    expect(mocks.fetchObserved).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain('最終同期: 10/7 00:21');
  });

  it('says so when nothing was ever synced or the lookup fails', async () => {
    mocks.fetchObserved.mockResolvedValue([]);
    expect(text(await open())).toContain('最終同期: まだありません');
    mocks.fetchObserved.mockRejectedValue(new Error('down'));
    expect(text(await open())).toContain('最終同期: 取得できません');
  });

  it('sends only the filled fields, then refreshes and clears the form', async () => {
    const onSaved = vi.fn();
    const root = await open(onSaved);
    await type(root, 'fiveHourPercent', '12');
    await type(root, 'fiveHourResets', '3h 20m');
    await type(root, 'monthPercent', '41');
    await submit(root);
    expect(mocks.putObserved).toHaveBeenCalledTimes(1);
    expect(mocks.putObserved.mock.calls[0][0]).toStrictEqual({
      fiveHour: { percent: 12, resetsIn: '3h 20m' },
      month: { percent: 41 },
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(root.root.findByProps({ name: 'fiveHourPercent' }).props.value).toBe(
      '',
    );
    expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(text(root)).toContain('反映しました');
  });

  it('shows the server error text and keeps what was typed', async () => {
    const onSaved = vi.fn();
    mocks.putObserved.mockRejectedValue(
      new Error('fiveHour: an open window needs resetsIn or resetsAt.'),
    );
    const root = await open(onSaved);
    await type(root, 'fiveHourPercent', '30');
    await submit(root);
    expect(root.root.findByProps({ role: 'alert' }).children).toEqual([
      'fiveHour: an open window needs resetsIn or resetsAt.',
    ]);
    expect(root.root.findByProps({ name: 'fiveHourPercent' }).props.value).toBe(
      '30',
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(button(root).props.disabled).toBe(false);
    // The next attempt clears the old error.
    mocks.putObserved.mockResolvedValue([observation(NOW)]);
    await type(root, 'fiveHourResets', '1h');
    await submit(root);
    expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('checks the numbers before sending anything', async () => {
    const root = await open();
    await submit(root);
    expect(root.root.findByProps({ role: 'alert' }).children).toEqual([
      'どれか1つ入力してください。',
    ]);
    await type(root, 'weekPercent', '101');
    await submit(root);
    expect(root.root.findByProps({ role: 'alert' }).children).toEqual([
      '週: 使用率は0〜100の数字で入力してください。',
    ]);
    expect(mocks.putObserved).not.toHaveBeenCalled();
  });

  it('disables the button while saving and ignores a second submit', async () => {
    let finish!: (value: ReturnType<typeof observation>[]) => void;
    mocks.putObserved.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const root = await open();
    await type(root, 'monthPercent', '8');
    await submit(root);
    expect(button(root).props.disabled).toBe(true);
    expect(text(root)).toContain('送信中');
    await submit(root);
    expect(mocks.putObserved).toHaveBeenCalledTimes(1);
    await act(async () => finish([observation(NOW)]));
    expect(button(root).props.disabled).toBe(false);
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
  it('keeps counting the reset down between polls', async () => {
    vi.setSystemTime(NOW);
    vi.stubGlobal('localStorage', { getItem: () => '0', setItem: () => {} });
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<UsagePanel />);
    });
    expect(JSON.stringify(root.toJSON())).toContain('あと3時間20分でリセット');
    // Rounded up to the minute: half a minute later it is still 3h 20m.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(JSON.stringify(root.toJSON())).toContain('あと3時間20分でリセット');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(JSON.stringify(root.toJSON())).toContain('あと3時間19分でリセット');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
    });
    expect(JSON.stringify(root.toJSON())).toContain('あと3時間9分でリセット');
    await act(async () => root.unmount());
  });

  it('reloads the numbers right after the CommandCode form is saved', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '0', setItem: () => {} });
    mocks.fetchObserved.mockResolvedValue([]);
    mocks.putObserved.mockResolvedValue([]);
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<UsagePanel />);
    });
    expect(mocks.fetchUsage).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.root.findByProps({ className: 'usage-sync-toggle' }).props.onClick();
    });
    await act(async () => {
      root.root
        .findByProps({ name: 'monthPercent' })
        .props.onChange({ target: { value: '9' } });
    });
    await act(async () => {
      root.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    expect(mocks.putObserved).toHaveBeenCalledWith({ month: { percent: 9 } });
    expect(mocks.fetchUsage).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });
});
