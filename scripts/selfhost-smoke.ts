/**
 * Live smoke test for the CommandCode Provider API, run before turning the
 * model router on. It sends a handful of tiny requests (a few cents at most)
 * and prints one row per check with latency, tokens and estimated cost.
 *
 *   npm run selfhost:smoke
 *
 * Reads COMMAND_CODE_API_KEY and, optionally, COMMAND_CODE_BASE_URL from the
 * environment or .env. The key is never printed.
 */
import { chat, maxIterations, toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import {
  prices,
  roles,
  type ModelPrice,
  type RoleName,
} from '../src/selfhost/config/models.js';
import {
  CommandCodeClient,
  CommandCodeError,
  DEFAULT_BASE_URL,
} from '../src/selfhost/llm/commandcode.js';
import { readProviderError } from '../src/selfhost/llm/metered-fetch.js';
import { ROUTE_QUESTIONS } from '../src/selfhost/router/jev.js';
import type { UsageRecord, UsageRecorder } from '../src/selfhost/types.js';

/**
 * Output cap per request. Reasoning models count their thinking against it,
 * so a smaller cap can end with an empty answer.
 */
const OUTPUT_CAP = 512;
const REQUEST_TIMEOUT_MS = 60_000;
const SAMPLE_REQUEST =
  '来週の月曜までに、取引先3社へ見積書をメールで送って、返信を表にまとめて。';

const apiKey = process.env.COMMAND_CODE_API_KEY?.trim();
if (!apiKey) {
  console.error(
    [
      'COMMAND_CODE_API_KEY is not set.',
      'Add it to .env (see docs/selfhost/SETUP.md) or export it, then run npm run selfhost:smoke again.',
      'OPENAI_API_KEY is not used by this script.',
    ].join('\n'),
  );
  process.exit(1);
}
const baseURL = (
  process.env.COMMAND_CODE_BASE_URL?.trim() || DEFAULT_BASE_URL
).replace(/\/+$/, '');

class MemoryRecorder implements UsageRecorder {
  readonly records: UsageRecord[] = [];
  record(record: UsageRecord) {
    this.records.push(record);
  }
  forRun(runId: string) {
    return this.records.filter((record) => record.runId === runId);
  }
}
const recorder = new MemoryRecorder();
const client = new CommandCodeClient({ apiKey, baseURL, recorder });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Same formula as UsageMeter.cost, without the calibration factor. */
function estimateCost(record: UsageRecord): number {
  const price: ModelPrice | undefined = prices[record.model];
  if (!price) return 0;
  const cached = record.cachedInputTokens;
  const fresh = Math.max(0, record.inputTokens - cached);
  return (
    (fresh * price.inputPerM +
      cached * (price.cacheReadPerM ?? price.inputPerM) +
      record.outputTokens * price.outputPerM) /
    1e6
  );
}

/** Streamed and JSON bodies are recorded just after the caller returns. */
async function settle(runId: string) {
  let last = -1;
  for (let attempt = 0; attempt < 20; attempt++) {
    const count = recorder.forRun(runId).length;
    if (count === last) return;
    last = count;
    await sleep(50);
  }
}

const redact = (text: string) => text.split(apiKey).join('***');
const oneLine = (text: string, max = 160) => {
  const flat = redact(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

let upgradeRequired = false;
const looksLikeUpgrade = (...parts: (string | number | undefined)[]) =>
  /upgrade/i.test(parts.filter((part) => part !== undefined).join(' '));

function explain(error: unknown): string {
  if (error instanceof CommandCodeError) {
    if (error.status === 403 && looksLikeUpgrade(error.type, error.message))
      upgradeRequired = true;
    return oneLine(
      `HTTP ${error.status}${error.type ? ` ${error.type}` : ''}: ${error.message}`,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (looksLikeUpgrade(message) && /\b403\b/.test(message))
    upgradeRequired = true;
  return oneLine(
    `${error instanceof Error ? error.name : 'Error'}: ${message}`,
  );
}

interface Row {
  check: string;
  model: string;
  ok: boolean;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  note: string;
}

const rows: Row[] = [];
let sequence = 0;
const columns = [22, 30, 5, 7, 7, 7, 10] as const;
const cells = (values: (string | number)[]) =>
  values
    .slice(0, columns.length)
    .map((value, index) =>
      index >= 3 && index <= 5
        ? String(value).padStart(columns[index])
        : String(value).padEnd(columns[index]),
    )
    .join('  ') + (values[columns.length] ? `  ${values[columns.length]}` : '');

function printRow(row: Row) {
  const metered = row.inputTokens !== undefined;
  console.log(
    cells([
      row.check,
      row.model,
      row.ok ? 'ok' : 'FAIL',
      Math.round(row.ms),
      metered ? row.inputTokens! : '-',
      metered ? row.outputTokens! : '-',
      metered ? `$${row.costUSD!.toFixed(6)}` : '-',
      row.note,
    ]),
  );
}

/** Runs one check; the body returns a short note, or throws to fail. */
async function check(
  name: string,
  model: string,
  body: (runId: string) => Promise<string>,
) {
  const runId = `smoke-${++sequence}`;
  const started = performance.now();
  let ok = true;
  let note: string;
  try {
    note = await body(runId);
  } catch (error) {
    ok = false;
    note = explain(error);
  }
  const ms = performance.now() - started;
  await settle(runId);
  const used = recorder.forRun(runId);
  for (const record of used)
    if (record.status === 403 && looksLikeUpgrade(record.errorType))
      upgradeRequired = true;
  const row: Row = {
    check: name,
    model,
    ok,
    ms,
    note,
    ...(used.length && {
      inputTokens: used.reduce((sum, record) => sum + record.inputTokens, 0),
      outputTokens: used.reduce((sum, record) => sum + record.outputTokens, 0),
      costUSD: used.reduce((sum, record) => sum + estimateCost(record), 0),
    }),
  };
  rows.push(row);
  printRow(row);
}

async function listModels(): Promise<string[]> {
  const response = await fetch(`${baseURL}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    const { message, type } = readProviderError(text);
    throw new CommandCodeError(
      message ?? `GET /models failed with status ${response.status}`,
      response.status,
      type,
    );
  }
  const json: unknown = JSON.parse(text);
  const list: unknown = Array.isArray(json)
    ? json
    : (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(list))
    throw new Error('GET /models did not return a model list.');
  return list.flatMap((entry) =>
    typeof entry?.id === 'string' ? [entry.id as string] : [],
  );
}

const chatRoles = ['chat', 'planner', 'worker'] as const satisfies RoleName[];
const expectedModels = (Object.keys(roles) as RoleName[])
  .filter((role) => role !== 'router')
  .map((role) => roles[role].model);

console.log(`CommandCode smoke test against ${baseURL}`);
console.log(
  `Output cap ${OUTPUT_CAP} tokens per request; costs use the prices in src/selfhost/config/models.ts.\n`,
);
console.log(
  cells(['check', 'model', 'ok', 'ms', 'in', 'out', 'est. USD', 'note']),
);

await check('GET /models', '(all)', async () => {
  const ids = await listModels();
  const missing = expectedModels.filter((id) => !ids.includes(id));
  if (missing.length)
    throw new Error(`missing from /models: ${missing.join(', ')}`);
  return `${ids.length} models, all ${expectedModels.length} role models listed (${roles.router.model} is /systemone only)`;
});

await check('systemone route', roles.router.model, async (runId) => {
  const result = await client.systemOne(ROUTE_QUESTIONS, SAMPLE_REQUEST, {
    timeoutMs: 10_000,
    ctx: { runId },
  });
  const route = result.answers.route;
  const impact = result.answers.high_impact;
  if (route?.type !== 'choice' || impact?.type !== 'noul')
    throw new Error('answers have unexpected question types');
  if (!['chat', 'planner', 'worker'].includes(route.choice))
    throw new Error(`unknown route choice: ${route.choice}`);
  const confidence = route.probabilities[route.choice] ?? route.confidence;
  return `route=${route.choice} (${confidence.toFixed(2)}), high_impact=${impact.noul.toFixed(2)}`;
});

let toolRuns = 0;
const addNumbers = toolDefinition({
  name: 'add_numbers',
  description: 'Add two numbers and return their sum.',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
}).server(async ({ a, b }) => {
  toolRuns++;
  return { sum: a + b };
});

for (const role of chatRoles) {
  const model = roles[role].model;
  const adapterFor = (runId: string) =>
    client.chatAdapter({ role, model, runId }, { maxRetries: 0 });

  await check(`${role} plain`, model, async (runId) => {
    const text = await chat({
      adapter: adapterFor(runId),
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      modelOptions: { max_completion_tokens: OUTPUT_CAP },
      debug: false,
      stream: false,
    });
    if (!text.trim())
      throw new Error('empty reply (reasoning may have used the output cap)');
    return `reply: ${oneLine(text, 40)}`;
  });

  await check(`${role} tool call`, model, async (runId) => {
    toolRuns = 0;
    const text = await chat({
      adapter: adapterFor(runId),
      messages: [
        {
          role: 'user',
          content:
            'Use the add_numbers tool to add 17 and 25, then tell me the sum in one short sentence.',
        },
      ],
      tools: [addNumbers],
      agentLoopStrategy: maxIterations(4),
      modelOptions: { max_completion_tokens: OUTPUT_CAP },
      debug: false,
      stream: false,
    });
    if (toolRuns === 0) throw new Error('the model never called add_numbers');
    if (!text.includes('42'))
      throw new Error(
        `tool ran ${toolRuns}x but the answer lacks 42: ${oneLine(text, 60)}`,
      );
    return `tool ran ${toolRuns}x, answer: ${oneLine(text, 40)}`;
  });
}

await check('messages (escalation)', roles.escalation.model, async (runId) => {
  const result = await client.messages(
    {
      model: roles.escalation.model,
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      maxTokens: OUTPUT_CAP,
    },
    { ctx: { runId } },
  );
  if (!result.text.trim())
    throw new Error(
      `empty reply (stop_reason=${result.stopReason ?? 'unknown'})`,
    );
  return `reply: ${oneLine(result.text, 40)}`;
});

const failed = rows.filter((row) => !row.ok);
const total = recorder.records.reduce(
  (sum, record) => sum + estimateCost(record),
  0,
);
const inputTokens = recorder.records.reduce((sum, r) => sum + r.inputTokens, 0);
const outputTokens = recorder.records.reduce(
  (sum, r) => sum + r.outputTokens,
  0,
);
console.log(
  `\n${rows.length - failed.length}/${rows.length} checks passed. ${recorder.records.length} requests, ${inputTokens} in / ${outputTokens} out tokens, estimated cost $${total.toFixed(6)}.`,
);
if (upgradeRequired)
  console.log(
    '\nThe plan lacks Provider API access (403 upgrade_required). Check that your CommandCode plan includes the Provider API, then run this again.',
  );
else if (failed.length)
  console.log('\nFailed: ' + failed.map((row) => row.check).join(', '));
process.exitCode = failed.length ? 1 : 0;
