import { randomUUID } from 'node:crypto';
import type { SelfhostEvents } from '../threads/events.js';

export type ApprovalAnswer = 'allow' | 'deny';
export type ApprovalChannel = 'web' | 'discord' | 'timeout' | 'cancelled';

export interface ApprovalRequest {
  threadId: string;
  dotId: string;
  tool: string;
  args: unknown;
  reason: string;
}

/** What the owner sees: the tool, one line saying what it would do, and why it asks. */
export interface PendingApproval {
  id: string;
  threadId: string;
  dotId: string;
  tool: string;
  summary: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

export interface ApprovalDecision {
  decision: ApprovalAnswer;
  feedback?: string;
}

const SUMMARY_MAX = 600;

export function summarize(tool: string, args: unknown): string {
  const record =
    args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const pick = (key: string) =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined;
  const text =
    pick('command') ??
    pick('path') ??
    pick('file_path') ??
    pick('url') ??
    JSON.stringify(args ?? {});
  return `${tool}: ${text}`.slice(0, SUMMARY_MAX);
}

const NOT_LISTED = 'Not on the list of actions that run without asking.';

/** sasacode's internal reason ("mode edits", "rule ask: …") as a sentence. */
export function explainReason(reason: string): string {
  if (/^mode (edits|ask)\b/.test(reason)) return NOT_LISTED;
  const rule = /^rule ask: (.+)$/s.exec(reason);
  if (rule) return `A permission rule asks first: ${rule[1]}.`;
  const path = /^cannot resolve (.+)$/s.exec(reason);
  if (path) return `The path could not be checked: ${path[1]}.`;
  const risky = /^agent judged risky: (.+)$/s.exec(reason);
  if (risky) return `The safety check judged this risky: ${risky[1]}`;
  const failed = /^judge failed: (.+)$/s.exec(reason);
  if (failed) return `The safety check failed: ${failed[1]}`;
  return reason;
}

/** The same sentences in Japanese, for the Discord DM. */
export function japaneseReason(reason: string): string {
  if (reason === NOT_LISTED)
    return '確認なしで実行できる操作の一覧に入っていません。';
  const rule = /^A permission rule asks first: (.+)\.$/s.exec(reason);
  if (rule) return `権限ルールで確認が必要です: ${rule[1]}`;
  const path = /^The path could not be checked: (.+)\.$/s.exec(reason);
  if (path) return `パスを確認できませんでした: ${path[1]}`;
  const risky = /^The safety check judged this risky: (.+)$/s.exec(reason);
  if (risky) return `安全チェックで危険と判断されました: ${risky[1]}`;
  const failed = /^The safety check failed: (.+)$/s.exec(reason);
  if (failed) return `安全チェックに失敗しました: ${failed[1]}`;
  return reason;
}

interface Waiter {
  approval: PendingApproval;
  settle: (decision: ApprovalDecision, by: ApprovalChannel) => void;
}

/**
 * Pending owner approvals for sasacode tool calls. The web app and the Discord
 * DM both see each request; the first answer wins and the other is told.
 * Unanswered requests are refused when they expire or the run stops.
 */
export class ApprovalBroker {
  readonly #waiting = new Map<string, Waiter>();
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(
    private events: SelfhostEvents,
    options: { now?: () => number; timeoutMs?: number } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 5 * 60_000;
  }

  request(
    request: ApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    const createdAt = this.#now();
    const approval: PendingApproval = {
      id: randomUUID(),
      threadId: request.threadId,
      dotId: request.dotId,
      tool: request.tool,
      summary: summarize(request.tool, request.args),
      reason: explainReason(request.reason),
      createdAt,
      expiresAt: createdAt + this.#timeoutMs,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          settle(
            {
              decision: 'deny',
              feedback:
                'The owner did not answer the approval request in time. Do not retry; tell the owner what you wanted to do.',
            },
            'timeout',
          ),
        this.#timeoutMs,
      );
      const onAbort = () =>
        settle(
          { decision: 'deny', feedback: 'The run was stopped.' },
          'cancelled',
        );
      const settle = (decision: ApprovalDecision, by: ApprovalChannel) => {
        if (!this.#waiting.delete(approval.id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.events.emit({
          type: 'approval_resolved',
          id: approval.id,
          threadId: approval.threadId,
          decision: decision.decision,
          by,
        });
        resolve(decision);
      };
      this.#waiting.set(approval.id, { approval, settle });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.events.emit({ type: 'approval_requested', approval });
    });
  }

  /** The owner's answer. False when the request is gone (answered or expired). */
  resolve(id: string, decision: ApprovalAnswer, by: 'web' | 'discord') {
    const waiter = this.#waiting.get(id);
    if (!waiter) return false;
    waiter.settle(
      decision === 'allow'
        ? { decision }
        : {
            decision,
            feedback:
              'The owner refused this. Do not retry it; ask what they would like instead.',
          },
      by,
    );
    return true;
  }

  pending(threadId?: string): PendingApproval[] {
    return [...this.#waiting.values()]
      .map((waiter) => waiter.approval)
      .filter((approval) => !threadId || approval.threadId === threadId);
  }
}
