import { useEffect } from 'react';
import { useThreads } from '@copilotkit/react-core/v2';
import { MessageCircle, Plus } from 'lucide-react';
import type { Conversation, Dot } from '../shared/types';
import {
  SelfhostThreadRow,
  useSelfhostThreads,
} from './selfhost/ThreadActions';
import { t, tMessage } from './selfhost/i18n';

/** The server's default title is English; show it in the UI language. */
const DEFAULT_TITLE = 'A new thought';
const displayTitle = (title: string) =>
  title === DEFAULT_TITLE ? t(DEFAULT_TITLE) : title;
export function ThreadList({
  dots,
  dotId,
  local,
  selected,
  onSelect,
  onNew,
  selfhost,
  onArchivedChange,
}: {
  dots: Dot[];
  dotId: string;
  local: Conversation[];
  selected?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Fork: self-hosted backend, which adds rename/archive and cross-device names. */
  selfhost?: boolean;
  onArchivedChange?: (ids: ReadonlySet<string>) => void;
}) {
  const threads = useThreads({
    agentId: dotId,
    enabled: true,
    includeArchived: false,
    limit: 20,
  });
  const sh = useSelfhostThreads(!!selfhost);
  useEffect(() => {
    if (selfhost) onArchivedChange?.(sh.archived);
  }, [selfhost, sh.archived, onArchivedChange]);
  const visible = selfhost
    ? local.filter((thread) => !sh.archived.has(thread.id))
    : local;
  return (
    <section className="thread-list">
      <div className="nav-label">
        {t('RECENT CHATS')}
        <button
          className="icon-button"
          onClick={onNew}
          aria-label={t('New conversation')}
        >
          <Plus size={14} />
        </button>
      </div>
      {threads.error && (
        <p className="sidebar-error">
          {t('Conversation sync unavailable. Check your runtime connection.')}
        </p>
      )}
      {selfhost && sh.error && (
        <p className="sidebar-error">{tMessage(sh.error)}</p>
      )}
      {visible.map((thread) => {
        const remote = threads.threads.find((item) => item.id === thread.id);
        const title =
          (selfhost && sh.names.get(thread.id)) ||
          remote?.name ||
          displayTitle(thread.title);
        const item = (
          <button
            key={thread.id}
            className={`nav-item ${selected === thread.id ? 'active' : ''}`}
            onClick={() => onSelect(thread.id)}
          >
            <MessageCircle size={15} />
            <span className="thread-summary">
              <span>{title}</span>
              <small>{dots.find((dot) => dot.id === thread.dotId)?.name}</small>
            </span>
          </button>
        );
        return selfhost ? (
          <SelfhostThreadRow
            key={thread.id}
            label={title}
            onRename={(name) => sh.rename(thread.id, name)}
            onArchive={() => sh.archive(thread.id)}
          >
            {item}
          </SelfhostThreadRow>
        ) : (
          item
        );
      })}
      {!visible.length && (
        <p className="sidebar-empty">
          {t('Your first conversation will live here.')}
        </p>
      )}
      {threads.hasMoreThreads && (
        <button
          className="text-button"
          disabled={threads.isFetchingMoreThreads}
          onClick={() => void threads.fetchMoreThreads()}
        >
          {t('Load more conversations')}
        </button>
      )}
    </section>
  );
}
