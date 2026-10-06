export type SelfhostEvent =
  | { type: 'thread_updated'; threadId: string }
  | { type: 'run_finished'; threadId: string; runId: string }
  | { type: 'usage_updated' };

/** In-process fan-out for the `/api/selfhost/events` stream. */
export class SelfhostEvents {
  private listeners = new Set<(event: SelfhostEvent) => void>();

  emit(event: SelfhostEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One broken stream must not stop delivery to the others.
      }
    }
  }

  subscribe(listener: (event: SelfhostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size() {
    return this.listeners.size;
  }
}
