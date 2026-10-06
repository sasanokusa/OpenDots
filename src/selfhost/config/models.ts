// Role → model mapping and every tunable number for the self-hosted fork.
// Swap models or thresholds here; no other file should hard-code them.

export type RoleName = 'router' | 'chat' | 'planner' | 'worker' | 'escalation';
export type ApiKind = 'systemone' | 'chat' | 'messages';
export type TurnRole = Exclude<RoleName, 'router' | 'escalation'>;

export interface RoleConfig {
  model: string;
  api: ApiKind;
  monthlyCapUSD?: number;
  weeklyTargetUSD?: number;
  fallback?: RoleName;
  maxParallel?: number;
  maxOutputTokens?: number;
  maxIterations?: number;
}

export const roles: Record<RoleName, RoleConfig> = {
  router: { model: 'typesafe/jev', api: 'systemone' },
  chat: {
    model: 'xiaomi/mimo-v2.6-flash',
    api: 'chat',
    monthlyCapUSD: 20,
    weeklyTargetUSD: 2.5,
    fallback: 'worker',
    maxOutputTokens: 4000,
    maxIterations: 8,
  },
  planner: {
    model: 'xiaomi/mimo-v2.6-pro',
    api: 'chat',
    monthlyCapUSD: 20,
    weeklyTargetUSD: 3.75,
    fallback: 'chat',
    maxOutputTokens: 8000,
    maxIterations: 12,
  },
  worker: {
    model: 'deepseek/deepseek-v4.1-flash',
    api: 'chat',
    monthlyCapUSD: 60,
    weeklyTargetUSD: 9,
    maxParallel: 3,
    maxOutputTokens: 8000,
    maxIterations: 20,
  },
  escalation: {
    model: 'claude-sonnet-5-5',
    api: 'messages',
    monthlyCapUSD: 10,
    weeklyTargetUSD: 2,
    fallback: 'planner',
    maxOutputTokens: 8000,
  },
};

/** USD per one million tokens. Initial values from OpenRouter; calibrate weekly. */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
}
export const prices: Record<string, ModelPrice> = {
  'typesafe/jev': { inputPerM: 0.042, outputPerM: 0 },
  'xiaomi/mimo-v2.6-flash': {
    inputPerM: 0.14,
    outputPerM: 0.28,
    cacheReadPerM: 0.0028,
  },
  'xiaomi/mimo-v2.6-pro': {
    inputPerM: 0.435,
    outputPerM: 0.87,
    cacheReadPerM: 0.0036,
  },
  'deepseek/deepseek-v4.1-flash': {
    inputPerM: 0.0214,
    outputPerM: 1.32,
    cacheReadPerM: 0.0165,
  },
  'claude-sonnet-5-5': { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 },
};

/** CommandCode GOAT limits. Each window resets independently. */
export const limits = { fiveHourUSD: 14, weekUSD: 35, monthUSD: 70 };

export const routing = {
  minConfidence: 0.6,
  highImpact: 0.7,
  jevTimeoutMs: 3000,
  /** Used when Jev is unavailable. */
  fallbackRule: { plannerMinChars: 600, plannerMinSteps: 3 },
  /** Planner needs this confidence while plannerOverWeekly is set. */
  plannerOverWeeklyMinConfidence: 0.8,
};

export const handover = {
  maxPerTask: 1,
  forceOnSubtasks: 3,
  workerFailures: 2,
  ticketMaxChars: 24_000,
};

export const escalation = {
  maxPerDay: 3,
  maxPerTask: 2,
  ticketMaxChars: 60_000,
};

export const turn = {
  timeLimitMs: 600_000,
  subtaskTimeLimitMs: 300_000,
  subtaskOutputMaxChars: 6000,
};

/** Thresholds for usage/policy.ts. Fractions are of the window limit. */
export const policy = {
  fiveHourPauseRatio: 0.8,
  weekStopBacklogRatio: 0.8,
  plannerMonthlyReserveUSD: 18,
  advisorMonthlyAutoUSD: 8,
  coolDownMs: 10 * 60_000,
  coolDownAfter429s: 2,
  behindPace: { fromDay: 21, monthBelowUSD: 50 },
  backlogHours: { from: 1, to: 7 },
  idealDailyUSD: 70 / 30,
};

export const timeZone = 'Asia/Tokyo';
