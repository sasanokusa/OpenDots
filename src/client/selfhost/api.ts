// Browser-side calls for the self-hosted backend (`/api/selfhost/*`). Only
// type imports cross from src/selfhost; nothing server-side is bundled.
import type { PolicyFlags } from '../../selfhost/usage/policy';
import type {
  UsageObservation,
  UsageSummary,
} from '../../selfhost/usage/meter';
import type {
  ApprovalAnswer,
  PendingApproval,
} from '../../selfhost/approvals/broker';
import { api } from '../api';

export type {
  ApprovalAnswer,
  PendingApproval,
  PolicyFlags,
  UsageObservation,
  UsageSummary,
};

export interface SelfhostThread {
  id: string;
  name: string | null;
  agentId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UsageResponse {
  summary: UsageSummary;
  policy: PolicyFlags;
}

/** One window as CommandCode's usage page shows it: percent used, and when a
 * 5-hour or weekly window resets (`resetsIn` is the page's "1d 15h" text). */
export interface ObservedSession {
  percent: number;
  resetsIn?: string;
  resetsAt?: string;
}

export interface ObservedBody {
  fiveHour?: ObservedSession;
  week?: ObservedSession;
  month?: { percent: number };
}

export function isSelfhost(backend: string | undefined): boolean {
  return backend === 'selfhost';
}

export async function listSelfhostThreads(
  signal?: AbortSignal,
): Promise<SelfhostThread[]> {
  const { threads } = await api<{ threads: SelfhostThread[] }>(
    '/selfhost/threads?includeArchived=true',
    'GET',
    undefined,
    signal,
  );
  return threads;
}

export function patchSelfhostThread(
  id: string,
  patch: { name?: string; archived?: boolean },
): Promise<SelfhostThread> {
  return api<SelfhostThread>(
    `/selfhost/threads/${encodeURIComponent(id)}`,
    'PATCH',
    patch,
  );
}

export function fetchSelfhostUsage(
  signal?: AbortSignal,
): Promise<UsageResponse> {
  return api<UsageResponse>('/selfhost/usage', 'GET', undefined, signal);
}

export async function fetchSelfhostObserved(
  signal?: AbortSignal,
): Promise<UsageObservation[]> {
  const { observations } = await api<{ observations: UsageObservation[] }>(
    '/selfhost/usage/observed',
    'GET',
    undefined,
    signal,
  );
  return observations;
}

/** Rejects with the server's `error` text (an ApiError) when it refuses the numbers. */
export async function putSelfhostObserved(
  body: ObservedBody,
): Promise<UsageObservation[]> {
  const { observations } = await api<{ observations: UsageObservation[] }>(
    '/selfhost/usage/observed',
    'PUT',
    body,
  );
  return observations;
}

/** The owner approvals still waiting for an answer in one conversation. */
export async function listSelfhostApprovals(
  threadId: string,
  signal?: AbortSignal,
): Promise<PendingApproval[]> {
  const { approvals } = await api<{ approvals: PendingApproval[] }>(
    `/selfhost/approvals?threadId=${encodeURIComponent(threadId)}`,
    'GET',
    undefined,
    signal,
  );
  return approvals;
}

/** Rejects with an ApiError; status 409 means the request already closed. */
export async function decideSelfhostApproval(
  id: string,
  decision: ApprovalAnswer,
): Promise<void> {
  await api<{ ok: true }>(
    `/selfhost/approvals/${encodeURIComponent(id)}`,
    'POST',
    { decision },
  );
}
