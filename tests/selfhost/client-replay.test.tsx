import { renderToStaticMarkup } from 'react-dom/server';
import { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type Message } from '@ag-ui/core';
import { from, type Observable } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { ChatTranscript } from '../../src/client/ChatTranscript';
import { readMessageId } from '../../src/client/selfhost/read-receipt';
import { replayOnto } from '../../src/client/selfhost/replay';

const run = (runId: string, ...events: object[]) =>
  [
    { type: EventType.RUN_STARTED, threadId: 't', runId },
    ...events,
    { type: EventType.RUN_FINISHED, threadId: 't', runId },
  ] as BaseEvent[];

const reply = (messageId: string, text: string) => [
  { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
  { type: EventType.TEXT_MESSAGE_END, messageId },
];

/** Connecting replays the stored thread, like SelfhostAgentRunner.connect. */
class StoredThread extends AbstractAgent {
  events: BaseEvent[] = [
    ...run(
      'r1',
      ...reply('a1', 'Checking first.'),
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: 'c1',
        toolCallName: 'bash',
        parentMessageId: 'a1',
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '{"a":1}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'c1' },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: 'r1-tool',
        toolCallId: 'c1',
        content: 'ok',
      },
      ...reply('a2', 'All done.'),
    ),
  ];
  constructor() {
    super({ threadId: 't' });
  }
  run(): Observable<BaseEvent> {
    return from([]);
  }
  connect(): Observable<BaseEvent> {
    return from(this.events);
  }
}

const texts = (agent: AbstractAgent) =>
  agent.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content);

describe('replayOnto', () => {
  it('a plain reconnect appends every reply a second time', async () => {
    const agent = new StoredThread();
    await agent.connectAgent();
    await agent.connectAgent();
    expect(texts(agent)).toEqual([
      'Checking first.Checking first.',
      'All done.All done.',
    ]);
  });

  it('keeps what the agent already has and adds only new messages', async () => {
    const agent = new StoredThread();
    await agent.connectAgent();
    agent.events.push(...run('r2', ...reply('a3', 'A later run.')));
    await replayOnto(agent, () => agent.connectAgent());
    expect(texts(agent)).toEqual([
      'Checking first.',
      'All done.',
      'A later run.',
    ]);
    const first = agent.messages.find((message) => message.id === 'a1');
    expect(
      first?.role === 'assistant' && first.toolCalls?.[0]?.function.arguments,
    ).toBe('{"a":1}');
    expect(
      agent.messages.filter((message) => message.role === 'tool'),
    ).toHaveLength(1);
  });

  it('stops filtering once the reconnect is over', async () => {
    const agent = new StoredThread();
    await replayOnto(agent, () => agent.connectAgent());
    expect(texts(agent)).toEqual(['Checking first.', 'All done.']);
    await agent.connectAgent();
    expect(texts(agent)[0]).toBe('Checking first.Checking first.');
  });
});

describe('read receipt', () => {
  const user = (id: string): Message => ({ id, role: 'user', content: id });
  const assistant = (id: string): Message => ({
    id,
    role: 'assistant',
    content: id,
  });

  it('marks the latest message once a run started for it or it was answered', () => {
    expect(readMessageId([], undefined)).toBeUndefined();
    expect(readMessageId([user('u1')], undefined)).toBeUndefined();
    expect(readMessageId([user('u1')], 'u1')).toBe('u1');
    expect(readMessageId([user('u1'), assistant('a1')], undefined)).toBe('u1');
    // A run that started for an earlier message does not cover a new one.
    expect(
      readMessageId([user('u1'), assistant('a1'), user('u2')], 'u1'),
    ).toBeUndefined();
  });

  it('puts the mark right under that message in the transcript', () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        messages={[user('Hello'), assistant('Hi there')]}
        calls={[]}
        readMessageId="Hello"
      />,
    );
    expect(html).toContain('<span class="read-receipt">Read</span>');
    expect(html.indexOf('Hello')).toBeLessThan(html.indexOf('Read<'));
    expect(html.indexOf('Read<')).toBeLessThan(html.indexOf('Hi there'));
  });
});
