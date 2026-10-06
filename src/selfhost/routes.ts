import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { SelfhostBackend } from './index.js';
import type { SelfhostEvent } from './threads/events.js';
import { evaluatePolicy } from './usage/policy.js';

const threadPatch = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.archived !== undefined);

/** Mounted at `/api/selfhost`, behind upstream's owner-token middleware. */
export function selfhostRoutes(
  backend: SelfhostBackend,
  options: { heartbeatMs?: number } = {},
) {
  const app = new Hono();
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
