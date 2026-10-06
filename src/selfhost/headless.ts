import { randomUUID } from 'node:crypto';
import {
  EventType,
  type AbstractAgent,
  type Message,
  type RunAgentInput,
} from '@ag-ui/client';
import { currentTurnText } from '../server/headless.js';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import type { SelfhostAgentRunner } from './runner/sqlite-runner.js';

/**
 * Server-initiated turn (scheduled tasks, voice receipts, Discord). Replaces
 * upstream's Intelligence WebSocket path; the run goes through the same runner
 * as the web UI, so it lands in the same thread history.
 */
export async function runTurnInProcess(
  runner: SelfhostAgentRunner,
  agent: AbstractAgent,
  threadId: string,
  prompt: string,
  signal: AbortSignal,
  metadata?: Record<string, unknown>,
): Promise<string> {
  signal.throwIfAborted();
  const message = {
    id: `${metadata?.opendotsSource === 'voice_receipt' ? voiceReceiptMessagePrefix : ''}${randomUUID()}`,
    role: 'user',
    content: prompt,
    ...(metadata ? { metadata } : {}),
  } as Message;
  const input: RunAgentInput = {
    threadId,
    runId: randomUUID(),
    messages: [...runner.getThreadMessages(threadId), message],
    tools: [],
    context: [],
    state: runner.getThreadState(threadId) ?? {},
    forwardedProps: {},
  };
  agent.setMessages(input.messages);
  agent.setState(input.state);
  agent.threadId = threadId;
  let runError: Error | undefined;
  const stop = () => void runner.stop({ threadId, runId: input.runId });
  signal.addEventListener('abort', stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      runner.run({ threadId, agent, input }).subscribe({
        next: (event) => {
          if (event.type === EventType.RUN_ERROR)
            runError = new Error(
              (event as { message?: string }).message ?? 'The turn failed.',
            );
        },
        error: reject,
        complete: resolve,
      });
    });
    signal.throwIfAborted();
    const sent = new Set(input.messages.map((item) => item.id));
    return currentTurnText(
      agent.messages.filter((item) => !sent.has(item.id)),
      runError,
    );
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
