import type { PolicyFlags } from '../usage/policy.js';
import type { BacklogItem, BacklogStore } from './store.js';

export interface BacklogRunnerOptions {
  store: BacklogStore;
  policy: () => PolicyFlags;
  turn: (
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata: Record<string, unknown>,
  ) => Promise<string>;
  /** Upstream `Settings.paused`. */
  paused: () => boolean;
  /** Default 60_000. */
  intervalMs?: number;
  /** Called after any status change. */
  onChange?: () => void;
}

/** A refusal the owner can act on, as opposed to a store or runtime failure. */
export class BacklogRefusedError extends Error {}

// The router sends this to the worker model.
const METADATA = { selfhostRole: 'worker', opendotsSource: 'backlog' } as const;

const STOPPED_MESSAGE = 'Server stopped during this run.';

/** Runs queued backlog items one at a time while the nightly window is open. */
export class BacklogRunner {
  private timer?: ReturnType<typeof setInterval>;
  private active?: { id: string; controller: AbortController };

  constructor(private options: BacklogRunnerOptions) {}

  start() {
    if (this.timer) return;
    try {
      this.options.store.recoverInterrupted();
      this.changed();
    } catch {
      console.error('Backlog recovery failed; interrupted items stay as is.');
    }
    this.timer = setInterval(
      () => void this.tick(),
      this.options.intervalMs ?? 60_000,
    );
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    const active = this.active;
    if (!active) return;
    // Settle the row synchronously: the process may exit right after stop(),
    // and the aborted turn is not guaranteed to reject with a useful message.
    try {
      this.options.store.fail(active.id, STOPPED_MESSAGE);
    } catch {
      console.error('Backlog stop could not update the running item.');
    }
    active.controller.abort(new Error(STOPPED_MESSAGE));
    this.changed();
  }

  async tick() {
    try {
      if (this.active || this.options.paused()) return;
      if (!this.options.policy().backlogWindowOpen) return;
      const item = this.options.store.claimNext();
      if (item) await this.run(item);
    } catch {
      // Store and policy errors must not become unhandled interval rejections.
      // Do not log task content, provider responses, or database details.
      console.error('Backlog runner tick failed; will retry on the next tick.');
    }
  }

  /** Owner-triggered; works outside the nightly window but never past a stop. */
  async runNow(id: string): Promise<BacklogItem> {
    return this.run(this.claimForOwner(id));
  }

  /**
   * Like runNow, but returns the claimed item at once and lets the turn run in
   * the background, so an HTTP request behind a tunnel does not wait minutes.
   */
  startNow(id: string): BacklogItem {
    const claimed = this.claimForOwner(id);
    void this.run(claimed);
    return claimed;
  }

  private claimForOwner(id: string): BacklogItem {
    if (this.options.paused())
      throw new BacklogRefusedError('Background work is paused.');
    if (this.options.policy().stopBacklog)
      throw new BacklogRefusedError(
        'Backlog is stopped because weekly usage is high.',
      );
    if (this.active)
      throw new BacklogRefusedError('Another backlog item is already running.');
    const item = this.options.store.get(id);
    if (!item) throw new BacklogRefusedError('Backlog item not found.');
    const claimed = this.options.store.claim(id);
    if (!claimed)
      throw new BacklogRefusedError('Only queued items can be run.');
    return claimed;
  }

  private async run(item: BacklogItem): Promise<BacklogItem> {
    const controller = new AbortController();
    this.active = { id: item.id, controller };
    this.changed();
    try {
      const result = await this.options.turn(
        item.threadId,
        item.prompt,
        controller.signal,
        { ...METADATA },
      );
      controller.signal.throwIfAborted();
      this.options.store.finish(
        item.id,
        typeof result === 'string' ? result : '',
      );
    } catch (error) {
      this.options.store.fail(
        item.id,
        error instanceof Error ? error.message : 'Unexpected backlog failure.',
      );
    } finally {
      this.active = undefined;
      this.changed();
    }
    return this.options.store.get(item.id) ?? item;
  }

  private changed() {
    try {
      this.options.onChange?.();
    } catch {
      console.error('Backlog change listener failed.');
    }
  }
}
