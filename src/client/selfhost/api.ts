// Browser-side calls for the self-hosted backend (`/api/selfhost/*`). Only
// type imports cross from src/selfhost; nothing server-side is bundled.
import type { PolicyFlags } from '../../selfhost/usage/policy';
import type { UsageSummary } from '../../selfhost/usage/meter';
import { api } from '../api';

export type { PolicyFlags, UsageSummary };

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
