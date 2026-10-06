// Sidebar usage meter for the self-hosted backend: spend against the 5-hour,
// weekly and monthly limits, per-role spend, pace, and active policy flags.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  fetchSelfhostUsage,
  type PolicyFlags,
  type UsageResponse,
  type UsageSummary,
} from './api';
import { useSelfhostEvents } from './events';

const STORAGE_KEY = 'opendots-selfhost-usage-collapsed';
const WARN_RATIO = 0.8;
const EVENT_THROTTLE_MS = 5000;
const POLL_MS = 60_000;

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
    'Escalation paused',
    'The 5-hour window is nearly used up, so escalation waits.',
  );
  add(
    flags.plannerUrgentOnly,
    'plannerUrgentOnly',
    'Planner: urgent only',
    'The planner only takes urgent work until the 5-hour window recovers.',
  );
  add(
    flags.stopBacklog,
    'stopBacklog',
    'Backlog stopped',
    'The weekly limit is nearly used up, so background work is stopped.',
  );
  add(
    flags.plannerOverWeekly,
    'plannerOverWeekly',
    'Planner over weekly target',
    'The planner has passed its weekly target and needs higher confidence.',
  );
  add(
    flags.plannerReserved,
    'plannerReserved',
    'Planner reserved',
    'Planner spend has reached its monthly reserve.',
  );
  add(
    flags.advisorManualOnly,
    'advisorManualOnly',
    'Advisor: manual only',
    'Escalation spend reached the automatic limit; only manual escalation runs.',
  );
  add(
    flags.chatExhausted,
    'chatExhausted',
    'Chat cap reached',
    'Chat has used its monthly cap.',
  );
  for (const [role, until] of Object.entries(flags.coolingDown ?? {})) {
    add(
      true,
      `cooling-${role}`,
      `${role} cooling down`,
      `Rate limited until ${new Date(until).toLocaleTimeString()}.`,
    );
  }
  add(
    flags.behindPace,
    'behindPace',
    'Behind pace',
    'Spend is below the ideal pace for this point in the month.',
    'info',
  );
  add(
    flags.backlogWindowOpen,
    'backlogWindowOpen',
    'Backlog window open',
    'Background work may use the spare budget right now.',
    'info',
  );
  return chips;
}

const WINDOWS = [
  ['fiveHour', '5h', '5-hour'],
  ['week', 'Week', 'Weekly'],
  ['month', 'Month', 'Monthly'],
] as const;
const ROLES = ['chat', 'planner', 'worker', 'escalation'] as const;

function Bar({
  label,
  name,
  usage,
}: {
  label: string;
  name: string;
  usage: UsageSummary['windows']['fiveHour'];
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
        aria-label={`${name} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, pct)}
        aria-valuetext={`${text} (${pct}%)`}
      >
        <i style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
    </div>
  );
}

function paceText(pace: UsageSummary['pace']) {
  const diff = pace.diffUSD;
  const headline =
    Math.abs(diff) < 0.005
      ? 'On ideal pace'
      : `${usd(diff)} ${diff > 0 ? 'ahead of' : 'behind'} ideal pace`;
  return {
    headline,
    detail: `Day ${pace.dayOfMonth}: ${usd(pace.monthUSD)} spent, ${usd(pace.idealToDateUSD)} ideal`,
  };
}

export function UsagePanelView({
  data,
  failed = false,
  collapsed,
  onToggle,
}: {
  data?: UsageResponse;
  failed?: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const summary = data?.summary;
  const ratios = summary
    ? WINDOWS.map(([key]) => usageRatio(summary.windows[key]))
    : [];
  const worst = Math.max(0, ...ratios);
  const glance = summary
    ? WINDOWS.map(
        ([, label], index) => `${label} ${percent(ratios[index])}%`,
      ).join(' · ')
    : failed
      ? 'unavailable'
      : 'loading…';
  const Chevron = collapsed ? ChevronDown : ChevronUp;
  const chips = data ? policyChips(data.policy) : [];
  const pace = summary ? paceText(summary.pace) : undefined;
  return (
    <section className="usage-panel" aria-label="Model usage">
      <button
        type="button"
        className="usage-toggle"
        aria-expanded={!collapsed}
        aria-controls="usage-panel-body"
        onClick={onToggle}
      >
        <span className="usage-title">Usage</span>
        <span className={`usage-glance ${toneFor(worst)}`}>{glance}</span>
        <Chevron size={14} />
      </button>
      {!collapsed && (
        <div className="usage-body" id="usage-panel-body">
          {!summary && (
            <p className="usage-note">
              {failed ? 'Usage is unavailable right now.' : 'Loading usage…'}
            </p>
          )}
          {summary && (
            <>
              {WINDOWS.map(([key, label, name]) => (
                <Bar
                  key={key}
                  label={label}
                  name={name}
                  usage={summary.windows[key]}
                />
              ))}
              <table className="usage-roles">
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Week</th>
                    <th scope="col">Month</th>
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
                <ul className="usage-chips" aria-label="Active policies">
                  {chips.map((chip) => (
                    <li key={chip.key} className={chip.tone} title={chip.title}>
                      {chip.label}
                    </li>
                  ))}
                </ul>
              )}
              {failed && (
                <p className="usage-note">Showing the last known numbers.</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function UsagePanel() {
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
      onToggle={() => {
        writeCollapsed(!collapsed);
        setCollapsed(!collapsed);
      }}
    />
  );
}
