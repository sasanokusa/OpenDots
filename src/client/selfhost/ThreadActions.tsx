// Rename / archive for the sidebar thread list in self-hosted mode.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  listSelfhostThreads,
  patchSelfhostThread,
  type SelfhostThread,
} from './api';
import { useSelfhostEvents } from './events';

const NO_NAMES: ReadonlyMap<string, string> = new Map();
const NO_ARCHIVED: ReadonlySet<string> = new Set();

/**
 * Names and archived flags kept by the self-hosted backend. Loads on mount, and
 * again whenever the server says a thread changed (including from another
 * device). Failed loads keep the last good data.
 */
export function useSelfhostThreads(enabled: boolean) {
  const [records, setRecords] = useState<SelfhostThread[]>([]);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(() => {
    const mine = ++sequence.current;
    return listSelfhostThreads()
      .then((next) => {
        if (mine === sequence.current) setRecords(next);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void load();
    return () => {
      sequence.current++;
      clearTimeout(timer.current);
    };
  }, [enabled, load]);
  useSelfhostEvents(enabled, (event) => {
    if (event.type !== 'thread_updated' && event.type !== 'ready') return;
    // Coalesce bursts of updates into one request.
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 150);
  });
  const visible = enabled ? records : undefined;
  const names = useMemo(
    () =>
      visible
        ? new Map(
            visible
              .filter((record) => record.name)
              .map((record) => [record.id, record.name as string]),
          )
        : NO_NAMES,
    [visible],
  );
  // Keyed by content so an unchanged archive list keeps the same identity.
  const archivedKey = (visible ?? [])
    .filter((record) => record.archived)
    .map((record) => record.id)
    .sort()
    .join('\n');
  const archived = useMemo(
    () => (archivedKey ? new Set(archivedKey.split('\n')) : NO_ARCHIVED),
    [archivedKey],
  );
  const update = useCallback(
    async (id: string, patch: { name?: string; archived?: boolean }) => {
      setError('');
      try {
        const record = await patchSelfhostThread(id, patch);
        setRecords((current) => [
          ...current.filter((item) => item.id !== record.id),
          record,
        ]);
        void load();
        return true;
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Could not update the conversation.',
        );
        return false;
      }
    },
    [load],
  );
  return {
    names,
    archived,
    error,
    rename: (id: string, name: string) => update(id, { name }),
    archive: (id: string) => update(id, { archived: true }),
  };
}

/** Wraps a thread row with a "…" button, a Rename / Archive menu and an inline rename field. */
export function SelfhostThreadRow({
  label,
  children,
  onRename,
  onArchive,
}: {
  label: string;
  children: ReactNode;
  onRename: (name: string) => Promise<boolean>;
  onArchive: () => Promise<boolean>;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!menu) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenu(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [menu]);
  useEffect(() => {
    if (!renaming) return;
    field.current?.focus();
    field.current?.select();
  }, [renaming]);
  const closeMenu = () => {
    setMenu(false);
    toggle.current?.focus();
  };
  const commit = async (value: string) => {
    const name = value.trim();
    if (!name || name === label) return setRenaming(false);
    if (await onRename(name)) setRenaming(false);
  };
  return (
    <div
      ref={root}
      className={`thread-row ${menu || renaming ? 'open' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menu) {
          event.stopPropagation();
          closeMenu();
        }
      }}
    >
      <div className="thread-row-main">
        {renaming ? (
          <input
            ref={field}
            className="thread-rename-input"
            aria-label="Rename conversation"
            defaultValue={label}
            maxLength={80}
            onBlur={() => setRenaming(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void commit(event.currentTarget.value);
              } else if (event.key === 'Escape') {
                event.stopPropagation();
                setRenaming(false);
                toggle.current?.focus();
              }
            }}
          />
        ) : (
          children
        )}
        {!renaming && (
          <button
            ref={toggle}
            type="button"
            className="icon-button thread-menu-button"
            aria-label={`Options for ${label}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <MoreHorizontal size={15} />
          </button>
        )}
      </div>
      {menu && !renaming && (
        <div className="thread-menu" role="menu" aria-label="Conversation">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              void onArchive();
            }}
          >
            Archive
          </button>
        </div>
      )}
    </div>
  );
}
