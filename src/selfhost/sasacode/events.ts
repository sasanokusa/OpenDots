import { randomUUID } from 'node:crypto';
import { type BaseEvent, EventType } from '@ag-ui/core';

// The subset of `sasacode -p … --output jsonl --control stdio` lines OpenDots reads.
type Content = { type: string; text?: string };
export type SasacodeLine =
  | { type: 'session'; id: string | null; path: string | null }
  | { type: 'message_start' }
  | {
      type: 'message_update';
      event:
        | { type: 'text_delta'; index: number; delta: string }
        | { type: 'thinking_delta'; index: number; delta: string }
        | { type: 'toolcall_start'; index: number; id: string; name: string }
        | { type: 'toolcall_delta'; index: number; delta: string }
        | { type: string; index?: number };
    }
  | {
      type: 'message_end';
      message:
        | { role: 'user'; content: Content[] }
        | {
            role: 'assistant';
            content: Content[];
            stopReason?: string;
            errorMessage?: string;
          }
        | {
            role: 'tool';
            toolCallId: string;
            toolName: string;
            content: Content[];
            isError: boolean;
          };
    }
  | { type: 'message_discarded' }
  | { type: 'error'; error: string }
  | { type: 'agent_end'; cause: string; stopped?: { reason: string } }
  | {
      type: 'approval_request';
      id: string;
      callId: string;
      tool: string;
      args: unknown;
      reason: string;
    }
  | { type: 'approval_cancelled'; id: string }
  | { type: 'control_error'; error: string }
  | { type: string };

export function textOf(content: Content[] | undefined): string {
  return (content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('');
}

/**
 * Turns sasacode's event lines into AG-UI events in the shape the TanStack
 * converter produces: text as chunks under one message id per assistant reply,
 * tool calls parented to that reply, and one result per tool-role message.
 */
export class SasacodeTranslator {
  #messageId?: string;
  #calls = new Map<number, string>();
  #open = new Set<string>();
  #names = new Map<string, string>();
  #hidden: Set<string>;
  lastError?: string;
  cause?: string;
  sessionId?: string;

  /** Tool names whose results stay out of the stream (the review card). */
  constructor(hiddenResults: Iterable<string> = []) {
    this.#hidden = new Set(hiddenResults);
  }

  toolName(callId: string): string | undefined {
    return this.#names.get(callId);
  }

  push(line: SasacodeLine): BaseEvent[] {
    switch (line.type) {
      case 'session': {
        const id = (line as { id: string | null }).id;
        if (id) this.sessionId = id;
        return [];
      }
      case 'message_start':
        this.#messageId = randomUUID();
        this.#calls.clear();
        return [];
      case 'message_discarded':
        // A dropped reply is retried as a new message; close what was open.
        return this.#closeCalls();
      case 'message_update':
        return this.#update(
          (line as Extract<SasacodeLine, { type: 'message_update' }>).event,
        );
      case 'message_end':
        return this.#end(
          (line as Extract<SasacodeLine, { type: 'message_end' }>).message,
        );
      case 'error':
        this.lastError = (line as { error: string }).error;
        return [];
      case 'agent_end':
        this.cause = (line as { cause: string }).cause;
        return this.#closeCalls();
      default:
        return [];
    }
  }

  #id(): string {
    this.#messageId ??= randomUUID();
    return this.#messageId;
  }

  #update(
    event: Extract<SasacodeLine, { type: 'message_update' }>['event'],
  ): BaseEvent[] {
    if (event.type === 'text_delta' && 'delta' in event && event.delta)
      return [
        {
          type: EventType.TEXT_MESSAGE_CHUNK,
          role: 'assistant',
          messageId: this.#id(),
          delta: event.delta,
        } as BaseEvent,
      ];
    if (event.type === 'toolcall_start' && 'id' in event) {
      this.#calls.set(event.index, event.id);
      this.#open.add(event.id);
      this.#names.set(event.id, event.name);
      return [
        {
          type: EventType.TOOL_CALL_START,
          parentMessageId: this.#id(),
          toolCallId: event.id,
          toolCallName: event.name,
        } as BaseEvent,
      ];
    }
    if (event.type === 'toolcall_delta' && 'delta' in event) {
      const id = this.#calls.get(event.index ?? -1);
      if (!id || !event.delta) return [];
      return [
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: id,
          delta: event.delta,
        } as BaseEvent,
      ];
    }
    return [];
  }

  #closeCalls(): BaseEvent[] {
    const events = [...this.#open].map(
      (toolCallId) =>
        ({ type: EventType.TOOL_CALL_END, toolCallId }) as BaseEvent,
    );
    this.#open.clear();
    return events;
  }

  #end(
    message: Extract<SasacodeLine, { type: 'message_end' }>['message'],
  ): BaseEvent[] {
    if (message.role === 'assistant') {
      const events = this.#closeCalls();
      if (message.stopReason === 'error' && message.errorMessage)
        this.lastError = message.errorMessage;
      this.#messageId = undefined;
      return events;
    }
    if (message.role === 'tool') {
      if (this.#hidden.has(message.toolName)) return [];
      return [
        {
          type: EventType.TOOL_CALL_RESULT,
          role: 'tool',
          messageId: randomUUID(),
          toolCallId: message.toolCallId,
          content: textOf(message.content),
        } as BaseEvent,
      ];
    }
    return [];
  }
}
