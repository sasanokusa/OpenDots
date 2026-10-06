import {
  CheckCheck,
  ChevronRight,
  LoaderCircle,
  MessageCircle,
} from 'lucide-react';
import type { Task } from '../shared/types';
import { Mascot } from './Mascot';
import { intlLocale, t } from './selfhost/i18n';
export const relative = (value: number) => {
  const minutes = Math.floor((Date.now() - value) / 60000);
  return minutes < 1
    ? t('Just now')
    : minutes < 60
      ? t('{minutes}m ago', { minutes })
      : minutes < 1440
        ? t('{hours}h ago', { hours: Math.floor(minutes / 60) })
        : new Date(value).toLocaleDateString(intlLocale());
};
export const statusLabel = (task: Task) => {
  if (task.status === 'completed' && task.nextRunAt) return t('Scheduled');
  const labels: Record<Task['status'], string> = {
    queued: t('Queued'),
    running: t('Running'),
    paused: t('Paused'),
    completed: t('Completed'),
    failed: t('Failed'),
    interrupted: t('Interrupted'),
    cancelled: t('Cancelled'),
  };
  return (
    labels[task.status] ??
    task.status.charAt(0).toUpperCase() + task.status.slice(1)
  );
};
const repeatLabel = (seconds: number) =>
  seconds < 3600
    ? t('Repeats every {n} min', { n: seconds / 60 })
    : t('Repeats every {n} hr', { n: seconds / 3600 });
export function Status({ task }: { task: Task }) {
  return (
    <span className={`status ${task.status}`}>
      <span />
      {statusLabel(task)}
    </span>
  );
}

export function TaskRow({
  task,
  onClick,
}: {
  task: Task;
  onClick: () => void;
}) {
  return (
    <button className="task-row" onClick={onClick}>
      <span className="task-row-icon">
        {task.status === 'completed' ? (
          <CheckCheck size={19} />
        ) : task.status === 'running' ? (
          <LoaderCircle className="spin" size={19} />
        ) : (
          <MessageCircle size={19} />
        )}
      </span>
      <div>
        <strong>{task.prompt}</strong>
        <span>
          {task.intervalSeconds
            ? `${repeatLabel(task.intervalSeconds)} · `
            : ''}
          {relative(task.updatedAt)}
        </span>
      </div>
      <Status task={task} />
      <ChevronRight size={16} />
    </button>
  );
}
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="large-empty">
      <Mascot />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
