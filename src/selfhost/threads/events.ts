import type {
  ApprovalAnswer,
  ApprovalChannel,
  PendingApproval,
} from '../approvals/broker.js';

export type SelfhostEvent =
  | { type: 'thread_updated'; threadId: string }
  | { type: 'run_finished'; threadId: string; runId: string }
  | { type: 'usage_updated' }
  /** The app is stopping: open event streams end so the server can close. */
  | { type: 'shutdown' }
  | { type: 'approval_requested'; approval: PendingApproval }
  | {
      type: 'approval_resolved';
      id: string;
      threadId: string;
      decision: ApprovalAnswer;
      by: ApprovalChannel;
    };

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
