import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from '@ag-ui/client';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import {
  routing,
  type RoleName,
  type TurnRole,
} from '../../src/selfhost/config/models.js';
import type { CommandCodeClient } from '../../src/selfhost/llm/commandcode.js';
import {
  commandOf,
  decideRoute,
  fallbackRole,
  highImpactTasks,
  lastUserText,
  routeState,
  type JevVerdict,
} from '../../src/selfhost/router/jev.js';
import { forcedRole } from '../../src/selfhost/router/router.js';
import type { PolicyFlags } from '../../src/selfhost/usage/policy.js';
import {
  AdvisorLedger,
  adviceSections,
  advisorRefusal,
  ticketMarkdown,
  type AdvisorDeps,
  type AdvisorTicket,
} from '../../src/selfhost/agents/advisor.js';
import {
  handoverRefusal,
  type HandoverDeps,
  type HandoverTicket,
} from '../../src/selfhost/agents/handover.js';
import type { TurnState } from '../../src/selfhost/agents/delegate.js';
import { workerTools } from '../../src/selfhost/agents/delegate.js';
import { pool, withLock } from '../../src/selfhost/agents/subloop.js';

const NOW = Date.parse('2026-10-06T03:00:00Z');

/** All flags off; override only what a test is about. */
function flags(overrides: Partial<PolicyFlags> = {}): PolicyFlags {
  return {
    pauseEscalation: false,
    plannerUrgentOnly: false,
    stopBacklog: false,
    plannerOverWeekly: false,
    plannerReserved: false,
    advisorManualOnly: false,
    chatExhausted: false,
    coolingDown: {},
    behindPace: false,
    backlogWindowOpen: false,
    ...overrides,
  };
}

/** A Jev answer that picks `choice` with `confidence`, rest split evenly. */
function verdict(
  choice: TurnRole,
  confidence: number,
  highImpact = 0.05,
): JevVerdict {
  const others = (['chat', 'planner', 'worker'] as const).filter(
    (role) => role !== choice,
  );
  return {
    choice,
    probabilities: {
      [choice]: confidence,
      ...Object.fromEntries(
        others.map((role) => [role, (1 - confidence) / others.length]),
      ),
    },
    highImpact,
    latencyMs: 120,
  };
}

const route = (
  jev: JevVerdict | undefined,
  policy: Partial<PolicyFlags> = {},
  text = 'Summarize this article for me',
) => decideRoute({ text, jev, policy: flags(policy), now: NOW });

let counter = 0;
const message = (role: string, content: unknown, extra = {}): Message =>
  ({ id: `m${counter++}`, role, content, ...extra }) as unknown as Message;
const user = (content: unknown, extra = {}) => message('user', content, extra);
const assistant = (content: unknown) => message('assistant', content);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('commandOf', () => {
  it.each([
    ['/plan write a report', 'plan'],
    ['  /plan', 'plan'],
    ['/PLAN shout', 'plan'],
    ['/escalate why is this failing', 'escalate'],
    ['\n/Escalate', 'escalate'],
    ['/plan日本語の依頼', 'plan'],
  ])('reads %j as %s', (text, expected) => {
    expect(commandOf(text)).toBe(expected);
  });

  it.each([
    ['no command here'],
    ['please /plan this'],
    ['/planet'],
    ['/escalated'],
    ['/unknown'],
    ['plan'],
    [''],
  ])('ignores %j', (text) => {
    expect(commandOf(text)).toBeUndefined();
  });
});

describe('lastUserText', () => {
  it('returns the most recent user message, skipping later assistant turns', () => {
    expect(
      lastUserText([
        user('first'),
        assistant('reply'),
        user('second'),
        assistant('ok'),
      ]),
    ).toBe('second');
  });

  it('strips the page context prefix', () => {
    expect(
      lastUserText([
        user('From [My page](/#/spaces/s1/pages/p1):\n\nrewrite the intro'),
      ]),
    ).toBe('rewrite the intro');
  });

  it('keeps text that only looks similar to the prefix', () => {
    expect(lastUserText([user('From the top: do it')])).toBe(
      'From the top: do it',
    );
  });

  it('joins the text parts of a multi-part message with newlines', () => {
    expect(
      lastUserText([
        user([
          { type: 'text', text: 'look at' },
          { type: 'binary' },
          { type: 'text', text: 'this' },
        ]),
      ]),
    ).toBe('look at\nthis');
  });

  it('returns an empty string without a user message', () => {
    expect(lastUserText([])).toBe('');
    expect(lastUserText([assistant('hello')])).toBe('');
  });
});

describe('routeState', () => {
  it('is empty without a user message', () => {
    expect(routeState([])).toBe('');
    expect(routeState([message('system', 'be nice'), assistant('hi')])).toBe(
      '',
    );
  });

  it('is only the request when there is no earlier exchange', () => {
    expect(routeState([user('hello')])).toBe('hello');
    expect(routeState([user('hello'), assistant('hi')])).toBe('hello');
  });

  it('includes the previous exchange before the request', () => {
    expect(
      routeState([
        user('draft a poem'),
        assistant('Roses are red'),
        user('shorter please'),
      ]),
    ).toBe(
      'Earlier:\nuser: draft a poem\nassistant: Roses are red\n\nRequest:\nshorter please',
    );
  });

  it('keeps only the last exchange and ignores system and tool messages', () => {
    const state = routeState([
      user('oldest'),
      assistant('older reply'),
      message('system', 'sys'),
      user('previous'),
      message('tool', 'tool output'),
      assistant('previous reply'),
      user('now'),
    ]);
    expect(state).toBe(
      'Earlier:\nuser: previous\nassistant: previous reply\n\nRequest:\nnow',
    );
  });

  it('strips the page prefix from the request and the earlier turns', () => {
    const prefix = 'From [Notes](/#/spaces/s/pages/p):\n\n';
    const state = routeState([
      user(`${prefix}first`),
      assistant(`${prefix}answer`),
      user(`${prefix}second`),
    ]);
    expect(state).toBe(
      'Earlier:\nuser: first\nassistant: answer\n\nRequest:\nsecond',
    );
  });

  it('caps the request at 2000 characters and keeps the start', () => {
    const state = routeState([user(`${'あ'.repeat(2000)}TAIL`)]);
    expect(state).toBe('あ'.repeat(2000));
  });

  it('caps the earlier excerpt at 1000 characters and keeps its end', () => {
    const state = routeState([
      user('x'.repeat(900)),
      assistant(`${'y'.repeat(900)}END`),
      user('go'),
    ]);
    const earlier = state.slice(
      'Earlier:\n'.length,
      state.indexOf('\n\nRequest:'),
    );
    expect(earlier).toHaveLength(1000);
    expect(earlier.endsWith('yyyEND')).toBe(true);
    expect(state.endsWith('Request:\ngo')).toBe(true);
  });
});

describe('fallbackRole', () => {
  it('sends short plain requests to chat', () => {
    expect(fallbackRole('What time is it in Tokyo?')).toBe('chat');
    expect(fallbackRole('')).toBe('chat');
  });

  it('switches to planner just past the length threshold', () => {
    const limit = routing.fallbackRule.plannerMinChars;
    expect(fallbackRole('a'.repeat(limit))).toBe('chat');
    expect(fallbackRole('a'.repeat(limit + 1))).toBe('planner');
    expect(fallbackRole('あ'.repeat(limit + 1))).toBe('planner');
  });

  it.each([
    ['dash bullets', '- one\n- two\n- three'],
    ['star bullets', '* one\n* two\n* three'],
    ['dot bullets', '• one\n• two\n• three'],
    ['numbered with dots', '1. one\n2. two\n3. three'],
    ['numbered with parentheses', '1) one\n2) two\n3) three'],
    ['circled numbers with a space', '① 調べる\n② まとめる\n③ 送る'],
    [
      'circled numbers with a full-width space',
      '①　調べる\n②　まとめる\n③　送る',
    ],
    ['indented items', '  - one\n    - two\n\t- three'],
    ['mixed markers', 'Do these:\n1. one\n- two\n② three'],
  ])('counts %s as steps', (_name, text) => {
    expect(fallbackRole(text)).toBe('planner');
  });

  it('needs three steps, not two', () => {
    expect(fallbackRole('- one\n- two')).toBe('chat');
    expect(fallbackRole('① 調べる\n② まとめる')).toBe('chat');
  });

  it('ignores lines that only resemble list markers', () => {
    expect(fallbackRole('-one\n-two\n-three')).toBe('chat');
    expect(fallbackRole('1.5 million\n2.5 million\n3.5 million')).toBe('chat');
    expect(fallbackRole('a - b - c - d')).toBe('chat');
  });

  // Japanese numbered lists are normally written without a space after the
  // marker ("①調べる"). The regex in fallbackRole() requires whitespace after
  // the circled number, so these three steps count as zero and the request
  // goes to chat instead of planner. Expected: planner.
  it('counts circled numbers written without a space', () => {
    expect(fallbackRole('①調べる\n②まとめる\n③送る')).toBe('planner');
  });
  it('counts "・" bullets and full-width numbering ("１．") as steps', () => {
    expect(fallbackRole('・調べる\n・まとめる\n・送る')).toBe('planner');
    expect(fallbackRole('１．調べる\n２．まとめる\n３．送る')).toBe('planner');
    expect(fallbackRole('1.5kmを走った\n2.0倍\n3.3%')).toBe('chat');
  });
});

describe('decideRoute', () => {
  describe('commands', () => {
    it('sends /plan to the planner without looking at Jev', () => {
      const decision = route(
        verdict('chat', 0.99),
        {},
        '/plan write the report',
      );
      expect(decision).toMatchObject({
        role: 'planner',
        reason: 'command',
        command: 'plan',
      });
    });

    it('marks /escalate with its command', () => {
      expect(route(undefined, {}, '/escalate fix it')).toMatchObject({
        role: 'planner',
        reason: 'command',
        command: 'escalate',
      });
    });

    it('flags a command that mentions a risky verb as high impact', () => {
      expect(
        route(undefined, {}, '/plan delete the old backups').highImpact,
      ).toBe(true);
      expect(route(undefined, {}, '/plan outline the book').highImpact).toBe(
        false,
      );
    });

    it('is not demoted by the planner budget flags', () => {
      const decision = route(
        undefined,
        {
          plannerUrgentOnly: true,
          plannerReserved: true,
          plannerOverWeekly: true,
        },
        '/plan x',
      );
      expect(decision).toMatchObject({ role: 'planner', reason: 'command' });
    });

    it('still falls back when the planner is cooling down', () => {
      const decision = route(
        undefined,
        { coolingDown: { planner: NOW + 1 } },
        '/plan x',
      );
      expect(decision).toMatchObject({
        role: 'chat',
        reason: 'policy:coolingDown',
        command: 'plan',
      });
    });
  });

  describe('fallback rule', () => {
    it('applies when Jev is missing', () => {
      expect(route(undefined)).toMatchObject({
        role: 'chat',
        reason: 'fallback_rule',
      });
    });

    it('applies when Jev reported an error and keeps the verdict for the log', () => {
      const jev: JevVerdict = {
        latencyMs: 3000,
        error: 'TimeoutError: aborted',
      };
      const decision = route(jev);
      expect(decision).toMatchObject({ role: 'chat', reason: 'fallback_rule' });
      expect(decision.jev).toBe(jev);
    });

    it('applies when Jev gave no choice', () => {
      expect(route({ latencyMs: 5 })).toMatchObject({
        reason: 'fallback_rule',
      });
    });

    it('uses the length and step rules to pick the planner', () => {
      const long = 'x'.repeat(routing.fallbackRule.plannerMinChars + 1);
      expect(route(undefined, {}, long)).toMatchObject({
        role: 'planner',
        reason: 'fallback_rule',
      });
      expect(route(undefined, {}, '- a\n- b\n- c')).toMatchObject({
        role: 'planner',
        reason: 'fallback_rule',
      });
    });

    it('detects a risky request by keyword', () => {
      expect(
        route(undefined, {}, 'Please send the invoice to Bob').highImpact,
      ).toBe(true);
      expect(route(undefined, {}, '請求書を送信して').highImpact).toBe(true);
      expect(route(undefined, {}, 'Summarize the article').highImpact).toBe(
        false,
      );
    });

    it('is still demoted by plannerUrgentOnly when it picks the planner', () => {
      const long = 'x'.repeat(routing.fallbackRule.plannerMinChars + 1);
      expect(route(undefined, { plannerUrgentOnly: true }, long)).toMatchObject(
        {
          role: 'chat',
          reason: 'policy:plannerUrgentOnly',
        },
      );
    });
  });

  describe('Jev verdicts', () => {
    it.each<TurnRole>(['chat', 'planner', 'worker'])(
      'follows a confident %s choice',
      (choice) => {
        const jev = verdict(choice, 0.9);
        const decision = route(jev);
        expect(decision).toMatchObject({
          role: choice,
          reason: 'jev',
          highImpact: false,
        });
        expect(decision.jev).toBe(jev);
      },
    );

    it('sends high impact requests to the planner whatever Jev chose', () => {
      const decision = route(verdict('worker', 0.99, routing.highImpact));
      expect(decision).toMatchObject({
        role: 'planner',
        reason: 'high_impact',
        highImpact: true,
      });
    });

    it('treats an impact just under the threshold as not high impact', () => {
      expect(
        route(verdict('worker', 0.9, routing.highImpact - 0.01)),
      ).toMatchObject({
        role: 'worker',
        reason: 'jev',
        highImpact: false,
      });
    });

    it('reports high impact over low confidence when both apply', () => {
      expect(route(verdict('chat', 0.4, 0.95))).toMatchObject({
        role: 'planner',
        reason: 'high_impact',
      });
    });

    it('sends a low-confidence choice to the planner', () => {
      expect(
        route(verdict('chat', routing.minConfidence - 0.01)),
      ).toMatchObject({
        role: 'planner',
        reason: 'low_confidence',
        highImpact: false,
      });
    });

    it('accepts a choice exactly at the confidence threshold', () => {
      expect(route(verdict('chat', routing.minConfidence))).toMatchObject({
        role: 'chat',
        reason: 'jev',
      });
    });

    it('treats a choice without a probability as low confidence', () => {
      const jev: JevVerdict = {
        choice: 'chat',
        probabilities: {},
        highImpact: 0,
        latencyMs: 1,
      };
      expect(route(jev)).toMatchObject({
        role: 'planner',
        reason: 'low_confidence',
      });
    });

    it('treats a missing high impact answer as not high impact', () => {
      const jev: JevVerdict = {
        ...verdict('chat', 0.9),
        highImpact: undefined,
      };
      expect(route(jev)).toMatchObject({
        role: 'chat',
        reason: 'jev',
        highImpact: false,
      });
    });
  });

  describe('planner budget', () => {
    const minConfidence = routing.plannerOverWeeklyMinConfidence;

    it('plannerOverWeekly demotes a planner choice below 0.8 to chat', () => {
      expect(
        route(verdict('planner', minConfidence - 0.01), {
          plannerOverWeekly: true,
        }),
      ).toMatchObject({
        role: 'chat',
        reason: 'policy:plannerOverWeekly',
      });
    });

    it('plannerOverWeekly keeps a planner choice at 0.8 and above', () => {
      expect(
        route(verdict('planner', minConfidence), { plannerOverWeekly: true }),
      ).toMatchObject({
        role: 'planner',
        reason: 'jev',
      });
    });

    it('plannerOverWeekly sends a low-confidence request to chat instead of the planner', () => {
      expect(
        route(verdict('chat', 0.5), { plannerOverWeekly: true }),
      ).toMatchObject({
        role: 'chat',
        reason: 'policy:plannerOverWeekly',
      });
    });

    it('plannerOverWeekly leaves chat and worker choices alone', () => {
      expect(
        route(verdict('chat', 0.9), { plannerOverWeekly: true }),
      ).toMatchObject({ role: 'chat', reason: 'jev' });
      expect(
        route(verdict('worker', 0.9), { plannerOverWeekly: true }),
      ).toMatchObject({ role: 'worker', reason: 'jev' });
    });

    it('plannerOverWeekly does not apply to the fallback rule', () => {
      const long = 'x'.repeat(routing.fallbackRule.plannerMinChars + 1);
      expect(route(undefined, { plannerOverWeekly: true }, long)).toMatchObject(
        {
          role: 'planner',
          reason: 'fallback_rule',
        },
      );
    });

    it('plannerUrgentOnly demotes a planner choice to chat', () => {
      expect(
        route(verdict('planner', 0.95), { plannerUrgentOnly: true }),
      ).toMatchObject({
        role: 'chat',
        reason: 'policy:plannerUrgentOnly',
      });
    });

    it('plannerUrgentOnly also demotes a low-confidence escalation to the planner', () => {
      expect(
        route(verdict('chat', 0.5), { plannerUrgentOnly: true }),
      ).toMatchObject({
        role: 'chat',
        reason: 'policy:plannerUrgentOnly',
      });
    });

    it('plannerReserved demotes a planner choice to chat', () => {
      expect(
        route(verdict('planner', 0.95), { plannerReserved: true }),
      ).toMatchObject({
        role: 'chat',
        reason: 'policy:plannerReserved',
      });
    });

    it('plannerUrgentOnly is reported ahead of plannerReserved', () => {
      expect(
        route(verdict('planner', 0.95), {
          plannerUrgentOnly: true,
          plannerReserved: true,
        }),
      ).toMatchObject({
        reason: 'policy:plannerUrgentOnly',
      });
    });

    it.each([
      ['plannerUrgentOnly'],
      ['plannerReserved'],
      ['plannerOverWeekly'],
    ] as const)('high impact bypasses %s', (flag) => {
      const decision = route(verdict('chat', 0.9, 0.95), { [flag]: true });
      expect(decision).toMatchObject({
        role: 'planner',
        reason: 'high_impact',
        highImpact: true,
      });
    });

    it('high impact still goes to chat when only the planner is rate limited', () => {
      expect(
        route(verdict('chat', 0.9, 0.95), {
          coolingDown: { planner: NOW + 1000 },
        }),
      ).toMatchObject({
        role: 'chat',
        reason: 'policy:coolingDown',
        highImpact: true,
      });
    });
  });

  describe('chat budget', () => {
    it('chatExhausted moves a chat choice to the worker', () => {
      expect(
        route(verdict('chat', 0.9), { chatExhausted: true }),
      ).toMatchObject({
        role: 'worker',
        reason: 'policy:chatExhausted',
      });
    });

    it('chatExhausted also catches the fallback rule and demoted planner requests', () => {
      expect(route(undefined, { chatExhausted: true })).toMatchObject({
        role: 'worker',
        reason: 'policy:chatExhausted',
      });
      expect(
        route(verdict('planner', 0.95), {
          chatExhausted: true,
          plannerReserved: true,
        }),
      ).toMatchObject({
        role: 'worker',
        reason: 'policy:chatExhausted',
      });
    });

    it('chatExhausted leaves planner and worker choices alone', () => {
      expect(
        route(verdict('planner', 0.95), { chatExhausted: true }),
      ).toMatchObject({ role: 'planner', reason: 'jev' });
      expect(
        route(verdict('worker', 0.95), { chatExhausted: true }),
      ).toMatchObject({ role: 'worker', reason: 'jev' });
    });
  });

  describe('cooling down', () => {
    const cool = (...roles: RoleName[]) =>
      Object.fromEntries(roles.map((role) => [role, NOW + 60_000]));

    it('moves a cooling planner to chat', () => {
      expect(
        route(verdict('planner', 0.95), { coolingDown: cool('planner') }),
      ).toMatchObject({
        role: 'chat',
        reason: 'policy:coolingDown',
      });
    });

    it('moves planner to chat to worker when both are cooling', () => {
      expect(
        route(verdict('planner', 0.95), {
          coolingDown: cool('planner', 'chat'),
        }),
      ).toMatchObject({
        role: 'worker',
        reason: 'policy:coolingDown',
      });
    });

    it('moves a cooling chat to the worker', () => {
      expect(
        route(verdict('chat', 0.9), { coolingDown: cool('chat') }),
      ).toMatchObject({
        role: 'worker',
        reason: 'policy:coolingDown',
      });
    });

    it('does not move a cooling worker, which has no fallback', () => {
      expect(
        route(verdict('worker', 0.9), { coolingDown: cool('worker') }),
      ).toMatchObject({
        role: 'worker',
        reason: 'jev',
      });
    });

    it('keeps the original role when every role is cooling down', () => {
      expect(
        route(verdict('planner', 0.95), {
          coolingDown: cool('planner', 'chat', 'worker'),
        }),
      ).toMatchObject({
        role: 'planner',
        reason: 'jev',
      });
    });

    it('ignores a cool-down that has ended, including exactly at its end', () => {
      expect(
        route(verdict('planner', 0.95), { coolingDown: { planner: NOW } }),
      ).toMatchObject({ role: 'planner' });
      expect(
        route(verdict('planner', 0.95), { coolingDown: { planner: NOW - 1 } }),
      ).toMatchObject({ role: 'planner' });
    });

    it('ignores cool-downs of roles that are not on the chain', () => {
      expect(
        route(verdict('chat', 0.9), {
          coolingDown: cool('escalation', 'router'),
        }),
      ).toMatchObject({
        role: 'chat',
        reason: 'jev',
      });
    });

    it('keeps the Jev verdict on the decision after every rewrite', () => {
      const jev = verdict('planner', 0.95);
      expect(
        route(jev, {
          plannerReserved: true,
          chatExhausted: true,
          coolingDown: cool('worker'),
        }).jev,
      ).toBe(jev);
    });

    // When the planner is cooling down the chain lands on chat, but the
    // chatExhausted check ran before the chain, so an exhausted chat role is
    // chosen anyway. Expected: worker (chat is replaced by the worker once its
    // monthly cap is used up).
    it('does not land on an exhausted chat role through the cool-down chain', () => {
      const decision = route(verdict('planner', 0.95), {
        chatExhausted: true,
        coolingDown: cool('planner'),
      });
      expect(decision.role).toBe('worker');
    });
  });
});

describe('highImpactTasks', () => {
  const texts = ['send the invoice to the customer', 'summarize the notes'];

  it('uses the keyword rule when there is no client', async () => {
    expect(await highImpactTasks(undefined, texts, {})).toEqual([true, false]);
    expect(
      await highImpactTasks(undefined, ['ファイルを削除して', 'まとめて'], {}),
    ).toEqual([true, false]);
  });

  it('returns an empty list for no tasks without calling the client', async () => {
    const systemOne = vi.fn();
    const client = { systemOne } as unknown as CommandCodeClient;
    expect(await highImpactTasks(client, [], {})).toEqual([]);
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('falls back to the keyword rule when the client throws', async () => {
    const systemOne = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { systemOne } as unknown as CommandCodeClient;
    expect(await highImpactTasks(client, texts, {})).toEqual([true, false]);
    expect(systemOne).toHaveBeenCalledTimes(1);
  });

  it('falls back to the keyword rule when the client throws synchronously', async () => {
    const client = {
      systemOne: () => {
        throw new Error('boom');
      },
    } as unknown as CommandCodeClient;
    expect(await highImpactTasks(client, texts, {})).toEqual([true, false]);
  });

  it('asks one noul question per task and applies the threshold', async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        task_0: { type: 'noul', noul: routing.highImpact },
        task_1: { type: 'noul', noul: routing.highImpact - 0.01 },
      },
    });
    const client = { systemOne } as unknown as CommandCodeClient;
    const result = await highImpactTasks(
      client,
      ['harmless wording', 'send the invoice'],
      {
        threadId: 't1',
        runId: 'r1',
      },
    );
    // Jev overrides the keyword rule in both directions.
    expect(result).toEqual([true, false]);
    const [questions, state, options] = systemOne.mock.calls[0];
    expect(Object.keys(questions)).toEqual(['task_0', 'task_1']);
    expect(questions.task_0.type).toBe('noul');
    expect(state).toBe('task_0: harmless wording\n\ntask_1: send the invoice');
    expect(options).toMatchObject({
      timeoutMs: routing.jevTimeoutMs,
      ctx: { threadId: 't1', runId: 'r1' },
    });
  });

  it('truncates each task to 1500 characters in the question state', async () => {
    const systemOne = vi.fn().mockResolvedValue({ answers: {} });
    const client = { systemOne } as unknown as CommandCodeClient;
    await highImpactTasks(client, ['a'.repeat(3000)], {});
    expect(systemOne.mock.calls[0][1]).toBe(`task_0: ${'a'.repeat(1500)}`);
  });

  it('uses the keyword rule per task when an answer is missing or has another type', async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        task_1: {
          type: 'choice',
          choice: 'x',
          confidence: 1,
          probabilities: {},
        },
      },
    });
    const client = { systemOne } as unknown as CommandCodeClient;
    expect(
      await highImpactTasks(
        client,
        ['delete everything', 'delete everything', 'read a page'],
        {},
      ),
    ).toEqual([true, true, false]);
  });
});

describe('forcedRole', () => {
  const withRole = (role: unknown) =>
    user('task', { metadata: { selfhostRole: role } });

  it.each<TurnRole>(['worker', 'chat', 'planner'])(
    'reads %s from the last user message',
    (role) => {
      expect(forcedRole([withRole(role)])).toBe(role);
    },
  );

  it.each([
    ['escalation'],
    ['router'],
    ['Worker'],
    [''],
    [undefined],
    [42],
    [null],
  ])('rejects %j', (role) => {
    expect(forcedRole([withRole(role)])).toBeUndefined();
  });

  it('is undefined without metadata or without messages', () => {
    expect(forcedRole([user('plain')])).toBeUndefined();
    expect(forcedRole([user('plain', { metadata: {} })])).toBeUndefined();
    expect(forcedRole([])).toBeUndefined();
  });

  it('only looks at the last user message', () => {
    expect(
      forcedRole([withRole('worker'), assistant('ok'), user('plain')]),
    ).toBeUndefined();
    expect(
      forcedRole([user('plain'), assistant('ok'), withRole('planner')]),
    ).toBe('planner');
  });

  it('ignores metadata on other roles', () => {
    const forgedAssistant = message('assistant', 'ok', {
      metadata: { selfhostRole: 'worker' },
    });
    expect(forcedRole([user('plain'), forgedAssistant])).toBeUndefined();
  });
});

describe('adviceSections', () => {
  const full = `## Diagnosis
The cache key ignores the locale.

## Revised plan
1. Add the locale to the key.
2. Re-run the failing test.

## Patch
\`\`\`diff
-key = id
+key = id + locale
\`\`\``;

  it('splits all three sections', () => {
    expect(adviceSections(full)).toEqual({
      diagnosis: 'The cache key ignores the locale.',
      revised_plan:
        '1. Add the locale to the key.\n2. Re-run the failing test.',
      patch: '```diff\n-key = id\n+key = id + locale\n```',
    });
  });

  it.each(['None', 'none', 'None.', '  NONE  '])(
    'drops a patch section that says %j',
    (none) => {
      const parsed = adviceSections(
        `## Diagnosis\nA\n## Revised plan\nB\n## Patch\n${none}\n`,
      );
      expect(parsed).toEqual({ diagnosis: 'A', revised_plan: 'B' });
      expect('patch' in parsed).toBe(false);
    },
  );

  it('keeps a patch section that only starts with None', () => {
    expect(
      adviceSections('## Diagnosis\nA\n## Patch\nNone of the tests cover this')
        .patch,
    ).toBe('None of the tests cover this');
  });

  it('falls back to the whole text as the diagnosis when no section is found', () => {
    expect(adviceSections('  Just a free-form answer.  ')).toEqual({
      diagnosis: 'Just a free-form answer.',
      revised_plan: '',
    });
  });

  it('handles missing sections independently', () => {
    expect(adviceSections('## Diagnosis\nOnly this')).toEqual({
      diagnosis: 'Only this',
      revised_plan: '',
    });
    const noDiagnosis = adviceSections('## Revised plan\nDo X');
    expect(noDiagnosis.revised_plan).toBe('Do X');
    expect(noDiagnosis.diagnosis).toBe('## Revised plan\nDo X');
  });

  it('accepts any heading case and spacing, and any section order', () => {
    expect(
      adviceSections(
        '##patch\nfix it\n## REVISED PLAN\nstep\n##   diagnosis   \ncause',
      ),
    ).toEqual({
      diagnosis: 'cause',
      revised_plan: 'step',
      patch: 'fix it',
    });
  });

  it('keeps deeper headings and blank lines inside their section', () => {
    const parsed = adviceSections(
      '## Diagnosis\nCause\n\n### Detail\nmore\n\n## Revised plan\nPlan',
    );
    expect(parsed.diagnosis).toBe('Cause\n\n### Detail\nmore');
    expect(parsed.revised_plan).toBe('Plan');
  });

  it('returns an empty section when two headings follow each other', () => {
    expect(adviceSections('## Diagnosis\n## Revised plan\nPlan')).toMatchObject(
      {
        diagnosis: '## Diagnosis\n## Revised plan\nPlan',
        revised_plan: 'Plan',
      },
    );
  });

  it('reads Japanese bodies unchanged', () => {
    expect(
      adviceSections(
        '## Diagnosis\nキャッシュが古い。\n## Revised plan\n1. 無効化する',
      ).diagnosis,
    ).toBe('キャッシュが古い。');
  });
});

describe('ticketMarkdown', () => {
  const ticket = (overrides: Partial<AdvisorTicket> = {}): AdvisorTicket => ({
    goal_and_done_criteria: 'Ship the report',
    current_plan_and_blocker: 'Step 2 fails',
    attempts_and_errors: 'Tried twice',
    relevant_excerpts: 'log line',
    questions: ['Why does it fail?', 'What next?'],
    ...overrides,
  });

  it('renders every section and numbers the questions', () => {
    const markdown = ticketMarkdown(ticket(), 60_000);
    expect(markdown).toBe(
      [
        '# Goal and done criteria\nShip the report',
        '# Current plan and where it is stuck\nStep 2 fails',
        '# Attempts and errors\nTried twice',
        '# Relevant excerpts\nlog line',
        '# Questions\n1. Why does it fail?\n2. What next?',
      ].join('\n\n'),
    );
  });

  it('writes (none) for empty optional sections', () => {
    const markdown = ticketMarkdown(
      ticket({ attempts_and_errors: '', relevant_excerpts: '' }),
      60_000,
    );
    expect(markdown).toContain('# Attempts and errors\n(none)');
    expect(markdown).toContain('# Relevant excerpts\n(none)');
  });

  it('truncates the excerpts from the end to stay within the limit', () => {
    const excerpts = Array.from({ length: 400 }, (_, i) => `line ${i}`).join(
      '\n',
    );
    const markdown = ticketMarkdown(
      ticket({ relevant_excerpts: excerpts }),
      1000,
    );
    expect(markdown.length).toBeLessThanOrEqual(1000);
    expect(markdown).toContain(
      '\n[truncated]\n\n# Questions\n1. Why does it fail?',
    );
    const kept = markdown.slice(
      markdown.indexOf('# Relevant excerpts\n') +
        '# Relevant excerpts\n'.length,
      markdown.indexOf('\n[truncated]'),
    );
    expect(kept.length).toBeGreaterThan(300);
    expect(excerpts.startsWith(kept)).toBe(true);
  });

  it('never truncates the other sections or the questions', () => {
    const markdown = ticketMarkdown(
      ticket({ relevant_excerpts: 'x'.repeat(50_000) }),
      700,
    );
    expect(markdown).toContain('Ship the report');
    expect(markdown).toContain('Step 2 fails');
    expect(markdown).toContain('Tried twice');
    expect(markdown).toContain('2. What next?');
  });

  it('does not touch excerpts that fit', () => {
    const excerpts = 'y'.repeat(300);
    const markdown = ticketMarkdown(
      ticket({ relevant_excerpts: excerpts }),
      60_000,
    );
    expect(markdown).toContain(excerpts);
    expect(markdown).not.toContain('[truncated]');
  });

  it('keeps no excerpt text when the other sections already fill the limit', () => {
    const markdown = ticketMarkdown(
      ticket({ relevant_excerpts: 'secret excerpt' }),
      50,
    );
    expect(markdown).not.toContain('secret');
    expect(markdown).toContain('[truncated]');
  });
});

describe('AdvisorLedger', () => {
  it('counts consultations since the start of the current JST day', () => {
    const db = new DatabaseSync(':memory:');
    let now = Date.parse('2026-10-06T14:59:59Z'); // 23:59:59 JST on the 6th
    const ledger = new AdvisorLedger(db, () => now);
    ledger.add('t', 'r1', false);
    expect(ledger.today()).toBe(1);
    now = Date.parse('2026-10-06T15:00:00Z'); // 00:00:00 JST on the 7th
    expect(ledger.today()).toBe(0);
    ledger.add('t', 'r2', true);
    ledger.add('t', 'r3', false);
    now = Date.parse('2026-10-07T14:00:00Z');
    expect(ledger.today()).toBe(2);
    db.close();
  });
});

describe('advisorRefusal', () => {
  const turnState = (overrides: Partial<TurnState> = {}): TurnState => ({
    dotId: 'dot',
    threadId: 'thread',
    runId: 'run',
    systemPrompt: '',
    highImpact: false,
    forceAdvisor: false,
    handovers: 0,
    advisorCalls: 0,
    failures: new Map(),
    ...overrides,
  });
  const deps = (
    options: {
      state?: Partial<TurnState>;
      policy?: Partial<PolicyFlags>;
      today?: number;
    } = {},
  ): AdvisorDeps => ({
    state: turnState(options.state),
    client: {} as CommandCodeClient,
    ledger: { today: () => options.today ?? 0 } as unknown as AdvisorLedger,
    policy: () => flags(options.policy),
    check: () => undefined,
    signal: new AbortController().signal,
    now: () => NOW,
  });

  it('allows a consultation when nothing limits it', () => {
    expect(advisorRefusal(deps())).toBeUndefined();
    expect(
      advisorRefusal(deps({ state: { advisorCalls: 1 }, today: 2 })),
    ).toBeUndefined();
  });

  it('refuses a third consultation in the same turn, even when forced', () => {
    expect(advisorRefusal(deps({ state: { advisorCalls: 2 } }))).toMatch(
      /already consulted twice/,
    );
    expect(
      advisorRefusal(deps({ state: { advisorCalls: 2, forceAdvisor: true } })),
    ).toMatch(/twice/);
  });

  it('refuses while the advisor model is rate limited, even when forced', () => {
    const policy = { coolingDown: { escalation: NOW + 1000 } };
    expect(advisorRefusal(deps({ policy }))).toMatch(/rate-limited/);
    expect(
      advisorRefusal(deps({ policy, state: { forceAdvisor: true } })),
    ).toMatch(/rate-limited/);
    expect(
      advisorRefusal(deps({ policy: { coolingDown: { escalation: NOW } } })),
    ).toBeUndefined();
  });

  it('refuses when the five-hour budget is nearly used', () => {
    expect(advisorRefusal(deps({ policy: { pauseEscalation: true } }))).toMatch(
      /5-hour budget/,
    );
  });

  it('refuses automatic escalation after the monthly advisor budget', () => {
    expect(
      advisorRefusal(deps({ policy: { advisorManualOnly: true } })),
    ).toMatch(/\/escalate/);
  });

  it('reports the five-hour pause before the monthly one', () => {
    expect(
      advisorRefusal(
        deps({ policy: { pauseEscalation: true, advisorManualOnly: true } }),
      ),
    ).toMatch(/5-hour/);
  });

  it('refuses at the daily limit and allows one below it', () => {
    expect(advisorRefusal(deps({ today: 3 }))).toMatch(
      /daily escalation limit/,
    );
    expect(advisorRefusal(deps({ today: 2 }))).toBeUndefined();
  });

  it('lets /escalate bypass the budget flags and the daily limit', () => {
    const forced = {
      state: { forceAdvisor: true },
      policy: { pauseEscalation: true, advisorManualOnly: true },
      today: 99,
    };
    expect(advisorRefusal(deps(forced))).toBeUndefined();
  });
});

describe('handoverRefusal', () => {
  const turnState = (overrides: Partial<TurnState> = {}): TurnState => ({
    dotId: 'dot',
    threadId: 'thread',
    runId: 'run',
    systemPrompt: '',
    highImpact: false,
    forceAdvisor: false,
    handovers: 0,
    advisorCalls: 0,
    failures: new Map(),
    ...overrides,
  });
  const deps = (
    options: { state?: Partial<TurnState>; policy?: Partial<PolicyFlags> } = {},
  ): HandoverDeps => ({
    state: turnState(options.state),
    policy: () => flags(options.policy),
    markHandover: () => undefined,
    runPlanner: async () => '',
    check: () => undefined,
    now: () => NOW,
  });
  const ticket = (overrides: Partial<HandoverTicket> = {}): HandoverTicket => ({
    goal: 'Compare three hosting plans',
    findings: 'Prices differ a lot',
    done: 'Read two pricing pages',
    reason: 'Needs several steps',
    recent_summary: 'Owner asked for a comparison',
    ...overrides,
  });

  it('allows the first handover', () => {
    expect(handoverRefusal(deps(), ticket())).toBeUndefined();
  });

  it('refuses a second handover in the same turn', () => {
    expect(
      handoverRefusal(deps({ state: { handovers: 1 } }), ticket()),
    ).toMatch(/already handed over once/);
  });

  it('refuses a ticket over the size limit and allows one exactly at it', () => {
    const base = ticket({
      goal: '',
      findings: '',
      done: '',
      reason: 'r',
      recent_summary: '',
    });
    const limit = 24_000;
    const filler = (n: number) => 'x'.repeat(n);
    expect(
      handoverRefusal(deps(), { ...base, goal: filler(limit - 1) }),
    ).toBeUndefined();
    expect(handoverRefusal(deps(), { ...base, goal: filler(limit) })).toMatch(
      /24001 characters; keep it under 24000/,
    );
  });

  it('refuses while the planner is rate limited', () => {
    const policy = { coolingDown: { planner: NOW + 1000 } };
    expect(handoverRefusal(deps({ policy }), ticket())).toMatch(/rate-limited/);
    expect(
      handoverRefusal(
        deps({ policy: { coolingDown: { planner: NOW - 1 } } }),
        ticket(),
      ),
    ).toBeUndefined();
    expect(
      handoverRefusal(
        deps({ policy: { coolingDown: { chat: NOW + 1000 } } }),
        ticket(),
      ),
    ).toBeUndefined();
  });

  it.each([
    ['plannerOverWeekly'],
    ['plannerReserved'],
    ['plannerUrgentOnly'],
  ] as const)('refuses an ordinary request when %s is set', (flag) => {
    expect(
      handoverRefusal(deps({ policy: { [flag]: true } }), ticket()),
    ).toMatch(/planning budget is nearly used/);
  });

  it.each([
    ['plannerOverWeekly'],
    ['plannerReserved'],
    ['plannerUrgentOnly'],
  ] as const)('lets a high impact turn through when %s is set', (flag) => {
    expect(
      handoverRefusal(
        deps({ policy: { [flag]: true }, state: { highImpact: true } }),
        ticket(),
      ),
    ).toBeUndefined();
  });

  it('treats a risky goal or reason as high impact', () => {
    const policy = { plannerOverWeekly: true };
    expect(
      handoverRefusal(
        deps({ policy }),
        ticket({ goal: 'Delete the old backups' }),
      ),
    ).toBeUndefined();
    expect(
      handoverRefusal(
        deps({ policy }),
        ticket({ reason: 'Customer asked to 送信 the quote' }),
      ),
    ).toBeUndefined();
    // Only the goal and the reason are checked, not the other ticket fields.
    expect(
      handoverRefusal(
        deps({ policy }),
        ticket({ findings: 'delete everything' }),
      ),
    ).toMatch(/budget/);
  });

  it('does not let high impact bypass a rate limit or the handover cap', () => {
    const state = { highImpact: true };
    expect(
      handoverRefusal(deps({ state: { ...state, handovers: 1 } }), ticket()),
    ).toMatch(/already handed over/);
    expect(
      handoverRefusal(
        deps({ state, policy: { coolingDown: { planner: NOW + 1000 } } }),
        ticket(),
      ),
    ).toMatch(/rate-limited/);
  });
});

describe('workerTools', () => {
  const ok = async () => 'ok';
  const tool = (
    name: string,
    execute: ((args: never) => Promise<unknown>) | undefined = ok,
  ) =>
    defineTool({
      name,
      description: name,
      parameters: z.object({}),
      execute: execute as () => Promise<unknown>,
    });
  const names = [
    'list_authorized_spaces',
    'list_space_pages',
    'read_space_page',
    'create_space_page',
    'edit_space_page',
    'search_web',
    'read_public_page',
    'computer_navigate',
    'computer_read',
    'computer_snapshot',
    'computer_screenshot',
    'computer_click',
    'computer_type',
    'computer_key',
    'computer_scroll',
    'computer_files_list',
    'computer_files_read',
    'computer_files_write',
    'computer_exec',
    'delegate_tasks',
  ];
  const base = () => names.map((name) => tool(name));
  const namesOf = (tools: ToolDefinition[]) => tools.map((entry) => entry.name);
  const readTools = [
    'list_authorized_spaces',
    'list_space_pages',
    'read_space_page',
  ];
  const computerNames = names.filter((name) => name.startsWith('computer_'));
  const call = (
    entry: ToolDefinition | undefined,
    input: unknown = {},
    context?: unknown,
  ) =>
    (
      entry!.execute as unknown as (
        input: unknown,
        context?: unknown,
      ) => Promise<unknown>
    )(input, context);
  const find = (tools: ToolDefinition[], name: string) =>
    tools.find((entry) => entry.name === name);

  it('gives only read-only page tools when nothing is needed', () => {
    expect(namesOf(workerTools(base(), [], 'dot-a'))).toEqual(readTools);
  });

  it('adds web tools for web and no computer tools', () => {
    expect(namesOf(workerTools(base(), ['web'], 'dot-a'))).toEqual([
      ...readTools,
      'search_web',
      'read_public_page',
    ]);
  });

  it('adds every computer tool for computer and no web tools', () => {
    expect(namesOf(workerTools(base(), ['computer'], 'dot-a'))).toEqual([
      ...readTools,
      ...computerNames,
    ]);
  });

  it('combines web and computer', () => {
    expect(namesOf(workerTools(base(), ['web', 'computer'], 'dot-a'))).toEqual([
      ...readTools,
      'search_web',
      'read_public_page',
      ...computerNames,
    ]);
  });

  it('never exposes page writes or delegation to workers', () => {
    const all = namesOf(workerTools(base(), ['web', 'computer'], 'dot-a'));
    for (const name of [
      'create_space_page',
      'edit_space_page',
      'delegate_tasks',
    ])
      expect(all).not.toContain(name);
  });

  it('wraps browser tools and passes files and shell through untouched', () => {
    const source = base();
    const tools = workerTools(source, ['computer'], 'dot-a');
    for (const name of [
      'navigate',
      'read',
      'snapshot',
      'screenshot',
      'click',
      'type',
      'key',
      'scroll',
    ])
      expect(find(tools, `computer_${name}`)).not.toBe(
        source.find((entry) => entry.name === `computer_${name}`),
      );
    for (const name of ['files_list', 'files_read', 'files_write', 'exec'])
      expect(find(tools, `computer_${name}`)).toBe(
        source.find((entry) => entry.name === `computer_${name}`),
      );
    expect(find(tools, 'read_space_page')).toBe(
      source.find((entry) => entry.name === 'read_space_page'),
    );
  });

  it('keeps the metadata of a wrapped tool', () => {
    const source = base();
    const wrapped = find(
      workerTools(source, ['computer'], 'dot-a'),
      'computer_click',
    )!;
    const original = source.find((entry) => entry.name === 'computer_click')!;
    expect(wrapped).toMatchObject({
      name: 'computer_click',
      description: original.description,
    });
    expect(wrapped.parameters).toBe(original.parameters);
  });

  it('forwards input and context to a wrapped tool and returns its result', async () => {
    const execute = vi.fn(async (_input: unknown, _context?: unknown) => ({
      clicked: true,
    }));
    const tools = workerTools(
      [tool('computer_click', execute as never)],
      ['computer'],
      'dot-a',
    );
    const context = { toolCallId: 'c1' };
    expect(await call(tools[0], { ref: 'e1' }, context)).toEqual({
      clicked: true,
    });
    expect(execute).toHaveBeenCalledWith({ ref: 'e1' }, context);
  });

  it('propagates a failure from a wrapped tool', async () => {
    const tools = workerTools(
      [
        tool('computer_click', (async () => {
          throw new Error('no such ref');
        }) as never),
      ],
      ['computer'],
      'dot-a',
    );
    await expect(call(tools[0])).rejects.toThrow('no such ref');
  });

  it('turns a synchronous throw in a wrapped tool into a rejection', async () => {
    const tools = workerTools(
      [
        tool('computer_click', (() => {
          throw new Error('sync');
        }) as never),
      ],
      ['computer'],
      'dot-a',
    );
    await expect(call(tools[0])).rejects.toThrow('sync');
  });

  it('keeps a browser tool without an executor as it is', () => {
    const bare = {
      name: 'computer_click',
      description: 'x',
      parameters: z.object({}),
    } as ToolDefinition;
    expect(workerTools([bare], ['computer'], 'dot-a')[0]).toBe(bare);
  });

  it('runs browser actions of one Dot one at a time', async () => {
    const gate = deferred();
    const log: string[] = [];
    const tools = workerTools(
      [
        tool('computer_navigate', async () => {
          log.push('navigate:start');
          await gate.promise;
          log.push('navigate:end');
        }),
        tool('computer_click', async () => {
          log.push('click');
        }),
      ],
      ['computer'],
      'dot-serial',
    );
    const navigating = call(find(tools, 'computer_navigate'));
    const clicking = call(find(tools, 'computer_click'));
    await flush();
    expect(log).toEqual(['navigate:start']);
    gate.resolve();
    await Promise.all([navigating, clicking]);
    expect(log).toEqual(['navigate:start', 'navigate:end', 'click']);
  });

  it('does not block browser actions of another Dot', async () => {
    const gate = deferred();
    const log: string[] = [];
    const slow = tool('computer_navigate', async () => {
      log.push('a:start');
      await gate.promise;
    });
    const fast = tool('computer_navigate', async () => {
      log.push('b:done');
    });
    const first = call(
      find(workerTools([slow], ['computer'], 'dot-one'), 'computer_navigate'),
    );
    const second = call(
      find(workerTools([fast], ['computer'], 'dot-two'), 'computer_navigate'),
    );
    await second;
    expect(log).toEqual(['a:start', 'b:done']);
    gate.resolve();
    await first;
  });

  it('lets shell and file tools run while a browser action is in flight', async () => {
    const gate = deferred();
    const log: string[] = [];
    const tools = workerTools(
      [
        tool('computer_navigate', async () => {
          await gate.promise;
        }),
        tool('computer_exec', async () => {
          log.push('exec');
        }),
        tool('computer_files_read', async () => {
          log.push('files_read');
        }),
      ],
      ['computer'],
      'dot-parallel',
    );
    const navigating = call(find(tools, 'computer_navigate'));
    await call(find(tools, 'computer_exec'));
    await call(find(tools, 'computer_files_read'));
    expect(log).toEqual(['exec', 'files_read']);
    gate.resolve();
    await navigating;
  });

  it('keeps the browser usable after a failed browser action', async () => {
    const tools = workerTools(
      [
        tool('computer_navigate', async () => {
          throw new Error('timeout');
        }),
        tool('computer_read', async () => 'page text'),
      ],
      ['computer'],
      'dot-recover',
    );
    await expect(call(find(tools, 'computer_navigate'))).rejects.toThrow(
      'timeout',
    );
    expect(await call(find(tools, 'computer_read'))).toBe('page text');
  });
});

describe('pool', () => {
  it('returns results in input order whatever order the tasks finish', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const running = pool([0, 1, 2], 3, (index) => gates[index].promise);
    gates[2].resolve('c');
    gates[0].resolve('a');
    gates[1].resolve('b');
    expect(await running).toEqual(['a', 'b', 'c']);
  });

  it('passes the task and its index to the runner', async () => {
    expect(
      await pool(['x', 'y', 'z'], 2, async (task, index) => `${index}:${task}`),
    ).toEqual(['0:x', '1:y', '2:z']);
  });

  it('never runs more than the limit at once and starts the next task as soon as one ends', async () => {
    const started: number[] = [];
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    let active = 0;
    let peak = 0;
    const running = pool([0, 1, 2, 3, 4], 2, async (index) => {
      started.push(index);
      active++;
      peak = Math.max(peak, active);
      try {
        return await gates[index].promise;
      } finally {
        active--;
      }
    });
    await flush();
    expect(started).toEqual([0, 1]);
    gates[1].resolve(11);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    gates[0].resolve(10);
    gates[2].resolve(12);
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates[3].resolve(13);
    gates[4].resolve(14);
    expect(await running).toEqual([10, 11, 12, 13, 14]);
    expect(peak).toBe(2);
  });

  it('runs everything at once when the limit is larger than the task count', async () => {
    let active = 0;
    let peak = 0;
    const gate = deferred();
    const running = pool([1, 2, 3], 10, async () => {
      peak = Math.max(peak, ++active);
      await gate.promise;
      active--;
    });
    await flush();
    expect(peak).toBe(3);
    gate.resolve();
    await running;
  });

  it('treats a limit below one as one', async () => {
    let active = 0;
    let peak = 0;
    const result = await pool([1, 2, 3], 0, async (task) => {
      peak = Math.max(peak, ++active);
      await flush();
      active--;
      return task * 2;
    });
    expect(result).toEqual([2, 4, 6]);
    expect(peak).toBe(1);
  });

  it('returns an empty list for no tasks', async () => {
    const run = vi.fn();
    expect(await pool([], 3, run)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects when a task rejects', async () => {
    await expect(
      pool([1, 2, 3], 2, async (task) => {
        if (task === 2) throw new Error('task failed');
        return task;
      }),
    ).rejects.toThrow('task failed');
  });
});

describe('withLock', () => {
  it('returns the value of the work', async () => {
    expect(await withLock('lock-value', async () => 42)).toBe(42);
  });

  it('runs work on the same key one after another, in call order', async () => {
    const events: string[] = [];
    const gate = deferred();
    const first = withLock('lock-serial', async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
      return 1;
    });
    const second = withLock('lock-serial', async () => {
      events.push('second:start');
      return 2;
    });
    const third = withLock('lock-serial', async () => {
      events.push('third:start');
      return 3;
    });
    await flush();
    expect(events).toEqual(['first:start']);
    gate.resolve();
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'third:start',
    ]);
  });

  it('does not make different keys wait for each other', async () => {
    const events: string[] = [];
    const gate = deferred();
    const slow = withLock('lock-a', async () => {
      events.push('a:start');
      await gate.promise;
    });
    await withLock('lock-b', async () => {
      events.push('b:done');
    });
    expect(events).toEqual(['a:start', 'b:done']);
    gate.resolve();
    await slow;
  });

  it('still runs the next work after a failure and reports the failure to its own caller', async () => {
    const failing = withLock('lock-fail', async () => {
      throw new Error('boom');
    });
    const failed = expect(failing).rejects.toThrow('boom');
    const next = withLock('lock-fail', async () => 'recovered');
    await failed;
    expect(await next).toBe('recovered');
  });

  it('can be reused after the queue drained', async () => {
    expect(await withLock('lock-reuse', async () => 1)).toBe(1);
    await flush();
    expect(await withLock('lock-reuse', async () => 2)).toBe(2);
  });

  it('does not start work that was queued behind a failed run before it finishes', async () => {
    const events: string[] = [];
    const gate = deferred();
    const first = withLock('lock-order', async () => {
      await gate.promise;
      events.push('first');
      throw new Error('first failed');
    });
    const failed = expect(first).rejects.toThrow('first failed');
    const second = withLock('lock-order', async () => {
      events.push('second');
    });
    await flush();
    expect(events).toEqual([]);
    gate.resolve();
    await failed;
    await second;
    expect(events).toEqual(['first', 'second']);
  });
});
