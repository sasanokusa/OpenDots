// Sidebar usage meter for the self-hosted backend: spend against the 5-hour,
// weekly and monthly limits, per-role spend, pace, and active policy flags.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  fetchSelfhostObserved,
  fetchSelfhostUsage,
  putSelfhostObserved,
  type ObservedBody,
  type PolicyFlags,
  type UsageObservation,
  type UsageResponse,
  type UsageSummary,
} from './api';
import { useSelfhostEvents } from './events';
import { intlLocale, t, tMessage } from './i18n';

const STORAGE_KEY = 'opendots-selfhost-usage-collapsed';
const WARN_RATIO = 0.8;
const EVENT_THROTTLE_MS = 5000;
const POLL_MS = 60_000;
// The reset countdown has minute resolution; ticking twice a minute keeps it
// from lagging by more than half a minute.
const CLOCK_TICK_MS = 30_000;
const MINUTE_MS = 60_000;
const TOKYO_OFFSET_MS = 9 * 3_600_000;

export function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === '1';
  } catch {
    return true;
  }
}

export function writeCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage can be blocked; the panel simply forgets its state.
  }
}

/** Runs `fn` at once if the last run was long enough ago, else once at the end of the interval. */
export function createThrottle(
  fn: () => void,
  intervalMs: number,
  now: () => number = Date.now,
) {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    timer = undefined;
    last = now();
    fn();
  };
  return {
    call() {
      if (timer) return;
      const wait = last + intervalMs - now();
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function usd(value: number, trim = false): string {
  const amount = Math.abs(Number.isFinite(value) ? value : 0);
  // Single cheap calls cost fractions of a cent; show that something was spent.
  if (amount > 0 && amount < 0.005) return '<$0.01';
  const text = amount.toFixed(2);
  return `$${trim && text.endsWith('.00') ? text.slice(0, -3) : text}`;
}

/** Share of a limit used; an unusable ratio counts as full only if something was spent. */
export function usageRatio(usage: { usedUSD: number; ratio: number }): number {
  if (Number.isFinite(usage.ratio)) return Math.max(0, usage.ratio);
  return usage.usedUSD > 0 ? 1 : 0;
}

export function percent(ratio: number): number {
  return Math.round(ratio * 100);
}

export type Tone = 'ok' | 'warn' | 'over';
export function toneFor(ratio: number): Tone {
  return ratio >= 1 ? 'over' : ratio >= WARN_RATIO ? 'warn' : 'ok';
}

/** "あと1日15時間" / "あと3時間20分", rounded up to the minute. */
export function remainingText(resetsAt: number, now: number): string {
  const total = Math.ceil((resetsAt - now) / MINUTE_MS);
  if (!(total > 0)) return 'まもなく';
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const span =
    days > 0
      ? `${days}日${hours > 0 ? `${hours}時間` : ''}`
      : hours > 0
        ? `${hours}時間${minutes > 0 ? `${minutes}分` : ''}`
        : `${minutes}分`;
  return `あと${span}`;
}

/** Reset line for a 5-hour or weekly window, in CommandCode's wording. */
export function sessionResetText(resetsAt: number | null, now: number) {
  if (resetsAt === null) return 'この枠はまだ使われていません';
  const left = remainingText(resetsAt, now);
  return left === 'まもなく' ? 'まもなくリセット' : `${left}でリセット`;
}

/** Month/day/time of an instant in Asia/Tokyo (a fixed UTC+9, no DST). */
function tokyoParts(at: number) {
  const date = new Date(at + TOKYO_OFFSET_MS);
  const two = (value: number) => String(value).padStart(2, '0');
  return {
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    time: `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`,
  };
}

export function monthResetText(resetsAt: number | null): string | undefined {
  if (resetsAt === null) return undefined;
  const { month, day } = tokyoParts(resetsAt);
  return `${month}月${day}日にリセット`;
}

/** "10/7 00:21" */
export function syncedAtText(at: number): string {
  const { month, day, time } = tokyoParts(at);
  return `${month}/${day} ${time}`;
}

export interface PolicyChip {
  key: string;
  label: string;
  title: string;
  tone: 'warn' | 'info';
}

/** Human-readable chips for the policy flags that are currently active. */
export function policyChips(flags: PolicyFlags): PolicyChip[] {
  const chips: PolicyChip[] = [];
  const add = (
    active: boolean,
    key: string,
    label: string,
    title: string,
    tone: PolicyChip['tone'] = 'warn',
  ) => {
    if (active) chips.push({ key, label, title, tone });
  };
  add(
    flags.pauseEscalation,
    'pauseEscalation',
    t('Escalation paused'),
    t('The 5-hour window is nearly used up, so escalation waits.'),
  );
  add(
    flags.plannerUrgentOnly,
    'plannerUrgentOnly',
    t('Planner: urgent only'),
    t('The planner only takes urgent work until the 5-hour window recovers.'),
  );
  add(
    flags.stopBacklog,
    'stopBacklog',
    t('Backlog stopped'),
    t('The weekly limit is nearly used up, so background work is stopped.'),
  );
  add(
    flags.plannerOverWeekly,
    'plannerOverWeekly',
    t('Planner over weekly target'),
    t('The planner has passed its weekly target and needs higher confidence.'),
  );
  add(
    flags.plannerReserved,
    'plannerReserved',
    t('Planner reserved'),
    t('Planner spend has reached its monthly reserve.'),
  );
  add(
    flags.advisorManualOnly,
    'advisorManualOnly',
    t('Advisor: manual only'),
    t(
      'Escalation spend reached the automatic limit; only manual escalation runs.',
    ),
  );
  add(
    flags.chatExhausted,
    'chatExhausted',
    t('Chat cap reached'),
    t('Chat has used its monthly cap.'),
  );
  for (const [role, until] of Object.entries(flags.coolingDown ?? {})) {
    add(
      true,
      `cooling-${role}`,
      t('{role} cooling down', { role }),
      t('Rate limited until {time}.', {
        time: new Date(until).toLocaleTimeString(intlLocale()),
      }),
    );
  }
  add(
    flags.behindPace,
    'behindPace',
    t('Behind pace'),
    t('Spend is below the ideal pace for this point in the month.'),
    'info',
  );
  add(
    flags.backlogWindowOpen,
    'backlogWindowOpen',
    t('Backlog window open'),
    t('Background work may use the spare budget right now.'),
    'info',
  );
  return chips;
}

const WINDOWS = ['fiveHour', 'week', 'month'] as const;
/** Short label and full name of a window, in the UI language. */
const windowLabels = (key: (typeof WINDOWS)[number]) =>
  ({
    fiveHour: [t('5h'), t('5-hour')],
    week: [t('Week'), t('Weekly')],
    month: [t('Month'), t('Monthly')],
  })[key];
const ROLES = ['chat', 'planner', 'worker', 'escalation'] as const;

/** When the window resets, and how much of its spend came from outside OpenDots. */
export function windowNote(
  key: (typeof WINDOWS)[number],
  usage: UsageSummary['windows']['fiveHour'],
  now: number,
): { reset?: string; external?: string } {
  return {
    reset:
      key === 'month'
        ? monthResetText(usage.resetsAt)
        : sessionResetText(usage.resetsAt, now),
    external:
      usage.externalUSD > 0
        ? `（うちOpenDots外 ${usd(usage.externalUSD)}）`
        : undefined,
  };
}

function Bar({
  label,
  name,
  usage,
  note,
}: {
  label: string;
  name: string;
  usage: UsageSummary['windows']['fiveHour'];
  note: ReturnType<typeof windowNote>;
}) {
  const ratio = usageRatio(usage);
  const pct = percent(ratio);
  const text = `${usd(usage.usedUSD)} / ${usd(usage.limitUSD)}`;
  return (
    <div className={`usage-row ${toneFor(ratio)}`}>
      <span className="usage-label">{label}</span>
      <span className="usage-amount">{text}</span>
      <span className="usage-pct">{pct}%</span>
      <div
        className="usage-bar"
        role="progressbar"
        aria-label={t('{name} usage', { name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, pct)}
        aria-valuetext={`${text} (${pct}%)`}
      >
        <i style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      {(note.reset || note.external) && (
        <small className="usage-reset">
          {note.reset}
          {note.reset && note.external && ' '}
          {note.external && (
            <span className="usage-external">{note.external}</span>
          )}
        </small>
      )}
    </div>
  );
}

function paceText(pace: UsageSummary['pace']) {
  const diff = pace.diffUSD;
  const headline =
    Math.abs(diff) < 0.005
      ? t('On ideal pace')
      : diff > 0
        ? t('{amount} ahead of ideal pace', { amount: usd(diff) })
        : t('{amount} behind ideal pace', { amount: usd(diff) });
  return {
    headline,
    detail: t('Day {day}: {spent} spent, {ideal} ideal', {
      day: pace.dayOfMonth,
      spent: usd(pace.monthUSD),
      ideal: usd(pace.idealToDateUSD),
    }),
  };
}

const SYNC_ROWS = [
  ['fiveHour', '5時間', true],
  ['week', '週', true],
  ['month', '月', false],
] as const;
type SyncKey = (typeof SYNC_ROWS)[number][0];

export type SyncFields = Record<`${SyncKey}Percent`, string> &
  Record<`${Exclude<SyncKey, 'month'>}Resets`, string>;
export const EMPTY_SYNC_FIELDS: SyncFields = {
  fiveHourPercent: '',
  fiveHourResets: '',
  weekPercent: '',
  weekResets: '',
  monthPercent: '',
};

/** Accepts full-width digits and a trailing %; undefined unless 0-100. */
function parsePercent(text: string): number | undefined {
  const cleaned = text.normalize('NFKC').trim().replace(/%$/, '').trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const value = Number(cleaned);
  return value <= 100 ? value : undefined;
}

/** The PUT body for the filled-in fields; empty fields are left out. */
export function buildObservedBody(
  fields: SyncFields,
): { body: ObservedBody } | { error: string } {
  const body: ObservedBody = {};
  for (const [key, label] of SYNC_ROWS) {
    const percentText = fields[`${key}Percent`].trim();
    const resetsIn =
      key === 'month' ? '' : fields[`${key}Resets`].normalize('NFKC').trim();
    if (!percentText && !resetsIn) continue;
    if (!percentText)
      return { error: `${label}: 使用率（%）も入力してください。` };
    const value = parsePercent(percentText);
    if (value === undefined)
      return { error: `${label}: 使用率は0〜100の数字で入力してください。` };
    if (key === 'month') body.month = { percent: value };
    else body[key] = { percent: value, ...(resetsIn && { resetsIn }) };
  }
  if (!Object.keys(body).length)
    return { error: 'どれか1つ入力してください。' };
  return { body };
}

/** Lets the owner copy CommandCode's own usage page into the meter. */
export function SyncForm({ onSaved }: { onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState(EMPTY_SYNC_FIELDS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [observations, setObservations] = useState<UsageObservation[]>();
  const [syncFailed, setSyncFailed] = useState(false);
  const mounted = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  const errorLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    // The panel body scrolls; bring the form into view rather than leave it below the fold.
    root.current?.scrollIntoView?.({ block: 'start' });
    let live = true;
    fetchSelfhostObserved()
      .then((next) => {
        if (!live) return;
        setObservations(next);
        setSyncFailed(false);
      })
      .catch(() => {
        if (live) setSyncFailed(true);
      });
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (error) errorLine.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error]);

  const submit = async () => {
    if (saving) return;
    const built = buildObservedBody(fields);
    setSaved(false);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setError(undefined);
    setSaving(true);
    try {
      const next = await putSelfhostObserved(built.body);
      if (!mounted.current) return;
      setObservations(next);
      setSyncFailed(false);
      setFields(EMPTY_SYNC_FIELDS);
      setSaved(true);
      onSaved?.();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error && cause.message
            ? tMessage(cause.message)
            : '送信できませんでした。',
        );
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const newest = observations?.length
    ? Math.max(...observations.map((item) => item.observedAt))
    : undefined;
  const syncText = syncFailed
    ? '取得できません'
    : !observations
      ? '確認中…'
      : newest === undefined
        ? 'まだありません'
        : syncedAtText(newest);
  const Chevron = open ? ChevronUp : ChevronDown;
  const input = (
    name: keyof SyncFields,
    label: string,
    placeholder?: string,
  ) => (
    <input
      className="usage-sync-input"
      type="text"
      name={name}
      aria-label={label}
      placeholder={placeholder}
      inputMode={name.endsWith('Percent') ? 'decimal' : 'text'}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      value={fields[name]}
      onChange={(event) => {
        const value = event.target.value;
        setFields((current) => ({ ...current, [name]: value }));
      }}
    />
  );
  return (
    <div className="usage-sync" ref={root}>
      <button
        type="button"
        className="usage-sync-toggle"
        aria-expanded={open}
        aria-controls="usage-sync-body"
        onClick={() => setOpen(!open)}
      >
        <span>CommandCodeの表示と合わせる</span>
        <Chevron size={14} />
      </button>
      {open && (
        <div className="usage-sync-body" id="usage-sync-body">
          <p className="usage-note">
            CommandCodeの使用量ページの数字を入力します。空欄は送信されません。
          </p>
          <form
            className="usage-sync-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {SYNC_ROWS.map(([key, label, hasResets]) => (
              <div className="usage-sync-row" key={key}>
                <span className="usage-label">{label}</span>
                <span className="usage-sync-percent">
                  {input(`${key}Percent`, `${label} 使用率（%）`)}%
                </span>
                {hasResets && (
                  <label className="usage-sync-resets">
                    <span>リセットまで</span>
                    {input(`${key}Resets`, `${label} リセットまで`, '1d 15h')}
                  </label>
                )}
              </div>
            ))}
            <button
              type="submit"
              className="usage-sync-submit"
              disabled={saving}
            >
              {saving ? '送信中…' : '反映する'}
            </button>
          </form>
          {error && (
            <p className="usage-sync-error" role="alert" ref={errorLine}>
              {error}
            </p>
          )}
          {saved && (
            <p className="usage-note" role="status">
              反映しました。
            </p>
          )}
          <p className="usage-note">{`最終同期: ${syncText}`}</p>
        </div>
      )}
    </div>
  );
}

export function UsagePanelView({
  data,
  failed = false,
  collapsed,
  onToggle,
  onSynced,
  now = Date.now(),
}: {
  data?: UsageResponse;
  failed?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /** Called after the owner's CommandCode numbers were saved. */
  onSynced?: () => void;
  now?: number;
}) {
  const summary = data?.summary;
  const ratios = summary
    ? WINDOWS.map((key) => usageRatio(summary.windows[key]))
    : [];
  const worst = Math.max(0, ...ratios);
  const glance = summary
    ? WINDOWS.map(
        (key, index) => `${windowLabels(key)[0]} ${percent(ratios[index])}%`,
      ).join(' · ')
    : failed
      ? t('unavailable')
      : t('loading…');
  const Chevron = collapsed ? ChevronDown : ChevronUp;
  const chips = data ? policyChips(data.policy) : [];
  const pace = summary ? paceText(summary.pace) : undefined;
  return (
    <section className="usage-panel" aria-label={t('Model usage')}>
      <button
        type="button"
        className="usage-toggle"
        aria-expanded={!collapsed}
        aria-controls="usage-panel-body"
        onClick={onToggle}
      >
        <span className="usage-title">{t('Usage')}</span>
        <span className={`usage-glance ${toneFor(worst)}`}>{glance}</span>
        <Chevron size={14} />
      </button>
      {!collapsed && (
        <div className="usage-body" id="usage-panel-body">
          {!summary && (
            <p className="usage-note">
              {failed
                ? t('Usage is unavailable right now.')
                : t('Loading usage…')}
            </p>
          )}
          {summary && (
            <>
              {WINDOWS.map((key) => (
                <Bar
                  key={key}
                  label={windowLabels(key)[0]}
                  name={windowLabels(key)[1]}
                  usage={summary.windows[key]}
                  note={windowNote(key, summary.windows[key], now)}
                />
              ))}
              <table className="usage-roles">
                <thead>
                  <tr>
                    <th scope="col">{t('Role')}</th>
                    <th scope="col">{t('Week')}</th>
                    <th scope="col">{t('Month')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ROLES.filter((role) => summary.byRole[role]).map((role) => {
                    const usage = summary.byRole[role];
                    const cap = usage.monthlyCapUSD;
                    const tone =
                      cap && cap > 0 ? toneFor(usage.monthUSD / cap) : 'ok';
                    return (
                      <tr key={role}>
                        <th scope="row">{role}</th>
                        <td>{usd(usage.weekUSD)}</td>
                        <td className={tone}>
                          {usd(usage.monthUSD)}
                          {cap !== undefined && ` / ${usd(cap, true)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {pace && (
                <p className="usage-pace">
                  <strong>{pace.headline}</strong>
                  <small>{pace.detail}</small>
                </p>
              )}
              {chips.length > 0 && (
                <ul className="usage-chips" aria-label={t('Active policies')}>
                  {chips.map((chip) => (
                    <li key={chip.key} className={chip.tone} title={chip.title}>
                      {chip.label}
                    </li>
                  ))}
                </ul>
              )}
              <SyncForm onSaved={onSynced} />
              {failed && (
                <p className="usage-note">
                  {t('Showing the last known numbers.')}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function UsagePanel() {
  const now = useNow();
  const [data, setData] = useState<UsageResponse>();
  const [failed, setFailed] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const sequence = useRef(0);
  const load = useCallback(() => {
    const mine = ++sequence.current;
    fetchSelfhostUsage()
      .then((next) => {
        if (mine !== sequence.current) return;
        setData(next);
        setFailed(false);
      })
      .catch(() => {
        if (mine === sequence.current) setFailed(true);
      });
  }, []);
  const refresh = useMemo(
    () => createThrottle(load, EVENT_THROTTLE_MS),
    [load],
  );
  useEffect(() => {
    refresh.call();
    const timer = setInterval(refresh.call, POLL_MS);
    return () => {
      clearInterval(timer);
      refresh.cancel();
      sequence.current++;
    };
  }, [refresh]);
  useSelfhostEvents(true, (event) => {
    if (event.type === 'usage_updated') refresh.call();
  });
  return (
    <UsagePanelView
      data={data}
      failed={failed}
      collapsed={collapsed}
      now={now}
      onSynced={load}
      onToggle={() => {
        writeCollapsed(!collapsed);
        setCollapsed(!collapsed);
      }}
    />
  );
}
