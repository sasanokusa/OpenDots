#!/usr/bin/env node
/* global fetch, setTimeout, clearTimeout, setInterval, URL */
// A stand-in for `sasacode -p <prompt> --output jsonl --control stdio` used by
// the harness tests. It parses the same argv, reads $SASACODE_HOME/config.json
// for the relay and MCP URLs, and picks what to do from the prompt text:
//
//   (default)            session, one assistant reply that echoes the prompt and
//                        the facts a test wants to check, agent_end done
//   [tool:<name> <json>] a tool call that really goes through the MCP endpoint
//                        (repeatable); then a final reply
//   [tools]              lists the MCP tools and echoes their names
//   [llm] / [llm:<id>]   one non-streaming chat completion through the relay
//   [system]             echoes the whole appended system prompt file
//   [approve]            approval_request, waits for the approval line on stdin
//   [slow]               waits for {"type":"abort"} on stdin, ends "aborted"
//   [stubborn]           like [slow] but ignores abort (only SIGTERM stops it)
//   [fail]               error line, agent_end "error", exit 1
//   [crash]              no JSON at all, a message on stderr, exit 3
//   -r stale...          exits 1 at once without any output (stale session)
//
// A tool result for review_space_page is followed by "more work": the fake
// waits for the abort the harness is expected to send instead of finishing
// (FAKE_SASACODE_REVIEW_WAIT_MS, default 3000, bounds the wait).
//
// When FAKE_SASACODE_LOG is set, every invocation appends one JSON line with
// its argv, cwd and the facts below, even when it exits without output.
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const prompt = flag('-p') ?? '';
const model = flag('-m');
const resume = flag('-r');
const maxTurns = flag('--max-turns');
const systemFile = flag('--append-system-prompt-file');
const systemText = systemFile ? readFileSync(systemFile, 'utf8') : '';

if (process.env.FAKE_SASACODE_LOG) {
  appendFileSync(
    process.env.FAKE_SASACODE_LOG,
    `${JSON.stringify({
      argv,
      prompt,
      model,
      resume,
      maxTurns,
      cwd: process.cwd(),
      home: process.env.SASACODE_HOME,
      system: systemText,
      systemMode: systemFile ? statSync(systemFile).mode & 0o777 : undefined,
      scratchMode: systemFile
        ? statSync(dirname(systemFile)).mode & 0o777
        : undefined,
    })}\n`,
  );
}

const out = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const finish = (code = 0) => process.stdout.write('', () => process.exit(code));

// Lines the parent writes on stdin, kept until something waits for them.
const inbox = [];
let stdinClosed = false;
const waiters = new Set();
function startReadingStdin() {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (raw) => {
    try {
      inbox.push(JSON.parse(raw));
    } catch {
      return;
    }
    for (const check of [...waiters]) check();
  });
  lines.on('close', () => {
    stdinClosed = true;
    for (const check of [...waiters]) check();
  });
}

/** Resolves with the first stdin line that matches, or null on EOF or timeout. */
function waitFor(match, ms = 10_000) {
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      waiters.delete(check);
      resolve(value);
    };
    const check = () => {
      const at = inbox.findIndex(match);
      if (at >= 0) done(inbox.splice(at, 1)[0]);
      else if (stdinClosed) done(null);
    };
    const timer = setTimeout(() => done(null), ms);
    waiters.add(check);
    check();
  });
}

const isAbort = (line) => line.type === 'abort';
// How long a pending review card keeps the fake "working" (default 3 s).
const reviewWaitMs = Number(process.env.FAKE_SASACODE_REVIEW_WAIT_MS ?? 3000);

function reply(chunks) {
  out({ type: 'message_start' });
  chunks.forEach((delta, index) =>
    out({
      type: 'message_update',
      event: { type: 'text_delta', index, delta },
    }),
  );
  out({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: chunks.join('') }],
    },
  });
}

function expand(value) {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

function readConfig() {
  const home = process.env.SASACODE_HOME;
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
}

async function mcp(run) {
  const server = readConfig().mcpServers.opendots;
  const headers = Object.fromEntries(
    Object.entries(server.headers ?? {}).map(([name, value]) => [
      name,
      expand(value),
    ]),
  );
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'fake-sasacode', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers },
    }),
  );
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

const textOf = (result) =>
  (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');

/** Every `[tool:<name> <json>]` in the prompt, in order. */
function toolDirectives(text) {
  const found = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf('[tool:', from);
    if (start < 0) return found;
    const nameEnd = text.slice(start + 6).search(/[\s\]]/) + start + 6;
    const name = text.slice(start + 6, nameEnd);
    let at = nameEnd;
    while (text[at] === ' ') at++;
    let json = '{}';
    if (text[at] === '{') {
      let depth = 0;
      let quoted = false;
      let end = at;
      for (; end < text.length; end++) {
        const char = text[end];
        if (quoted) {
          if (char === '\\') end++;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) break;
      }
      json = text.slice(at, end + 1);
      at = end + 1;
    }
    found.push({ name, json });
    from = at;
  }
}

async function toolRound({ name, json }, number) {
  const id = `call_${number}`;
  const cut = Math.ceil(json.length / 2);
  out({ type: 'message_start' });
  out({
    type: 'message_update',
    event: { type: 'toolcall_start', index: 0, id, name },
  });
  for (const delta of [json.slice(0, cut), json.slice(cut)])
    out({
      type: 'message_update',
      event: { type: 'toolcall_delta', index: 0, delta },
    });
  out({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'toolUse' },
  });
  let result;
  try {
    result = await mcp((client) =>
      client.callTool({ name, arguments: JSON.parse(json) }),
    );
  } catch (error) {
    result = {
      isError: true,
      content: [{ type: 'text', text: `MCP call failed: ${error.message}` }],
    };
  }
  const text = textOf(result);
  out({
    type: 'message_end',
    message: {
      role: 'tool',
      toolCallId: id,
      toolName: name,
      content: [{ type: 'text', text }],
      isError: !!result.isError,
    },
  });
  return text;
}

async function main() {
  startReadingStdin();
  if (prompt.includes('[crash]')) {
    process.stderr.write('segfault, probably\n');
    finish(3);
    return;
  }
  out({ type: 'session', id: resume ?? 'fake1234', path: null });
  if (prompt.includes('[fail]')) {
    out({ type: 'error', error: 'boom' });
    out({ type: 'agent_end', cause: 'error' });
    finish(1);
    return;
  }
  if (prompt.includes('[stubborn]')) {
    reply(['stubborn']);
    // Ignores abort and a closed stdin; only a signal ends it.
    setInterval(() => undefined, 1000);
    await new Promise(() => undefined);
  }
  if (prompt.includes('[slow]')) {
    reply(['working']);
    await waitFor(isAbort);
    out({ type: 'agent_end', cause: 'aborted' });
    finish(0);
    return;
  }
  if (prompt.includes('[approve]')) {
    out({
      type: 'approval_request',
      id: 'ap1',
      callId: 'call_ap',
      tool: 'bash',
      args: { command: 'rm -rf /tmp/scratch' },
      reason: 'deletes files',
    });
    const answer = await waitFor(
      (line) => line.type === 'approval' && line.id === 'ap1',
    );
    reply([
      answer
        ? `approval ${answer.decision}: ${answer.feedback ?? '(no feedback)'}`
        : 'approval never came',
    ]);
    out({ type: 'agent_end', cause: 'done' });
    finish(0);
    return;
  }
  if (prompt.includes('[tools]')) {
    const { tools } = await mcp((client) => client.listTools());
    reply([`tools: ${tools.map((tool) => tool.name).join(',')}`]);
    out({ type: 'agent_end', cause: 'done' });
    finish(0);
    return;
  }
  const tools = toolDirectives(prompt);
  if (tools.length) {
    const texts = [];
    for (const [index, tool] of tools.entries()) {
      texts.push(await toolRound(tool, index + 1));
      if (tool.name === 'review_space_page') {
        // The harness must stop a run whose review card is waiting on the owner.
        if (await waitFor(isAbort, reviewWaitMs)) {
          out({ type: 'agent_end', cause: 'aborted' });
          finish(0);
          return;
        }
      }
    }
    reply([`tools said: ${texts.join(' | ')}`]);
    out({ type: 'agent_end', cause: 'done' });
    finish(0);
    return;
  }
  const llm = /\[llm(?::([^\]\s]+))?\]/.exec(prompt);
  if (llm) {
    const config = readConfig().providers.opendots;
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env[config.apiKeyEnv]}`,
      },
      body: JSON.stringify({
        model: llm[1] ?? model.replace(/^opendots\//, ''),
        stream: false,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const body = await response.text();
    let content = body;
    try {
      const parsed = JSON.parse(body);
      content = parsed.choices?.[0]?.message?.content ?? parsed.error?.message;
    } catch {
      // Not JSON: echo the raw body.
    }
    reply([
      response.ok
        ? `llm replied: ${content}`
        : `llm error ${response.status}: ${content}`,
    ]);
    out({ type: 'agent_end', cause: 'done' });
    finish(0);
    return;
  }

  // Default: echo the prompt and the facts derived from argv and environment.
  reply([
    `fake: ${prompt}`,
    ` | model=${model}`,
    ` | resumed=${resume ?? 'no'}`,
    ` | maxTurns=${maxTurns}`,
    ` | system=${systemText.split('\n')[0]}`,
    ` | cwd=${process.cwd()}`,
    ` | home=${process.env.SASACODE_HOME}`,
    ` | token=${process.env.OPENDOTS_RUN_TOKEN ? 'set' : 'unset'}`,
    ` | apikey=${process.env.COMMAND_CODE_API_KEY ? 'visible' : 'hidden'}`,
    ...(prompt.includes('[system]') ? [`\n${systemText}`] : []),
  ]);
  out({ type: 'agent_end', cause: 'done' });
  finish(0);
}

if (resume?.startsWith('stale')) {
  process.stderr.write(`session not found: ${resume}\n`);
  finish(1);
} else if (
  flag('--output') !== 'jsonl' ||
  flag('--control') !== 'stdio' ||
  !model ||
  !systemFile
) {
  process.stderr.write(`unexpected arguments: ${argv.join(' ')}\n`);
  finish(2);
} else {
  main().catch((error) => {
    out({ type: 'error', error: String(error?.stack ?? error) });
    out({ type: 'agent_end', cause: 'error' });
    finish(1);
  });
}
