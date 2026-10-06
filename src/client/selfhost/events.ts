// Live updates from `GET /api/selfhost/events` (Server-Sent Events).
//
// The stream is authenticated with the `Authorization` header, which
// `EventSource` cannot send, so this reads it with `fetch` and parses the
// frames itself. One connection is shared by every `useSelfhostEvents` caller
// and is closed when the last one unsubscribes.
import { useEffect, useRef } from 'react';
import { authHeaders } from '../api';

export type SelfhostClientEvent =
  | { type: 'thread_updated'; threadId: string }
  | { type: 'run_finished'; threadId: string; runId: string }
  | { type: 'usage_updated' }
  /**
   * The stream (re)connected. Events may have been missed while it was down, so
   * listeners that mirror server state should refetch.
   */
  | { type: 'ready' };

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Incremental parser for the `text/event-stream` format. Feed it decoded text
 * in any chunking; it returns the frames that were completed by that chunk.
 */
export class SseParser {
  private buffer = '';
  private started = false;
  private skipLF = false;
  private event = '';
  private data: string[] = [];
  private id: string | undefined;
  private retry: number | undefined;

  push(chunk: string): SseFrame[] {
    if (!this.started && chunk) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    if (this.skipLF && chunk) {
      this.skipLF = false;
      if (chunk.startsWith('\n')) chunk = chunk.slice(1);
    }
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (!match) break;
      // A CR that ends the chunk may be half of a CRLF; the LF is dropped later.
      if (match[0] === '\r' && match.index === this.buffer.length - 1)
        this.skipLF = true;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private line(line: string): SseFrame | undefined {
    if (line === '') {
      const frame: SseFrame | undefined = this.data.length
        ? {
            event: this.event || 'message',
            data: this.data.join('\n'),
            ...(this.id !== undefined && { id: this.id }),
            ...(this.retry !== undefined && { retry: this.retry }),
          }
        : undefined;
      this.event = '';
      this.data = [];
      return frame;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') {
      if (!value.includes('\0')) this.id = value;
    } else if (field === 'retry' && /^\d+$/.test(value))
      this.retry = Number(value);
    return undefined;
  }
}

/** Turns a frame into a typed event; `ready`, `ping` and unknown frames are not events. */
export function toClientEvent(
  frame: SseFrame,
): SelfhostClientEvent | undefined {
  if (frame.event === 'ready') return { type: 'ready' };
  if (
    frame.event !== 'thread_updated' &&
    frame.event !== 'run_finished' &&
    frame.event !== 'usage_updated'
  )
    return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { threadId, runId } = payload as Record<string, unknown>;
  if (frame.event === 'usage_updated') return { type: 'usage_updated' };
  if (typeof threadId !== 'string') return undefined;
  if (frame.event === 'thread_updated')
    return { type: 'thread_updated', threadId };
  return {
    type: 'run_finished',
    threadId,
    runId: typeof runId === 'string' ? runId : '',
  };
}

export interface EventHubOptions {
  url?: string;
  fetchFn?: typeof fetch;
  headers?: () => Record<string, string>;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** The server pings every ~25 s; silence for longer than this means a dead socket. */
  idleTimeoutMs?: number;
}

type Listener = (event: SelfhostClientEvent) => void;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class SelfhostEventHub {
  private listeners = new Set<Listener>();
  private abort?: AbortController;
  private options: Required<EventHubOptions>;

  constructor(options: EventHubOptions = {}) {
    this.options = {
      url: '/api/selfhost/events',
      fetchFn: (input, init) => fetch(input, init),
      headers: authHeaders,
      minDelayMs: 1000,
      maxDelayMs: 30_000,
      idleTimeoutMs: 75_000,
      ...options,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (!this.abort) {
      this.abort = new AbortController();
      void this.run(this.abort.signal);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.abort?.abort();
        this.abort = undefined;
      }
    };
  }

  get size() {
    return this.listeners.size;
  }

  private emit(event: SelfhostClientEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One broken listener must not stop delivery to the others.
      }
    }
  }

  private async run(signal: AbortSignal) {
    const { minDelayMs, maxDelayMs } = this.options;
    let delay = minDelayMs;
    while (!signal.aborted) {
      try {
        if (await this.connect(signal)) delay = minDelayMs;
      } catch {
        // Fall through to the backoff below.
      }
      if (signal.aborted) return;
      await sleep(delay, signal);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  /** Resolves true when the server accepted the stream, however it ended. */
  private async connect(signal: AbortSignal): Promise<boolean> {
    const { url, fetchFn, headers, idleTimeoutMs } = this.options;
    const connection = new AbortController();
    const abort = () => connection.abort();
    signal.addEventListener('abort', abort, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(abort, idleTimeoutMs);
    };
    try {
      arm();
      const response = await fetchFn(url, {
        headers: { ...headers(), Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: connection.signal,
      });
      if (!response.ok || !response.body) return false;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return true;
        arm();
        for (const frame of parser.push(
          decoder.decode(value, { stream: true }),
        )) {
          const event = toClientEvent(frame);
          if (event) this.emit(event);
        }
      }
    } finally {
      clearTimeout(idle);
      signal.removeEventListener('abort', abort);
    }
  }
}

let shared: SelfhostEventHub | undefined;
export function getSelfhostEventHub(): SelfhostEventHub {
  return (shared ??= new SelfhostEventHub());
}

/** Calls `onEvent` for every server event while `enabled`; one shared connection. */
export function useSelfhostEvents(
  enabled: boolean,
  onEvent: (event: SelfhostClientEvent) => void,
) {
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  useEffect(() => {
    if (!enabled) return;
    return getSelfhostEventHub().subscribe((event) => handler.current(event));
  }, [enabled]);
}

/**
 * When another device finishes a run in this thread, reconnect the agent so the
 * new messages appear. Skipped while this tab is mid-turn, and a burst of
 * events produces one reconnect.
 */
export function useReconnectOnRunFinished({
  enabled,
  threadId,
  running,
  reconnect,
  debounceMs = 400,
}: {
  enabled: boolean;
  threadId: string;
  running: boolean;
  reconnect: () => void;
  debounceMs?: number;
}) {
  const latest = useRef({ running, reconnect });
  useEffect(() => {
    latest.current = { running, reconnect };
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), [threadId]);
  useSelfhostEvents(enabled, (event) => {
    if (event.type !== 'run_finished' || event.threadId !== threadId) return;
    if (latest.current.running) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!latest.current.running) latest.current.reconnect();
    }, debounceMs);
  });
}
