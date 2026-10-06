import { policy, roles, type RoleName } from '../config/models.js';
import type { UsageMeter } from './meter.js';
import { localHour } from './windows.js';

export interface PolicyFlags {
  pauseEscalation: boolean;
  plannerUrgentOnly: boolean;
  stopBacklog: boolean;
  plannerOverWeekly: boolean;
  plannerReserved: boolean;
  advisorManualOnly: boolean;
  chatExhausted: boolean;
  /** Role to the epoch ms until which it is cooling down. */
  coolingDown: Partial<Record<RoleName, number>>;
  behindPace: boolean;
  backlogWindowOpen: boolean;
}

// Spend is a float sum, so a total that is exactly on a threshold can land a
// few ulps below it.
const EPSILON = 1e-9;
const reaches = (value: number, threshold: number) =>
  value >= threshold - EPSILON;
const exceeds = (value: number, threshold: number) =>
  value > threshold + EPSILON;

// The cool-down runs from the 429 that completed the burst, so the earlier 429s
// aging out of the burst window do not end it early; hence the 2x lookback.
function coolDownUntil(times: number[]): number | undefined {
  const count = policy.coolDownAfter429s;
  for (let i = times.length - 1; i >= count - 1; i--) {
    if (times[i] - times[i - count + 1] <= policy.coolDownMs) {
      return times[i] + policy.coolDownMs;
    }
  }
  return undefined;
}

export function evaluatePolicy(meter: UsageMeter, now?: number): PolicyFlags {
  const summary = meter.summary(now);
  const at = summary.at;
  const { fiveHour, week, month } = summary.windows;
  const { planner, escalation, chat } = summary.byRole;

  const coolingDown: Partial<Record<RoleName, number>> = {};
  for (const role of Object.keys(roles) as RoleName[]) {
    const times = meter.statusTimes(role, 429, at - 2 * policy.coolDownMs);
    const until = coolDownUntil(times);
    if (until !== undefined && until > at) coolingDown[role] = until;
  }

  const pauseEscalation = reaches(fiveHour.ratio, policy.fiveHourPauseRatio);
  const stopBacklog = reaches(week.ratio, policy.weekStopBacklogRatio);
  const { monthlyCapUSD } = roles.chat;
  const { weeklyTargetUSD } = roles.planner;
  const behindPace =
    summary.pace.dayOfMonth >= policy.behindPace.fromDay &&
    !reaches(month.usedUSD, policy.behindPace.monthBelowUSD);
  const hour = localHour(at);

  return {
    pauseEscalation,
    plannerUrgentOnly: pauseEscalation,
    stopBacklog,
    plannerOverWeekly:
      weeklyTargetUSD !== undefined &&
      exceeds(planner.weekUSD, weeklyTargetUSD),
    plannerReserved: reaches(planner.monthUSD, policy.plannerMonthlyReserveUSD),
    advisorManualOnly: reaches(
      escalation.monthUSD,
      policy.advisorMonthlyAutoUSD,
    ),
    chatExhausted:
      monthlyCapUSD !== undefined && reaches(chat.monthUSD, monthlyCapUSD),
    coolingDown,
    behindPace,
    backlogWindowOpen:
      behindPace &&
      !stopBacklog &&
      hour >= policy.backlogHours.from &&
      hour < policy.backlogHours.to,
  };
}

export function isCoolingDown(
  flags: PolicyFlags,
  role: RoleName,
  now: number,
): boolean {
  const until = flags.coolingDown[role];
  return until !== undefined && now < until;
}
