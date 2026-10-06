import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from '@ag-ui/client';
import { Observable, lastValueFrom, toArray } from 'rxjs';
import {
  SelfhostAgentRunner,
  type RunFinished,
} from '../../src/selfhost/runner/sqlite-runner.js';
import { runTurnInProcess } from '../../src/selfhost/headless.js';

type Script = (input: RunAgentInput) => Observable<BaseEvent>;

class ScriptedAgent extends AbstractAgent {
  inputs: RunAgentInput[] = [];
  constructor(private script: Script) {
    super({ agentId: 'dot-1' });
  }
  run(input: RunAgentInput) {
    this.inputs.push(input);
    return this.script(input);
  }
}

const reply =
  (text: string, delayMs = 0): Script =>
  (input) =>
    new Observable<BaseEvent>((subscriber) => {
      const messageId = `${input.runId}-reply`;
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: 'assistant',
      } as BaseEvent);
      const timer = setTimeout(() => {
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: text,
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_END,
          messageId,
        } as BaseEvent);
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        subscriber.complete();
      }, delayMs);
      return () => clearTimeout(timer);
    });

const fail: Script = (input) =>
  new Observable<BaseEvent>((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent);
    subscriber.error(new Error('model exploded'));
  });

function input(threadId: string, runId: string, text: string, history = []) {
  return {
    threadId,
    runId,
    messages: [
      ...history,
      { id: `${runId}-user`, role: 'user', content: text },
    ],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  } as RunAgentInput;
}

async function runOnce(
  runner: SelfhostAgentRunner,
  agent: AbstractAgent,
  request: RunAgentInput,
) {
  agent.setMessages(request.messages);
  agent.threadId = request.threadId;
  return lastValueFrom(
    runner
      .run({ threadId: request.threadId, agent, input: request })
      .pipe(toArray()),
  );
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it('streams a run, stores the transcript and replays it after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfhost-runner-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const finished: RunFinished[] = [];
  const db = new DatabaseSync(path);
  const runner = new SelfhostAgentRunner(db, {
    onRunFinished: (run) => finished.push(run),
  });
  const events = await runOnce(
    runner,
    new ScriptedAgent(reply('Hello there')),
    input('t1', 'r1', 'Hi'),
  );
  expect(events.map((event) => event.type)).toContain(
    EventType.TEXT_MESSAGE_CONTENT,
  );
  expect(
    runner.getThreadMessages('t1').map((m) => [m.role, m.content]),
  ).toEqual([
    ['user', 'Hi'],
    ['assistant', 'Hello there'],
  ]);
  expect(finished).toMatchObject([
    { threadId: 't1', runId: 'r1', agentId: 'dot-1', interrupted: false },
  ]);
  db.close();

  const reopened = new SelfhostAgentRunner(new DatabaseSync(path));
  const replay = await lastValueFrom(
    reopened.connect({ threadId: 't1' }).pipe(toArray()),
  );
  const text = replay
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => (event as unknown as { delta: string }).delta)
    .join('');
  expect(text).toBe('Hello there');
  expect(await reopened.isRunning({ threadId: 't1' })).toBe(false);
  expect(reopened.listThreads()).toMatchObject([
    { id: 't1', agentId: 'dot-1' },
  ]);
});

it('does not resend stored messages in RUN_STARTED input on later runs', async () => {
  const runner = new SelfhostAgentRunner(new DatabaseSync(':memory:'));
  await runOnce(
    runner,
    new ScriptedAgent(reply('one')),
    input('t1', 'r1', 'first'),
  );
  const history = runner.getThreadMessages('t1') as never[];
  const events = await runOnce(
    runner,
    new ScriptedAgent(reply('two')),
    input('t1', 'r2', 'second', history),
  );
  const started = events.find(
    (event) => event.type === EventType.RUN_STARTED,
  ) as unknown as {
    input: RunAgentInput;
  };
  expect(started.input.messages.map((m) => m.content)).toEqual(['second']);
  expect(runner.getThreadMessages('t1').map((m) => m.content)).toEqual([
    'first',
    'one',
    'second',
    'two',
  ]);
  const replay = await lastValueFrom(
    runner.connect({ threadId: 't1' }).pipe(toArray()),
  );
  expect(
    replay.filter((event) => event.type === EventType.TEXT_MESSAGE_START),
  ).toHaveLength(2);
});

it('refuses a second concurrent run and lets a late joiner see the live run', async () => {
  const runner = new SelfhostAgentRunner(new DatabaseSync(':memory:'));
  const agent = new ScriptedAgent(reply('slow', 30));
  const request = input('t1', 'r1', 'Hi');
  agent.setMessages(request.messages);
  const live = lastValueFrom(
    runner.run({ threadId: 't1', agent, input: request }).pipe(toArray()),
  );
  expect(await runner.isRunning({ threadId: 't1' })).toBe(true);
  expect(() =>
    runner.run({
      threadId: 't1',
      agent: new ScriptedAgent(reply('x')),
      input: input('t1', 'r2', 'again'),
    }),
  ).toThrow('Thread already running');
  const joined = lastValueFrom(
    runner.connect({ threadId: 't1' }).pipe(toArray()),
  );
  await live;
  const late = await joined;
  expect(late.some((event) => event.type === EventType.RUN_FINISHED)).toBe(
    true,
  );
  expect(await runner.isRunning({ threadId: 't1' })).toBe(false);
});

it('stores failed and stopped runs and frees the thread', async () => {
  const finished: RunFinished[] = [];
  const runner = new SelfhostAgentRunner(new DatabaseSync(':memory:'), {
    onRunFinished: (run) => finished.push(run),
  });
  const events = await runOnce(
    runner,
    new ScriptedAgent(fail),
    input('t1', 'r1', 'Hi'),
  );
  expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
  expect(finished.at(-1)).toMatchObject({ runId: 'r1', interrupted: true });

  const agent = new ScriptedAgent(reply('never', 1000));
  const request = input('t1', 'r2', 'again');
  agent.setMessages(request.messages);
  const pending = lastValueFrom(
    runner.run({ threadId: 't1', agent, input: request }).pipe(toArray()),
  );
  expect(await runner.stop({ threadId: 't1', runId: 'other' })).toBe(false);
  expect(await runner.stop({ threadId: 't1', runId: 'r2' })).toBe(true);
  await pending;
  expect(finished.at(-1)).toMatchObject({ runId: 'r2', interrupted: true });
  expect(await runner.isRunning({ threadId: 't1' })).toBe(false);
});

it('runs a server-initiated turn on top of the stored history', async () => {
  const runner = new SelfhostAgentRunner(new DatabaseSync(':memory:'));
  await runOnce(
    runner,
    new ScriptedAgent(reply('one')),
    input('t1', 'r1', 'first'),
  );
  const agent = new ScriptedAgent(reply('scheduled answer'));
  const text = await runTurnInProcess(
    runner,
    agent,
    't1',
    'run the task',
    new AbortController().signal,
  );
  expect(text).toBe('scheduled answer');
  expect(agent.inputs[0].messages.map((m) => m.content)).toEqual([
    'first',
    'one',
    'run the task',
  ]);
  expect(runner.getThreadMessages('t1')).toHaveLength(4);
  await expect(
    runTurnInProcess(
      runner,
      new ScriptedAgent(fail),
      't1',
      'x',
      new AbortController().signal,
    ),
  ).rejects.toThrow('model exploded');
});
