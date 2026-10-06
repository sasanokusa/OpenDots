import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({ Authorization: 'Bearer test' }),
}));
import {
  SelfhostEventHub,
  SseParser,
  toClientEvent,
  useReconnectOnRunFinished,
  type SelfhostClientEvent,
} from '../../src/client/selfhost/events';

function parseAll(chunks: string[]) {
  const parser = new SseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

describe('SseParser', () => {
  it('parses a named frame with a JSON payload', () => {
    expect(
      parseAll(['event: thread_updated\ndata: {"threadId":"t1"}\n\n']),
    ).toEqual([{ event: 'thread_updated', data: '{"threadId":"t1"}' }]);
  });

  it('gives the same frames however the stream is chunked', () => {
    const text =
      'event: ready\ndata: {}\n\nevent: run_finished\ndata: {"threadId":"a","runId":"b"}\n\n';
    const whole = parseAll([text]);
    expect(whole).toHaveLength(2);
    expect(parseAll([...text])).toEqual(whole);
    for (let cut = 1; cut < text.length; cut++)
      expect(parseAll([text.slice(0, cut), text.slice(cut)])).toEqual(whole);
  });

  it('holds a frame back until its blank line arrives', () => {
    const parser = new SseParser();
    expect(parser.push('event: usage_updated\ndata: {}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'usage_updated', data: '{}' }]);
  });

  it('joins multi-line data with newlines', () => {
    expect(parseAll(['data: one\ndata: two\ndata:\ndata: four\n\n'])).toEqual([
      { event: 'message', data: 'one\ntwo\n\nfour' },
    ]);
  });

  it('parses ping frames and ignores comment lines', () => {
    expect(
      parseAll([': hello\n\n', 'event: ping\ndata: {}\n\n', ': again\n']),
    ).toEqual([{ event: 'ping', data: '{}' }]);
  });

  it('accepts CRLF and CR line endings, even split across chunks', () => {
    expect(parseAll(['event: a\r\ndata: 1\r\n\r\n'])).toEqual([
      { event: 'a', data: '1' },
    ]);
    expect(parseAll(['event: a\rdata: 2\r\r'])).toEqual([
      { event: 'a', data: '2' },
    ]);
    expect(parseAll(['event: a\r', '\ndata: 3\r', '\n\r', '\n'])).toEqual([
      { event: 'a', data: '3' },
    ]);
  });

  it('handles fields without a space, without a colon, and with colons in the value', () => {
    expect(
      parseAll(['event:x\ndata:{"a":"b:c"}\nid: 7\nretry: 1500\n\n']),
    ).toEqual([{ event: 'x', data: '{"a":"b:c"}', id: '7', retry: 1500 }]);
    expect(parseAll(['data\n\n'])).toEqual([{ event: 'message', data: '' }]);
  });

  it('drops a leading byte order mark and frames without data', () => {
    expect(parseAll(['﻿event: a\ndata: 1\n\n', 'event: b\n\n'])).toEqual([
      { event: 'a', data: '1' },
    ]);
  });

  it('does not leak the event name into the next frame', () => {
    expect(parseAll(['event: a\ndata: 1\n\ndata: 2\n\n'])).toEqual([
      { event: 'a', data: '1' },
      { event: 'message', data: '2' },
    ]);
  });
});

describe('toClientEvent', () => {
  it('maps the server events', () => {
    expect(
      toClientEvent({
        event: 'thread_updated',
        data: '{"type":"thread_updated","threadId":"t1"}',
      }),
    ).toEqual({ type: 'thread_updated', threadId: 't1' });
    expect(
      toClientEvent({
        event: 'run_finished',
        data: '{"type":"run_finished","threadId":"t1","runId":"r1"}',
      }),
    ).toEqual({ type: 'run_finished', threadId: 't1', runId: 'r1' });
    expect(toClientEvent({ event: 'usage_updated', data: '{}' })).toEqual({
      type: 'usage_updated',
    });
    expect(toClientEvent({ event: 'ready', data: '{}' })).toEqual({
      type: 'ready',
    });
  });

  it('ignores pings, unknown events, bad JSON and incomplete payloads', () => {
    expect(toClientEvent({ event: 'ping', data: '{}' })).toBeUndefined();
    expect(toClientEvent({ event: 'other', data: '{}' })).toBeUndefined();
    expect(toClientEvent({ event: 'run_finished', data: '{' })).toBeUndefined();
    expect(
      toClientEvent({ event: 'run_finished', data: 'null' }),
    ).toBeUndefined();
    expect(
      toClientEvent({ event: 'thread_updated', data: '{"x":1}' }),
    ).toBeUndefined();
  });
});

const encoder = new TextEncoder();
interface FakeStream {
  signal: AbortSignal;
  headers: Record<string, string>;
  push(text: string): void;
  end(): void;
}
/** A fetch double whose responses are streams the test controls. */
function fakeFetch(
  plan: (attempt: number) => 'ok' | 'fail' | Error = () => 'ok',
) {
  const streams: FakeStream[] = [];
  let attempts = 0;
  const times: number[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    times.push(Date.now());
    const outcome = plan(attempts++);
    if (outcome instanceof Error) throw outcome;
    if (outcome === 'fail') return new Response('nope', { status: 503 });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    const signal = init!.signal!;
    signal.addEventListener('abort', () =>
      controller.error(new DOMException('aborted', 'AbortError')),
    );
    streams.push({
      signal,
      headers: init!.headers as Record<string, string>,
      push: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
    });
    return new Response(body, { status: 200 });
  });
  return {
    fetchFn: fetchFn as unknown as typeof fetch,
    calls: fetchFn,
    streams,
    times,
  };
}

describe('SelfhostEventHub', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('authenticates with headers and delivers typed events, skipping pings', async () => {
    const fake = fakeFetch();
    const hub = new SelfhostEventHub({
      fetchFn: fake.fetchFn,
      headers: () => ({ Authorization: 'Bearer abc' }),
    });
    const seen: SelfhostClientEvent[] = [];
    const stop = hub.subscribe((event) => seen.push(event));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toHaveBeenCalledTimes(1);
    expect(fake.calls.mock.calls[0][0]).toBe('/api/selfhost/events');
    expect(fake.streams[0].headers).toMatchObject({
      Authorization: 'Bearer abc',
      Accept: 'text/event-stream',
    });
    fake.streams[0].push('event: ready\ndata: {}\n\nevent: pi');
    fake.streams[0].push(
      'ng\ndata: {}\n\nevent: run_finished\ndata: {"type":"run_fin',
    );
    fake.streams[0].push('ished","threadId":"t1","runId":"r1"}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([
      { type: 'ready' },
      { type: 'run_finished', threadId: 't1', runId: 'r1' },
    ]);
    stop();
  });

  it('shares one connection and closes it when the last listener leaves', async () => {
    const fake = fakeFetch();
    const hub = new SelfhostEventHub({ fetchFn: fake.fetchFn });
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = hub.subscribe(first);
    const stopSecond = hub.subscribe(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toHaveBeenCalledTimes(1);
    fake.streams[0].push('event: usage_updated\ndata: {}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    expect(fake.streams[0].signal.aborted).toBe(false);
    stopSecond();
    expect(fake.streams[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.calls).toHaveBeenCalledTimes(1);
  });

  it('backs off 1s, 2s, 4s ... up to 30s while the server is unavailable', async () => {
    const fake = fakeFetch((attempt) =>
      attempt % 2 ? new Error('offline') : 'fail',
    );
    const hub = new SelfhostEventHub({ fetchFn: fake.fetchFn });
    const stop = hub.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    for (const wait of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      const before = fake.calls.mock.calls.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(fake.calls.mock.calls.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.calls.mock.calls.length).toBe(before + 1);
    }
    stop();
  });

  it('starts the backoff over after a connection that worked', async () => {
    const fake = fakeFetch((attempt) => (attempt < 3 ? 'fail' : 'ok'));
    const hub = new SelfhostEventHub({ fetchFn: fake.fetchFn });
    const seen: SelfhostClientEvent[] = [];
    const stop = hub.subscribe((event) => seen.push(event));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(fake.streams).toHaveLength(1);
    fake.streams[0].push('event: ready\ndata: {}\n\n');
    fake.streams[0].end();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ type: 'ready' }]);
    const before = fake.calls.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls.mock.calls.length).toBe(before + 1);
    expect(fake.streams).toHaveLength(2);
    stop();
  });

  it('reconnects when the stream goes silent past the idle timeout', async () => {
    const fake = fakeFetch();
    const hub = new SelfhostEventHub({
      fetchFn: fake.fetchFn,
      idleTimeoutMs: 5000,
    });
    const stop = hub.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000);
    fake.streams[0].push('event: ping\ndata: {}\n\n');
    await vi.advanceTimersByTimeAsync(4000);
    expect(fake.streams[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(fake.streams[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.streams).toHaveLength(2);
    stop();
  });

  it('keeps delivering when one listener throws', async () => {
    const fake = fakeFetch();
    const hub = new SelfhostEventHub({ fetchFn: fake.fetchFn });
    const good = vi.fn();
    const stopBad = hub.subscribe(() => {
      throw new Error('boom');
    });
    const stopGood = hub.subscribe(good);
    await vi.advanceTimersByTimeAsync(0);
    fake.streams[0].push('event: usage_updated\ndata: {}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(good).toHaveBeenCalledTimes(1);
    stopBad();
    stopGood();
  });
});

describe('useReconnectOnRunFinished', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount(props: { running: boolean; enabled?: boolean }) {
    const fake = fakeFetch();
    vi.stubGlobal('fetch', fake.fetchFn);
    const reconnect = vi.fn();
    function Probe(p: { running: boolean; enabled: boolean }) {
      useReconnectOnRunFinished({
        enabled: p.enabled,
        threadId: 't1',
        running: p.running,
        reconnect,
      });
      return null;
    }
    const element = (running: boolean) =>
      createElement(Probe, { running, enabled: props.enabled ?? true });
    const root = create(element(props.running));
    return {
      fake,
      reconnect,
      root,
      rerender: (running: boolean) => root.update(element(running)),
    };
  }
  const finished = (threadId: string) =>
    `event: run_finished\ndata: {"type":"run_finished","threadId":"${threadId}","runId":"r"}\n\n`;

  it('reconnects once for a burst of finished runs on this thread', async () => {
    const { fake, reconnect, root } = mount({ running: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fake.streams).toHaveLength(1);
    await act(async () => {
      fake.streams[0].push(finished('t1') + finished('t1') + finished('t1'));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(reconnect).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(reconnect).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('ignores other threads, other events and a tab that is mid-turn', async () => {
    const { fake, reconnect, root, rerender } = mount({ running: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fake.streams[0].push(finished('t1'));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(reconnect).not.toHaveBeenCalled();
    await act(async () => rerender(false));
    await act(async () => {
      fake.streams[0].push(
        finished('other') +
          'event: thread_updated\ndata: {"type":"thread_updated","threadId":"t1"}\n\n',
      );
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(reconnect).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('drops a pending reconnect if this tab starts a turn first', async () => {
    const { fake, reconnect, root, rerender } = mount({ running: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fake.streams[0].push(finished('t1'));
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(async () => rerender(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(reconnect).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('opens no connection when disabled', async () => {
    const { fake, root } = mount({ running: false, enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fake.calls).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
