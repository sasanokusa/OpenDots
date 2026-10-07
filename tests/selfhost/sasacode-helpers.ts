import type { Message } from '@ag-ui/client';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { vi } from 'vitest';
import { z } from 'zod';
import { roles } from '../../src/selfhost/config/models.js';
import type { SasacodeRun } from '../../src/selfhost/sasacode/runs.js';
import type { UsageRecord, UsageRecorder } from '../../src/selfhost/types.js';

/** An AG-UI event with its fields readable by name. */
export type Event = BaseEvent & Record<string, unknown>;

export async function collect(
  events: AsyncIterable<BaseEvent>,
): Promise<Event[]> {
  const all: Event[] = [];
  for await (const event of events) all.push(event as Event);
  return all;
}

export const ofType = (events: Event[], type: EventType) =>
  events.filter((event) => event.type === type);

/** Everything the assistant said, in order. */
export const textOf = (events: Event[]) =>
  ofType(events, EventType.TEXT_MESSAGE_CHUNK)
    .map((event) => event.delta as string)
    .join('');

export class MemoryRecorder implements UsageRecorder {
  records: UsageRecord[] = [];
  record(record: UsageRecord) {
    this.records.push(record);
  }
  /** Metering of a response finishes just after the caller has it. */
  settled(count: number) {
    return vi.waitFor(() => {
      if (this.records.length < count)
        throw new Error(`${this.records.length} of ${count} usage records`);
    });
  }
}

export const user = (content: string, id = `u-${content}`): Message => ({
  id,
  role: 'user',
  content,
});
export const assistant = (
  content: string,
  toolCalls: { id: string; name: string; args?: string }[] = [],
  id = `a-${content}`,
): Message =>
  ({
    id,
    role: 'assistant',
    content,
    ...(toolCalls.length && {
      toolCalls: toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.args ?? '{}' },
      })),
    }),
  }) as Message;
export const toolResult = (toolCallId: string, content: string): Message => ({
  id: `t-${toolCallId}`,
  role: 'tool',
  toolCallId,
  content,
});

/** Tools the fake MCP endpoint serves in these tests. */
export function testTools() {
  const calls: { tool: string; args: unknown }[] = [];
  const tools: ToolDefinition[] = [
    defineTool({
      name: 'echo',
      description: 'Echo the text back.',
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        calls.push({ tool: 'echo', args: { text } });
        return { echoed: text };
      },
    }),
    defineTool({
      name: 'shout',
      description: 'Returns a plain string.',
      parameters: z.object({ text: z.string().min(1) }),
      execute: async ({ text }) => {
        calls.push({ tool: 'shout', args: { text } });
        return text.toUpperCase();
      },
    }),
    defineTool({
      name: 'quiet',
      description: 'Returns nothing.',
      parameters: z.object({}),
      execute: async () => {
        calls.push({ tool: 'quiet', args: {} });
        return undefined;
      },
    }),
    defineTool({
      name: 'explode',
      description: 'Always throws.',
      parameters: z.object({}),
      execute: async () => {
        throw new Error('kaboom');
      },
    }),
    defineTool({
      name: 'flood',
      description: 'Returns a very long string.',
      parameters: z.object({}),
      execute: async () => 'x'.repeat(100_000),
    }),
    defineTool({
      name: 'ask_owner',
      description: 'An interrupt tool without an executor.',
      parameters: z.object({}),
      interrupt: true,
    }),
  ];
  return { tools, calls };
}

export function sasacodeRun(overrides: Partial<SasacodeRun> = {}): SasacodeRun {
  return {
    dotId: 'dot-1',
    threadId: 'thread-1',
    runId: 'run-1',
    role: 'chat',
    model: roles.chat.model,
    tools: testTools().tools,
    signal: new AbortController().signal,
    ...overrides,
  };
}
