import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { SelfhostBackend } from './index.js';
import type { SelfhostEvent } from './threads/events.js';
import { evaluatePolicy } from './usage/policy.js';
import { backlogRoutes } from './backlog/routes.js';
import { limits } from './config/models.js';
import { SESSION_WINDOWS, type SessionWindow } from './usage/windows.js';

/** Parses CommandCode's "Resets in 1d 15h" style durations. */
export function parseResetsIn(text: string): number | undefined {
  const units = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;
  let total = 0;
  let matched = '';
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhm])/gi)) {
    total +=
      Number(match[1]) * units[match[2].toLowerCase() as keyof typeof units];
    matched += match[0];
  }
  const rest = text
    .replace(/(\d+(?:\.\d+)?)\s*([dhm])/gi, '')
    .replace(/resets|in|\s/gi, '');
  return matched && !rest ? total : undefined;
}

const sessionObservation = z
  .object({
    percent: z.number().min(0).max(100),
    resetsAt: z.iso.datetime({ offset: true }).optional(),
    resetsIn: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
const observedBody = z
  .object({
    fiveHour: sessionObservation.optional(),
    week: sessionObservation.optional(),
    month: z
      .object({ percent: z.number().min(0).max(100) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.fiveHour || value.week || value.month);

const threadPatch = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.archived !== undefined);
const calibration = z
  .object({
    model: z.string().min(1).max(200),
    factor: z.number().positive().max(10),
  })
  .strict();

/** Mounted at `/api/selfhost`, behind upstream's owner-token middleware. */
export function selfhostRoutes(
  backend: SelfhostBackend,
  options: { heartbeatMs?: number } = {},
) {
  const app = new Hono();
  if (backend.backlog)
    app.route(
      '/backlog',
      backlogRoutes({
        ...backend.backlog,
        requireThread: (threadId) => backend.workspace.requireThread(threadId),
      }),
    );
  app.get('/threads', (c) =>
    c.json({
      threads: backend.threads.records({
        includeArchived: c.req.query('includeArchived') === 'true',
      }),
    }),
  );
  app.patch('/threads/:id', async (c) => {
    const parsed = threadPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Send a name (1–80 characters) or archived.' },
        400,
      );
    const id = c.req.param('id');
    try {
      if (parsed.data.name !== undefined)
        backend.threads.rename(id, parsed.data.name);
      if (parsed.data.archived !== undefined)
        backend.threads.archive(id, parsed.data.archived);
    } catch {
      return c.json({ error: 'Conversation not found.' }, 404);
    }
    return c.json(
      backend.threads
        .records({ includeArchived: true })
        .find((thread) => thread.id === id),
    );
  });
  app.get('/usage', (c) =>
    c.json({
      summary: backend.meter.summary(),
      policy: evaluatePolicy(backend.meter),
    }),
  );
  app.get('/usage/calibration', (c) => c.json(backend.meter.calibration()));
  app.put('/usage/calibration', async (c) => {
    const parsed = calibration.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Send a model and a factor between 0 and 10.' },
        400,
      );
    backend.meter.setCalibration(parsed.data.model, parsed.data.factor);
    backend.events.emit({ type: 'usage_updated' });
    return c.json(backend.meter.calibration());
  });
  app.get('/usage/observed', (c) =>
    c.json({ observations: backend.meter.observations() }),
  );
  app.put('/usage/observed', async (c) => {
    const parsed = observedBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Send percent (0–100) per window, with resetsIn or resetsAt for open 5-hour and weekly windows.',
        },
        400,
      );
    const now = Date.now();
    const plans: [
      SessionWindow,
      { usedUSD: number; windowStart: number | null },
    ][] = [];
    for (const window of ['fiveHour', 'week'] as const) {
      const value = parsed.data[window];
      if (!value) continue;
      const limit = window === 'fiveHour' ? limits.fiveHourUSD : limits.weekUSD;
      const resetsAt = value.resetsAt
        ? Date.parse(value.resetsAt)
        : value.resetsIn !== undefined
          ? (() => {
              const inMs = parseResetsIn(value.resetsIn);
              return inMs === undefined ? Number.NaN : now + inMs;
            })()
          : undefined;
      if (resetsAt === undefined) {
        if (value.percent > 0)
          return c.json(
            { error: `${window}: an open window needs resetsIn or resetsAt.` },
            400,
          );
        plans.push([window, { usedUSD: 0, windowStart: null }]);
        continue;
      }
      const windowStart = resetsAt - SESSION_WINDOWS[window];
      if (!Number.isFinite(resetsAt) || resetsAt <= now || windowStart > now)
        return c.json(
          {
            error: `${window}: the reset time must fall within the window length from now.`,
          },
          400,
        );
      plans.push([
        window,
        { usedUSD: (value.percent / 100) * limit, windowStart },
      ]);
    }
    for (const [window, observation] of plans)
      backend.meter.observe(window, observation, now);
    if (parsed.data.month)
      backend.meter.observe(
        'month',
        {
          usedUSD: (parsed.data.month.percent / 100) * limits.monthUSD,
          windowStart: null,
        },
        now,
      );
    backend.events.emit({ type: 'usage_updated' });
    return c.json({ observations: backend.meter.observations() });
  });
  app.get('/approvals', (c) =>
    c.json({
      approvals: backend.approvals.pending(
        c.req.query('threadId') || undefined,
      ),
    }),
  );
  app.post('/approvals/:id', async (c) => {
    const body = z
      .object({ decision: z.enum(['allow', 'deny']) })
      .strict()
      .safeParse(await c.req.json().catch(() => undefined));
    if (!body.success)
      return c.json({ error: 'decision must be allow or deny.' }, 400);
    return backend.approvals.resolve(
      c.req.param('id'),
      body.data.decision,
      'web',
    )
      ? c.json({ ok: true })
      : c.json({ error: 'This approval request has already closed.' }, 409);
  });
  app.get('/decisions', (c) => {
    const limit = Math.min(
      Math.max(Number(c.req.query('limit')) || 100, 1),
      1000,
    );
    return c.json({ decisions: backend.decisions.recent(limit) });
  });
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: SelfhostEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = backend.events.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      const heartbeat = setInterval(
        () => wake?.(),
        options.heartbeatMs ?? 25_000,
      );
      stream.onAbort(() => {
        unsubscribe();
        clearInterval(heartbeat);
        wake?.();
      });
      try {
        await stream.writeSSE({ event: 'ready', data: '{}' });
        while (!stream.aborted) {
          if (!queue.length) {
            await new Promise<void>((resolve) => (wake = resolve));
            wake = undefined;
            if (!queue.length && !stream.aborted)
              await stream.writeSSE({ event: 'ping', data: '{}' });
            continue;
          }
          const event = queue.shift()!;
          if (event.type === 'shutdown') break;
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        }
      } finally {
        unsubscribe();
        clearInterval(heartbeat);
      }
    }),
  );
  return app;
}
