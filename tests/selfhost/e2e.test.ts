/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Store } from '../../src/server/store.js';
import { WorkspaceStore } from '../../src/server/workspace.js';
import { Platform } from '../../src/server/platform.js';
import { Runner } from '../../src/server/runner.js';
import { createApp } from '../../src/server/app.js';
import type { PlatformConfig } from '../../src/server/platform-config.js';
import { enableSelfhost } from '../../src/selfhost/env.js';
import { selfhostRoutes } from '../../src/selfhost/routes.js';
import type { SelfhostBackend } from '../../src/selfhost/index.js';
import { roles } from '../../src/selfhost/config/models.js';
import {
  startFakeCommandCode,
  type FakeChatReply,
  type FakeCommandCode,
} from './fake-commandcode.js';

let fake: FakeCommandCode;
const cleanup: (() => unknown)[] = [];
beforeEach(async () => {
  fake = await startFakeCommandCode();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  await fake.close();
});

function fixture(router: 'on' | 'off') {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const config: PlatformConfig = {
    baseUrl: 'https://api.openai.com/v1',
    model: 'xiaomi/mimo-v2.6-flash',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
    webSearchProvider: 'disabled',
  };
  const selfhost = enableSelfhost(
    {
      CONVERSATION_BACKEND: 'selfhost',
      MODEL_ROUTER: router,
      COMMAND_CODE_API_KEY: 'test-key',
      COMMAND_CODE_BASE_URL: fake.baseURL,
    },
    config,
    { databasePath: ':memory:', workspace },
  ) as SelfhostBackend;
  const platform = new Platform(store, workspace, config, selfhost);
  const research = { mode: 'live' as const, baseUrl: config.baseUrl };
  const app = createApp({
    store,
    runner: new Runner(store, research),
    config: research,
    platform,
  });
  app.route('/api/selfhost', selfhostRoutes(selfhost));
  cleanup.push(() => {
    selfhost.close();
    store.close();
    workspace.close();
  });
  const dot = workspace.dots()[0];
  return { app, platform, selfhost, workspace, config, dot };
}

const toolCall = (name: string, args: unknown) => ({
  toolCalls: [{ id: `call_${name}`, name, arguments: JSON.stringify(args) }],
});
const hasToolResult = (body: any) =>
  body.messages.some((message: any) => message.role === 'tool');
const toolResults = (body: any) =>
  body.messages
    .filter((message: any) => message.role === 'tool')
    .map((message: any) => String(message.content));
const chatModels = () =>
  fake.requests
    .filter((request) => request.path === '/chat/completions')
    .map((request) => request.body.model);

function jevAnswers(
  route: Record<string, number>,
  highImpact = 0.05,
  taskImpact = 0.05,
) {
  fake.onSystemOne((body) => {
    const answers: Record<string, unknown> = {};
    for (const key of Object.keys(body.questions)) {
      if (key === 'route') {
        const choice = Object.entries(route).sort((a, b) => b[1] - a[1])[0][0];
        answers.route = {
          type: 'choice',
          choice,
          confidence: route[choice],
          probabilities: route,
        };
      } else
        answers[key] = {
          type: 'noul',
          noul: key === 'high_impact' ? highImpact : taskImpact,
        };
    }
    return {
      body: {
        model: 'typesafe/jev',
        answers,
        usage: { input_tokens: 80, output_tokens: 2 },
      },
    };
  });
}

it('serves runs, history and thread lists over HTTP without Intelligence', async () => {
  const { app, platform, selfhost, dot } = fixture('off');
  expect(platform.setup()).toMatchObject({
    backend: 'selfhost',
    intelligence: true,
    missing: [],
  });
  const thread = await platform.createConversation(dot.id, 'First chat');
  fake.onChat((body) =>
    body.messages.some((m: any) => /Write a title/.test(String(m.content)))
      ? {
          content: '最初の会話',
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }
      : {
          content: 'Hello from MiMo',
          usage: { prompt_tokens: 30, completion_tokens: 6 },
        },
  );
  const response = await app.request(`/api/copilotkit/agent/${dot.id}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      threadId: thread.id,
      runId: 'run-1',
      messages: [{ id: 'u1', role: 'user', content: 'Hi' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  expect(response.status).toBe(200);
  const stream = await response.text();
  expect(stream).toContain('Hello');
  expect(stream).toContain('RUN_FINISHED');

  const messages = (await (
    await app.request(`/api/copilotkit/threads/${thread.id}/messages`)
  ).json()) as { messages: { role: string; content: string }[] };
  expect(messages.messages.map((m) => [m.role, m.content])).toEqual([
    ['user', 'Hi'],
    ['assistant', 'Hello from MiMo'],
  ]);
  await expect
    .poll(() => selfhost.threads.records()[0]?.name)
    .toBe('最初の会話');
  const list = (await (
    await app.request(`/api/copilotkit/threads?agentId=${dot.id}`)
  ).json()) as { threads: { id: string; name: string }[] };
  expect(list.threads).toMatchObject([{ id: thread.id, name: '最初の会話' }]);
  expect(await platform.history(thread.id)).toBe(
    'user: Hi\nassistant: Hello from MiMo',
  );
  const usage = (await (
    await app.request('/api/selfhost/usage')
  ).json()) as any;
  expect(usage.summary.byRole.chat.monthUSD).toBeGreaterThan(0);
  expect(chatModels()[0]).toBe('xiaomi/mimo-v2.6-flash');
  expect(fake.requests.some((r) => r.path === '/systemone')).toBe(false);
});

it('routes by Jev and logs the decision', async () => {
  const { platform, dot, selfhost } = fixture('on');
  void selfhost;
  const thread = await platform.createConversation(dot.id, 'Routing');
  jevAnswers({ chat: 0.9, planner: 0.05, worker: 0.05 });
  await expect(
    platform.turn(
      thread.id,
      '今日の予定を教えて',
      new AbortController().signal,
    ),
  ).resolves.toBe('ok');
  jevAnswers({ chat: 0.5, planner: 0.3, worker: 0.2 });
  await platform.turn(
    thread.id,
    '少し複雑な依頼',
    new AbortController().signal,
  );
  jevAnswers({ chat: 0.9, planner: 0.05, worker: 0.05 }, 0.92);
  await platform.turn(
    thread.id,
    '請求書を送って',
    new AbortController().signal,
  );
  jevAnswers({ worker: 0.8, chat: 0.1, planner: 0.1 });
  await platform.turn(
    thread.id,
    'ファイル一覧を出して',
    new AbortController().signal,
  );
  const turnModels = chatModels().filter(
    (_, index) =>
      !/Write a title/.test(
        JSON.stringify(
          fake.requests.filter((r) => r.path === '/chat/completions')[index]
            .body.messages,
        ),
      ),
  );
  expect(turnModels).toEqual([
    roles.chat.model,
    roles.planner.model,
    roles.planner.model,
    roles.worker.model,
  ]);
  const plannerRequest = fake.requests.find(
    (r) =>
      r.path === '/chat/completions' && r.body.model === roles.planner.model,
  )!;
  const toolNames = plannerRequest.body.tools.map((t: any) => t.function.name);
  expect(toolNames).toEqual(
    expect.arrayContaining(['delegate_tasks', 'ask_advisor']),
  );
  const log = (platform.config.selfhost!.planTurn as any).log.recent();
  expect(log.map((row: any) => [row.final_role, row.reason]).reverse()).toEqual(
    [
      ['chat', 'jev'],
      ['planner', 'low_confidence'],
      ['planner', 'high_impact'],
      ['worker', 'jev'],
    ],
  );
});

it('lets the chat role delegate to a worker and relay the result', async () => {
  const { platform, dot } = fixture('on');
  const thread = await platform.createConversation(dot.id, 'Delegation');
  jevAnswers({ chat: 0.9, planner: 0.05, worker: 0.05 });
  fake.onChat((body): FakeChatReply => {
    if (body.model === roles.worker.model) return { content: 'found 3 items' };
    if (/Write a title/.test(JSON.stringify(body.messages)))
      return { content: 't' };
    return hasToolResult(body)
      ? { content: `Done: ${toolResults(body)[0].includes('found 3 items')}` }
      : toolCall('delegate_tasks', {
          tasks: [
            {
              title: 'count items',
              instructions: 'Count the items',
              expected_output: 'a number',
              needs: [],
            },
          ],
        });
  });
  await expect(
    platform.turn(thread.id, '数えて', new AbortController().signal),
  ).resolves.toBe('Done: true');
  const flashTools = fake.requests
    .find((r) => r.body?.model === roles.chat.model)!
    .body.tools.map((t: any) => t.function.name);
  expect(flashTools).toEqual(
    expect.arrayContaining(['delegate_tasks', 'handover_to_planner']),
  );
  expect(flashTools).not.toContain('ask_advisor');
});

it('forces a handover when chat tries three tasks, and runs the planner', async () => {
  const { platform, dot } = fixture('on');
  const thread = await platform.createConversation(dot.id, 'Handover');
  jevAnswers({ chat: 0.9, planner: 0.05, worker: 0.05 });
  const task = (title: string) => ({
    title,
    instructions: title,
    expected_output: 'x',
    needs: [],
  });
  fake.onChat((body): FakeChatReply => {
    if (/Write a title/.test(JSON.stringify(body.messages)))
      return { content: 't' };
    if (body.model === roles.planner.model)
      return { content: 'planner report' };
    const results = toolResults(body);
    if (!results.length)
      return toolCall('delegate_tasks', {
        tasks: [task('a'), task('b'), task('c')],
      });
    if (results.length === 1) {
      expect(results[0]).toContain('refused');
      return toolCall('handover_to_planner', {
        goal: 'do a, b and c',
        reason: 'delegation refused',
      });
    }
    return { content: `relayed: ${results[1].includes('planner report')}` };
  });
  await expect(
    platform.turn(thread.id, '三つやって', new AbortController().signal),
  ).resolves.toBe('relayed: true');
  expect(chatModels()).toContain(roles.planner.model);
  expect(chatModels()).not.toContain(roles.worker.model);
  const log = (platform.config.selfhost!.planTurn as any).log.recent();
  expect(log[0]).toMatchObject({ final_role: 'chat', handed_over: 1 });
});

it('refuses chat delegation that Jev flags as high impact', async () => {
  const { platform, dot } = fixture('on');
  const thread = await platform.createConversation(dot.id, 'Risky');
  jevAnswers({ chat: 0.9, planner: 0.05, worker: 0.05 }, 0.05, 0.95);
  fake.onChat((body): FakeChatReply => {
    if (/Write a title/.test(JSON.stringify(body.messages)))
      return { content: 't' };
    const results = toolResults(body);
    return results.length
      ? {
          content: results[0].includes('planner must review')
            ? 'blocked'
            : 'ran',
        }
      : toolCall('delegate_tasks', {
          tasks: [
            {
              title: 'mail',
              instructions: 'Mail the report',
              expected_output: 'ok',
              needs: [],
            },
          ],
        });
  });
  await expect(
    platform.turn(thread.id, 'まとめて', new AbortController().signal),
  ).resolves.toBe('blocked');
  expect(chatModels()).not.toContain(roles.worker.model);
});

it('escalates to Sonnet on /escalate without calling Jev', async () => {
  const { platform, dot } = fixture('on');
  const thread = await platform.createConversation(dot.id, 'Escalate');
  fake.onMessages(() => ({
    body: {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '## Diagnosis\nWrong path.\n## Revised plan\n1. Use the other path.\n## Patch\nNone',
        },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 200 },
    },
  }));
  fake.onChat((body): FakeChatReply => {
    if (/Write a title/.test(JSON.stringify(body.messages)))
      return { content: 't' };
    const results = toolResults(body);
    return results.length
      ? {
          content: results[0].includes('Use the other path')
            ? 'fixed'
            : 'no advice',
        }
      : toolCall('ask_advisor', {
          goal_and_done_criteria: 'build passes',
          current_plan_and_blocker: 'stuck on path',
          questions: ['Which path?'],
        });
  });
  await expect(
    platform.turn(
      thread.id,
      '/escalate なぜ失敗する？',
      new AbortController().signal,
    ),
  ).resolves.toBe('fixed');
  expect(fake.requests.some((r) => r.path === '/systemone')).toBe(false);
  const advisor = fake.requests.find((r) => r.path === '/messages')!;
  expect(advisor.body.model).toBe(roles.escalation.model);
  expect(Object.keys(advisor.body).sort()).toEqual(
    ['max_tokens', 'messages', 'model', 'system'].sort(),
  );
  expect(chatModels()[0]).toBe(roles.planner.model);
});
