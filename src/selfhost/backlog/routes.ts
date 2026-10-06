import { Hono } from 'hono';
import { z } from 'zod';
import { BacklogRefusedError, type BacklogRunner } from './runner.js';
import type { BacklogStore } from './store.js';

const createBody = z
  .object({
    threadId: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(3).max(4000),
  })
  .strict();

const NOT_FOUND = { error: 'Backlog item not found.' };

/** Mounted at `/api/selfhost/backlog`, behind upstream's owner-token middleware. */
export function backlogRoutes(options: {
  store: BacklogStore;
  runner: BacklogRunner;
  /** Throws when the thread does not exist. */
  requireThread: (threadId: string) => void;
}) {
  const { store, runner, requireThread } = options;
  const app = new Hono();

  app.get('/', (c) => c.json({ items: store.list() }));

  app.post('/', async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: 'Send a threadId and a prompt of 3–4000 characters.',
        },
        400,
      );
    try {
      requireThread(parsed.data.threadId);
    } catch {
      return c.json({ error: 'Conversation not found.' }, 404);
    }
    return c.json(store.add(parsed.data.threadId, parsed.data.prompt), 201);
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    if (!store.get(id)) return c.json(NOT_FOUND, 404);
    const item = store.cancel(id);
    if (!item)
      return c.json({ error: 'Only queued items can be cancelled.' }, 409);
    return c.json(item);
  });

  app.post('/:id/requeue', (c) => {
    const id = c.req.param('id');
    if (!store.get(id)) return c.json(NOT_FOUND, 404);
    const item = store.requeue(id);
    if (!item)
      return c.json(
        { error: 'Only failed or cancelled items can be queued again.' },
        409,
      );
    return c.json(item);
  });

  app.post('/:id/run', async (c) => {
    const id = c.req.param('id');
    if (!store.get(id)) return c.json(NOT_FOUND, 404);
    try {
      return c.json(runner.startNow(id), 202);
    } catch (error) {
      if (error instanceof BacklogRefusedError)
        return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  return app;
}
