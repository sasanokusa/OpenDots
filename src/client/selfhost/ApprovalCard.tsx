// Owner approval for tool calls the agent wants to run (self-hosted backend).
// The same request is also DMed on Discord; whichever answer comes first wins,
// and the other side is told through `approval_resolved`.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { ApiError } from '../api';
import {
  decideSelfhostApproval,
  listSelfhostApprovals,
  type ApprovalAnswer,
  type PendingApproval,
} from './api';
import { useSelfhostEvents } from './events';
import { t, tMessage } from './i18n';

const TICK_MS = 1000;

/** The current time, refreshed every second. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** `m:ss` until `expiresAt`, or undefined once it has passed. */
export function remainingTime(expiresAt: number, now: number) {
  const seconds = Math.ceil((expiresAt - now) / 1000);
  if (seconds <= 0) return undefined;
  const rest = String(seconds % 60).padStart(2, '0');
  return `${Math.floor(seconds / 60)}:${rest}`;
}

function ApprovalItem({
  approval,
  onAnswered,
}: {
  approval: PendingApproval;
  onAnswered: (id: string) => void;
}) {
  const now = useNow();
  const [sending, setSending] = useState<ApprovalAnswer>();
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState('');
  const left = remainingTime(approval.expiresAt, now);

  const decide = async (decision: ApprovalAnswer) => {
    if (sending || closed) return;
    setSending(decision);
    setError('');
    try {
      await decideSelfhostApproval(approval.id, decision);
      onAnswered(approval.id);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setClosed(true);
        setError(t('This request has already closed.'));
      } else {
        setError(
          cause instanceof Error
            ? tMessage(cause.message)
            : t('Could not send your answer.'),
        );
      }
      setSending(undefined);
    }
  };

  const disabled = !!sending || closed;
  return (
    <section className="approval-card" aria-label={t('Approval request')}>
      <header>
        <ShieldAlert size={17} />
        <strong>{t('Needs your approval')}</strong>
        <span>
          {left ? t('Expires in {time}', { time: left }) : t('Expired')}
        </span>
      </header>
      <pre className="approval-summary">{approval.summary}</pre>
      {approval.reason && (
        <p className="approval-reason">
          <span>{t('Reason')}</span> {tMessage(approval.reason)}
        </p>
      )}
      <footer>
        <button
          type="button"
          className="primary"
          disabled={disabled}
          onClick={() => void decide('allow')}
        >
          {sending === 'allow' ? t('Sending…') : t('Allow')}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void decide('deny')}
        >
          {sending === 'deny' ? t('Sending…') : t('Deny')}
        </button>
        {error && <small role="alert">{error}</small>}
      </footer>
    </section>
  );
}

function Approvals({ threadId }: { threadId: string }) {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  // Ids answered or closed while a list request was in flight, so a late
  // response cannot bring their cards back.
  const settled = useRef(new Set<string>());
  const sequence = useRef(0);

  const load = useCallback(() => {
    const mine = ++sequence.current;
    // Intelligence mode has no such endpoint; a failed load shows nothing new.
    return listSelfhostApprovals(threadId)
      .then((next) => {
        if (mine !== sequence.current) return;
        setApprovals(next.filter((item) => !settled.current.has(item.id)));
      })
      .catch(() => {});
  }, [threadId]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);

  const remove = useCallback((id: string) => {
    settled.current.add(id);
    setApprovals((current) => current.filter((item) => item.id !== id));
  }, []);

  useSelfhostEvents(true, (event) => {
    if (event.type === 'ready') void load();
    else if (event.type === 'approval_resolved') remove(event.id);
    else if (
      event.type === 'approval_requested' &&
      event.approval.threadId === threadId &&
      !settled.current.has(event.approval.id)
    ) {
      const { approval } = event;
      setApprovals((current) =>
        current.some((item) => item.id === approval.id)
          ? current
          : [...current, approval],
      );
    }
  });

  return (
    <>
      {approvals.map((approval) => (
        <ApprovalItem
          key={approval.id}
          approval={approval}
          onAnswered={remove}
        />
      ))}
    </>
  );
}

/** Pending approvals of one conversation; renders nothing when there are none. */
export function ApprovalCard({ threadId }: { threadId: string }) {
  return <Approvals key={threadId} threadId={threadId} />;
}
