// Reconnecting replays the whole thread. AG-UI applies a replayed text event
// to the message with the same id, so on an agent that already holds those
// messages every reply would get its text appended a second time (and tool
// arguments would double). Skip what the agent already has.
import type { AbstractAgent, AgentSubscriber } from '@ag-ui/client';

export async function replayOnto<T>(
  agent: AbstractAgent,
  connect: () => Promise<T>,
): Promise<T> {
  const messages = new Set<string>();
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of agent.messages) {
    messages.add(message.id);
    if (message.role === 'assistant')
      for (const call of message.toolCalls ?? []) calls.add(call.id);
    if (message.role === 'tool') results.add(message.toolCallId);
  }
  const skip = { stopPropagation: true };
  const text = ({ event }: { event: { messageId: string } }) =>
    messages.has(event.messageId) ? skip : undefined;
  const call = ({ event }: { event: { toolCallId: string } }) =>
    calls.has(event.toolCallId) ? skip : undefined;
  const subscriber: AgentSubscriber = {
    onTextMessageStartEvent: text,
    onTextMessageContentEvent: text,
    onTextMessageEndEvent: text,
    onToolCallStartEvent: call,
    onToolCallArgsEvent: call,
    onToolCallEndEvent: call,
    onToolCallResultEvent: ({ event }) =>
      results.has(event.toolCallId) ? skip : undefined,
  };
  const subscription = agent.subscribe(subscriber);
  try {
    return await connect();
  } finally {
    subscription.unsubscribe();
  }
}
