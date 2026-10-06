import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BacklogRunner,
  type BacklogRunnerOptions,
} from '../../src/selfhost/backlog/runner.js';
import { backlogRoutes } from '../../src/selfhost/backlog/routes.js';
import { BacklogStore } from '../../src/selfhost/backlog/store.js';
import type { PolicyFlags } from '../../src/selfhost/usage/policy.js';

const flags = (overrides: Partial<PolicyFlags> = {}): PolicyFlags => ({
  pauseEscalation: false,
  plannerUrgentOnly: false,
  stopBacklog: false,
  plannerOverWeekly: false,
  plannerReserved: false,
  advisorManualOnly: false,
  chatExhausted: false,
  coolingDown: {},
  behindPace: true,
  backlogWindowOpen: true,
  ...overrides,
});

const dbs: DatabaseSync[] = [];
function open() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return db;
}

function openStore(start = 1_000) {
  let clock = start;
  const db = open();
  const store = new BacklogStore(db, () => clock++);
  return { db, store, tickClock: (to: number) => (clock = to) };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Turn = BacklogRunnerOptions['turn'];

function setup(
  options: Partial<Omit<BacklogRunnerOptions, 'store' | 'turn'>> = {},
  turn: Turn = async () => 'ok',
) {
  const { store, db } = openStore();
  const calls: Parameters<Turn>[] = [];
  const runner = new BacklogRunner({
    store,
    policy: () => flags(),
    paused: () => false,
    ...options,
    turn: (...args) => {
      calls.push(args);
      return turn(...args);
    },
  });
  return { store, db, runner, calls };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BacklogStore', () => {
  it('creates the table idempotently and adds queued items', () => {
    const { db, store } = openStore(5_000);
    new BacklogStore(db);
    const item = store.add('thread-1', 'Summarise the archive');
    expect(item).toMatchObject({
      threadId: 'thread-1',
      prompt: 'Summarise the archive',
      status: 'queued',
      attempts: 0,
      createdAt: 5_000,
      updatedAt: 5_000,
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    });
    expect(store.get(item.id)).toEqual(item);
    expect(store.get('missing')).toBeUndefined();
  });

  it('lists queued items oldest first, then the rest most recent first', () => {
    const { store } = openStore();
    const a = store.add('t', 'a-first');
    const b = store.add('t', 'b-second');
    const c = store.add('t', 'c-third');
    const d = store.add('t', 'd-fourth');
    expect(store.claimNext()?.id).toBe(a.id);
    store.finish(a.id, 'done');
    expect(store.cancel(b.id)?.status).toBe('cancelled');
    expect(store.list().map((item) => item.id)).toEqual([
      c.id,
      d.id,
      b.id,
      a.id,
    ]);
  });

  it('caps the list at 200 items', () => {
    const { store } = openStore();
    for (let i = 0; i < 205; i++) store.add('t', `task ${i}`);
    const items = store.list();
    expect(items).toHaveLength(200);
    expect(items[0].prompt).toBe('task 0');
  });

  it('claims the oldest queued item and never the same one twice', () => {
    const { db, store } = openStore();
    const first = store.add('t', 'first one');
    const second = store.add('t', 'second one');
    const other = new BacklogStore(db);

    const a = store.claimNext();
    const b = other.claimNext();
    expect(a).toMatchObject({ id: first.id, status: 'running', attempts: 1 });
    expect(a?.startedAt).toEqual(expect.any(Number));
    expect(b?.id).toBe(second.id);
    expect(store.claimNext()).toBeUndefined();
    expect(other.claimNext()).toBeUndefined();
  });

  it('breaks created_at ties by insertion order', () => {
    const db = open();
    const store = new BacklogStore(db, () => 42);
    const first = store.add('t', 'tie one');
    store.add('t', 'tie two');
    expect(store.claimNext()?.id).toBe(first.id);
  });

  it('claims a specific item only while it is queued', () => {
    const { store } = openStore();
    store.add('t', 'older one');
    const target = store.add('t', 'target one');
    expect(store.claim(target.id)).toMatchObject({
      id: target.id,
      status: 'running',
      attempts: 1,
    });
    expect(store.claim(target.id)).toBeUndefined();
    expect(store.claim('missing')).toBeUndefined();
  });

  it('cancels only queued items', () => {
    const { store } = openStore();
    const queued = store.add('t', 'to cancel');
    const running = store.add('t', 'to run');
    store.claim(running.id);

    const cancelled = store.cancel(queued.id);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(cancelled?.finishedAt).toEqual(expect.any(Number));
    expect(store.cancel(queued.id)).toBeUndefined();
    expect(store.cancel(running.id)).toBeUndefined();
    expect(store.get(running.id)?.status).toBe('running');
    expect(store.cancel('missing')).toBeUndefined();
  });

  it('requeues only failed or cancelled items and clears the old outcome', () => {
    const { store } = openStore();
    const failed = store.add('t', 'will fail');
    const cancelled = store.add('t', 'will cancel');
    const done = store.add('t', 'will finish');
    const queued = store.add('t', 'stays queued');
    store.claim(failed.id);
    store.fail(failed.id, 'boom');
    store.cancel(cancelled.id);
    store.claim(done.id);
    store.finish(done.id, 'fine');

    expect(store.requeue(failed.id)).toMatchObject({
      status: 'queued',
      error: null,
      result: null,
      startedAt: null,
      finishedAt: null,
      attempts: 1,
    });
    expect(store.requeue(cancelled.id)?.status).toBe('queued');
    expect(store.requeue(done.id)).toBeUndefined();
    expect(store.requeue(queued.id)).toBeUndefined();
    expect(store.get(done.id)?.status).toBe('done');
    expect(store.requeue('missing')).toBeUndefined();
  });

  it('truncates stored results to 20,000 and errors to 500 characters', () => {
    const { store } = openStore();
    const a = store.add('t', 'long result');
    const b = store.add('t', 'long error');
    store.claimNext();
    store.claimNext();
    expect(store.finish(a.id, 'x'.repeat(25_000))?.result).toHaveLength(20_000);
    expect(store.fail(b.id, 'e'.repeat(900))?.error).toHaveLength(500);
    expect(store.get(a.id)?.result).toHaveLength(20_000);
    expect(store.get(b.id)?.error).toHaveLength(500);
  });

  it('only settles a running item', () => {
    const { store } = openStore();
    const item = store.add('t', 'not claimed');
    expect(store.finish(item.id, 'late')).toBeUndefined();
    expect(store.fail(item.id, 'late')).toBeUndefined();
    expect(store.get(item.id)?.status).toBe('queued');
    store.claimNext();
    store.fail(item.id, 'first');
    expect(store.finish(item.id, 'late')).toBeUndefined();
    expect(store.get(item.id)).toMatchObject({
      status: 'failed',
      error: 'first',
    });
  });

  it('recovers running items back to the queue and keeps their attempts', () => {
    const { store } = openStore();
    const running = store.add('t', 'was running');
    const done = store.add('t', 'was done');
    store.add('t', 'was queued');
    store.claim(running.id);
    store.claim(done.id);
    store.finish(done.id, 'ok');

    expect(store.recoverInterrupted()).toBe(1);
    expect(store.get(running.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      startedAt: null,
    });
    expect(store.get(done.id)?.status).toBe('done');
    expect(store.recoverInterrupted()).toBe(0);
  });
});

describe('BacklogRunner', () => {
  it('skips while paused', async () => {
    const { store, runner, calls } = setup({ paused: () => true });
    store.add('t', 'waiting');
    await runner.tick();
    expect(calls).toHaveLength(0);
    expect(store.list()[0].status).toBe('queued');
  });

  it('skips while the window is closed', async () => {
    const { store, runner, calls } = setup({
      policy: () => flags({ backlogWindowOpen: false }),
    });
    store.add('t', 'waiting');
    await runner.tick();
    expect(calls).toHaveLength(0);
    expect(store.list()[0].status).toBe('queued');
  });

  it('does nothing when the queue is empty', async () => {
    const { runner, calls } = setup();
    await runner.tick();
    expect(calls).toHaveLength(0);
  });

  it('runs one item per tick on the worker with backlog metadata', async () => {
    const { store, runner, calls } = setup({}, async (_t, prompt) =>
      prompt.toUpperCase(),
    );
    const first = store.add('thread-a', 'first task');
    const second = store.add('thread-b', 'second task');

    await runner.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('thread-a');
    expect(calls[0][1]).toBe('first task');
    expect(calls[0][2]).toBeInstanceOf(AbortSignal);
    expect(calls[0][3]).toEqual({
      selfhostRole: 'worker',
      opendotsSource: 'backlog',
    });
    expect(store.get(first.id)).toMatchObject({
      status: 'done',
      result: 'FIRST TASK',
      attempts: 1,
    });
    expect(store.get(second.id)?.status).toBe('queued');

    await runner.tick();
    expect(calls).toHaveLength(2);
    expect(store.get(second.id)?.status).toBe('done');
  });

  it('never overlaps ticks while an item is running', async () => {
    const gate = deferred<string>();
    const { store, runner, calls } = setup({}, () => gate.promise);
    const first = store.add('t', 'long one');
    const second = store.add('t', 'next one');

    const running = runner.tick();
    await runner.tick();
    await runner.tick();
    expect(calls).toHaveLength(1);
    expect(store.get(first.id)?.status).toBe('running');
    expect(store.get(second.id)?.status).toBe('queued');

    gate.resolve('finished');
    await running;
    expect(store.get(first.id)).toMatchObject({
      status: 'done',
      result: 'finished',
    });
  });

  it('records failures with the error message only', async () => {
    const outcomes = [new Error('provider said no'), 'plain string'];
    const { store, runner } = setup({}, async () => {
      throw outcomes.shift();
    });
    const a = store.add('t', 'first fails');
    const b = store.add('t', 'second fails');
    await runner.tick();
    await runner.tick();
    expect(store.get(a.id)).toMatchObject({
      status: 'failed',
      error: 'provider said no',
    });
    expect(store.get(b.id)).toMatchObject({
      status: 'failed',
      error: 'Unexpected backlog failure.',
    });
  });

  it('does not throw out of tick and logs a fixed message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, runner, calls } = setup({
      policy: () => {
        throw new Error('secret database detail');
      },
    });
    store.add('t', 'private task text');
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0])).not.toContain('secret');
    expect(String(log.mock.calls[0])).not.toContain('private');
  });

  it('reports every status change through onChange', async () => {
    const onChange = vi.fn();
    const { store, runner } = setup({ onChange });
    store.add('t', 'notify me');
    await runner.tick();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('survives a throwing onChange listener', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, runner } = setup({
      onChange: () => {
        throw new Error('listener bug');
      },
    });
    const item = store.add('t', 'still runs');
    await runner.tick();
    expect(store.get(item.id)?.status).toBe('done');
  });

  it('stop() aborts the running item and marks it failed', async () => {
    const gate = deferred<string>();
    const seen: { signal?: AbortSignal } = {};
    const { store, runner } = setup({}, (_t, _p, signal) => {
      seen.signal = signal;
      signal.addEventListener('abort', () => gate.reject(signal.reason));
      return gate.promise;
    });
    const item = store.add('t', 'interrupted');
    const running = runner.tick();
    await Promise.resolve();
    expect(store.get(item.id)?.status).toBe('running');

    runner.stop();
    expect(seen.signal?.aborted).toBe(true);
    expect(store.get(item.id)).toMatchObject({
      status: 'failed',
      error: 'Server stopped during this run.',
    });
    await running;
    expect(store.get(item.id)?.error).toBe('Server stopped during this run.');
  });

  it('stop() wins even when the aborted turn still resolves', async () => {
    const gate = deferred<string>();
    const { store, runner } = setup({}, () => gate.promise);
    const item = store.add('t', 'ignores abort');
    const running = runner.tick();
    await Promise.resolve();
    runner.stop();
    gate.resolve('too late');
    await running;
    expect(store.get(item.id)).toMatchObject({
      status: 'failed',
      error: 'Server stopped during this run.',
      result: null,
    });
  });

  it('start() recovers interrupted items, ticks on an interval and stops cleanly', async () => {
    vi.useFakeTimers();
    const closed = { value: true };
    const { store, runner, calls } = setup({
      intervalMs: 1000,
      policy: () => flags({ backlogWindowOpen: !closed.value }),
    });
    const stale = store.add('t', 'left running');
    store.claim(stale.id);

    runner.start();
    runner.start();
    expect(store.get(stale.id)?.status).toBe('queued');
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toHaveLength(0);

    closed.value = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(store.get(stale.id)).toMatchObject({ status: 'done', attempts: 2 });

    store.add('t', 'after stop');
    runner.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);
  });

  describe('runNow', () => {
    it('runs the chosen queued item even outside the window', async () => {
      const { store, runner, calls } = setup({
        policy: () => flags({ backlogWindowOpen: false }),
      });
      store.add('t', 'older one');
      const target = store.add('t', 'run me');
      const item = await runner.runNow(target.id);
      expect(item).toMatchObject({
        id: target.id,
        status: 'done',
        result: 'ok',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toBe('run me');
      expect(calls[0][3]).toEqual({
        selfhostRole: 'worker',
        opendotsSource: 'backlog',
      });
    });

    it('returns a failed item instead of throwing when the turn fails', async () => {
      const { store, runner } = setup({}, async () => {
        throw new Error('model unavailable');
      });
      const target = store.add('t', 'doomed one');
      await expect(runner.runNow(target.id)).resolves.toMatchObject({
        status: 'failed',
        error: 'model unavailable',
      });
    });

    it('refuses while paused', async () => {
      const { store, runner, calls } = setup({ paused: () => true });
      const target = store.add('t', 'paused one');
      await expect(runner.runNow(target.id)).rejects.toThrow(/paused/i);
      expect(calls).toHaveLength(0);
      expect(store.get(target.id)?.status).toBe('queued');
    });

    it('refuses when weekly usage stops the backlog', async () => {
      const { store, runner, calls } = setup({
        policy: () => flags({ stopBacklog: true }),
      });
      const target = store.add('t', 'blocked one');
      await expect(runner.runNow(target.id)).rejects.toThrow(/stopped/i);
      expect(calls).toHaveLength(0);
    });

    it('refuses while another item is running', async () => {
      const gate = deferred<string>();
      const { store, runner } = setup({}, () => gate.promise);
      const first = store.add('t', 'long one');
      const second = store.add('t', 'impatient one');
      const running = runner.runNow(first.id);
      await expect(runner.runNow(second.id)).rejects.toThrow(
        /already running/i,
      );
      await expect(runner.tick()).resolves.toBeUndefined();
      expect(store.get(second.id)?.status).toBe('queued');
      gate.resolve('ok');
      await running;
    });

    it('refuses unknown and non-queued items', async () => {
      const { store, runner, calls } = setup();
      const done = store.add('t', 'already done');
      const cancelled = store.add('t', 'was cancelled');
      store.claim(done.id);
      store.finish(done.id, 'ok');
      store.cancel(cancelled.id);
      await expect(runner.runNow('missing')).rejects.toThrow(/not found/i);
      await expect(runner.runNow(done.id)).rejects.toThrow(/queued/i);
      await expect(runner.runNow(cancelled.id)).rejects.toThrow(/queued/i);
      expect(calls).toHaveLength(0);
    });
  });
});

describe('backlogRoutes', () => {
  function app(
    options: {
      requireThread?: (threadId: string) => void;
      paused?: () => boolean;
    } = {},
  ) {
    const ctx = setup({ paused: options.paused ?? (() => false) });
    const routes = backlogRoutes({
      store: ctx.store,
      runner: ctx.runner,
      requireThread:
        options.requireThread ??
        ((threadId) => {
          if (threadId !== 'thread-1') throw new Error('unknown thread');
        }),
    });
    const send = (path: string, method = 'GET', body?: unknown) =>
      routes.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body:
          body === undefined
            ? undefined
            : typeof body === 'string'
              ? body
              : JSON.stringify(body),
      });
    return { ...ctx, send };
  }

  it('lists items', async () => {
    const { store, send } = app();
    const item = store.add('thread-1', 'listed task');
    const response = await send('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [item] });
  });

  it('creates an item with a trimmed prompt', async () => {
    const { store, send } = app();
    const response = await send('/', 'POST', {
      threadId: 'thread-1',
      prompt: '  Compile the notes  ',
    });
    expect(response.status).toBe(201);
    const item = await response.json();
    expect(item).toMatchObject({
      threadId: 'thread-1',
      prompt: 'Compile the notes',
      status: 'queued',
    });
    expect(store.get(item.id)).toBeDefined();
  });

  it('rejects bad input with 400', async () => {
    const { store, send } = app();
    const bad: unknown[] = [
      { threadId: 'thread-1', prompt: 'hi' },
      { threadId: 'thread-1', prompt: '   a   ' },
      { threadId: 'thread-1', prompt: 'x'.repeat(4001) },
      { threadId: '', prompt: 'long enough' },
      { prompt: 'long enough' },
      { threadId: 'thread-1' },
      { threadId: 'thread-1', prompt: 'long enough', extra: true },
      { threadId: 1, prompt: 'long enough' },
      'not json',
      '[]',
    ];
    for (const body of bad) {
      const response = await send('/', 'POST', body);
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error');
    }
    expect(store.list()).toHaveLength(0);
  });

  it('accepts the 3 and 4000 character limits', async () => {
    const { send } = app();
    for (const prompt of ['abc', 'x'.repeat(4000)]) {
      const response = await send('/', 'POST', {
        threadId: 'thread-1',
        prompt,
      });
      expect(response.status).toBe(201);
    }
  });

  it('returns 404 when the thread does not exist', async () => {
    const { store, send } = app();
    const response = await send('/', 'POST', {
      threadId: 'nope',
      prompt: 'valid prompt',
    });
    expect(response.status).toBe(404);
    expect(store.list()).toHaveLength(0);
  });

  it('cancels a queued item, 404 for unknown and 409 for non-queued', async () => {
    const { store, send } = app();
    const queued = store.add('thread-1', 'cancel me');
    const running = store.add('thread-1', 'cannot cancel');
    store.claim(running.id);

    const ok = await send(`/${queued.id}`, 'DELETE');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'cancelled' });
    expect((await send(`/${queued.id}`, 'DELETE')).status).toBe(409);
    expect((await send(`/${running.id}`, 'DELETE')).status).toBe(409);
    expect((await send('/missing', 'DELETE')).status).toBe(404);
  });

  it('requeues a failed item, 404 for unknown and 409 for queued', async () => {
    const { store, send } = app();
    const failed = store.add('thread-1', 'retry me');
    const queued = store.add('thread-1', 'already queued');
    store.claim(failed.id);
    store.fail(failed.id, 'boom');

    const ok = await send(`/${failed.id}/requeue`, 'POST');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'queued', error: null });
    expect((await send(`/${queued.id}/requeue`, 'POST')).status).toBe(409);
    expect((await send('/missing/requeue', 'POST')).status).toBe(404);
  });

  it('runs an item now and maps refusals to 409', async () => {
    const { store, send, calls } = app();
    const target = store.add('thread-1', 'run it now');
    const response = await send(`/${target.id}/run`, 'POST');
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      id: target.id,
      status: 'running',
    });
    await expect
      .poll(() => store.get(target.id))
      .toMatchObject({ status: 'done', result: 'ok' });
    expect(calls).toHaveLength(1);

    const again = await send(`/${target.id}/run`, 'POST');
    expect(again.status).toBe(409);
    expect(await again.json()).toHaveProperty('error');
    expect((await send('/missing/run', 'POST')).status).toBe(404);
  });

  it('returns 409 with an error when the runner is paused', async () => {
    const { store, send, calls } = app({ paused: () => true });
    const target = store.add('thread-1', 'held back');
    const response = await send(`/${target.id}/run`, 'POST');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Background work is paused.',
    });
    expect(calls).toHaveLength(0);
  });
});
