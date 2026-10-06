import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Message } from '@ag-ui/client';
import type { LocalThreadEndpointRecord } from '@copilotkit/runtime/v2';
import type { WorkspaceStore } from '../../server/workspace.js';
import type { Conversation } from '../../shared/types.js';
import type {
  RunFinished,
  SelfhostAgentRunner,
} from '../runner/sqlite-runner.js';
import type { SelfhostEvents } from './events.js';

/** Produces a short thread title from the first exchange; undefined = keep the default. */
export type ThreadNamer = (
  firstUser: string,
  firstAssistant: string,
) => Promise<string | undefined>;

interface ThreadMeta {
  id: string;
  name: string | null;
  archived: number;
  updated_at: number;
  last_run_at: number | null;
}

export function messageText(message: Pick<Message, 'content'>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) =>
      part &&
      typeof part === 'object' &&
      'text' in part &&
      typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('\n');
}

/**
 * Thread metadata that Intelligence used to own: names, archive state and
 * recency. Thread ownership itself stays in the upstream `thread_bindings`.
 */
export class ThreadService {
  private naming = new Set<string>();

  constructor(
    private db: DatabaseSync,
    private workspace: WorkspaceStore,
    private runner: SelfhostAgentRunner,
    private events: SelfhostEvents,
    private options: { namer?: ThreadNamer; now?: () => number } = {},
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS sh_threads(
      id TEXT PRIMARY KEY, name TEXT, archived INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, last_run_at INTEGER)`);
    runner.setDirectory(() => this.records());
  }

  setNamer(namer: ThreadNamer) {
    this.options.namer = namer;
  }

  private get now() {
    return (this.options.now ?? Date.now)();
  }

  private meta(): Map<string, ThreadMeta> {
    const rows = this.db
      .prepare('SELECT * FROM sh_threads')
      .all() as unknown as ThreadMeta[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  private upsert(
    id: string,
    patch: Partial<Pick<ThreadMeta, 'name' | 'archived' | 'last_run_at'>>,
  ) {
    const at = this.now;
    this.db
      .prepare(
        'INSERT INTO sh_threads (id, name, archived, updated_at, last_run_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(id, null, 0, at, null);
    if ('name' in patch)
      this.db
        .prepare('UPDATE sh_threads SET name=?, updated_at=? WHERE id=?')
        .run(patch.name ?? null, at, id);
    if ('archived' in patch)
      this.db
        .prepare('UPDATE sh_threads SET archived=?, updated_at=? WHERE id=?')
        .run(patch.archived ?? 0, at, id);
    if ('last_run_at' in patch)
      this.db
        .prepare('UPDATE sh_threads SET last_run_at=?, updated_at=? WHERE id=?')
        .run(patch.last_run_at ?? null, at, id);
  }

  records(
    options: { includeArchived?: boolean } = {},
  ): LocalThreadEndpointRecord[] {
    const meta = this.meta();
    return this.workspace
      .conversations()
      .flatMap((thread) => {
        const row = meta.get(thread.id);
        if (row?.archived && !options.includeArchived) return [];
        return [
          {
            id: thread.id,
            name: row?.name ?? null,
            agentId: thread.dotId,
            organizationId: '',
            createdById: this.workspace.ownerId,
            archived: !!row?.archived,
            createdAt: new Date(thread.createdAt).toISOString(),
            updatedAt: new Date(
              row?.last_run_at ?? row?.updated_at ?? thread.createdAt,
            ).toISOString(),
          },
        ];
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  archivedIds(): Set<string> {
    return new Set(
      [...this.meta().values()]
        .filter((row) => row.archived)
        .map((row) => row.id),
    );
  }

  create(dotId: string, title: string): Conversation {
    const thread = this.workspace.bindThread(randomUUID(), dotId, title);
    this.upsert(thread.id, {});
    this.events.emit({ type: 'thread_updated', threadId: thread.id });
    return thread;
  }

  /** Metadata for a thread created elsewhere (page conversations, channels). */
  ensure(threadId: string, name?: string) {
    const existing = this.meta().get(threadId);
    this.upsert(threadId, existing || name === undefined ? {} : { name });
  }

  rename(threadId: string, name: string) {
    this.workspace.requireThread(threadId);
    this.upsert(threadId, { name });
    this.events.emit({ type: 'thread_updated', threadId });
  }

  archive(threadId: string, archived: boolean) {
    this.workspace.requireThread(threadId);
    this.upsert(threadId, { archived: archived ? 1 : 0 });
    this.events.emit({ type: 'thread_updated', threadId });
  }

  messages(threadId: string): Message[] {
    return this.runner.getThreadMessages(threadId);
  }

  /** Same shape as upstream `Platform.history()`: recent turns as plain text. */
  history(threadId: string): string {
    this.workspace.requireThread(threadId);
    return this.messages(threadId)
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map((message) => `${message.role}: ${messageText(message)}`)
      .join('\n')
      .slice(-12000);
  }

  noteRun(run: RunFinished) {
    this.upsert(run.threadId, { last_run_at: run.at });
    this.events.emit({
      type: 'run_finished',
      threadId: run.threadId,
      runId: run.runId,
    });
    void this.autoName(run.threadId);
  }

  private async autoName(threadId: string) {
    const namer = this.options.namer;
    if (!namer || this.naming.has(threadId)) return;
    if (this.meta().get(threadId)?.name) return;
    const messages = this.messages(threadId);
    const user = messages.find((message) => message.role === 'user');
    const assistant = messages.find((message) => message.role === 'assistant');
    if (!user || !assistant) return;
    this.naming.add(threadId);
    try {
      const name = (
        await namer(
          messageText(user).slice(0, 2000),
          messageText(assistant).slice(0, 2000),
        )
      )
        ?.replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      if (name && !this.meta().get(threadId)?.name) {
        this.upsert(threadId, { name });
        this.events.emit({ type: 'thread_updated', threadId });
      }
    } catch {
      // Naming is cosmetic; the conversation is already saved.
    } finally {
      this.naming.delete(threadId);
    }
  }
}
