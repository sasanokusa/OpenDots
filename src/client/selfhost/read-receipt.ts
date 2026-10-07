// "Read" under the owner's latest message: the Dot has picked it up.
import { useEffect, useState } from 'react';
import type { AbstractAgent } from '@ag-ui/client';
import type { Message } from '@ag-ui/core';

function lastUserIndex(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--)
    if (messages[index]!.role === 'user') return index;
  return -1;
}

/**
 * The owner's latest message counts as read once a run has started for it on
 * the server (`startedFor`) or the Dot has answered it.
 */
export function readMessageId(
  messages: Message[],
  startedFor: string | undefined,
): string | undefined {
  const index = lastUserIndex(messages);
  if (index === -1) return undefined;
  const id = messages[index]!.id;
  const answered = messages
    .slice(index + 1)
    .some((message) => message.role === 'assistant');
  return answered || id === startedFor ? id : undefined;
}

/** Watches the agent's runs and returns the message to mark as read. */
export function useReadReceipt(
  agent: AbstractAgent,
  messages: Message[],
  enabled: boolean,
): string | undefined {
  const [startedFor, setStartedFor] = useState<string>();
  useEffect(() => {
    if (!enabled) return;
    const subscription = agent.subscribe({
      onRunStartedEvent: ({ messages: current }) => {
        const index = lastUserIndex(current);
        setStartedFor(index === -1 ? undefined : current[index]!.id);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, enabled]);
  return enabled ? readMessageId(messages, startedFor) : undefined;
}
