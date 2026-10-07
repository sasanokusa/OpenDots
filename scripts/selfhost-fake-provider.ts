// Offline stand-in for CommandCode so the UI can be exercised without
// spending credits: `npm run selfhost:fake`, then point
// COMMAND_CODE_BASE_URL at the printed URL.
//
// To exercise tools (with AGENT_HARNESS=sasacode too), put a marker in the
// message: `[tool:list_authorized_spaces {}]` calls that tool, and
// `[bash:df -h]` asks to run a shell command (which may need approval).
import { startFakeCommandCode } from '../tests/selfhost/fake-commandcode.js';

const port = Number(process.env.FAKE_PROVIDER_PORT ?? 4399);
const fake = await startFakeCommandCode({ port });

type Part = { type?: string; text?: string };
type ChatMessage = { role: string; content?: unknown };

const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as Part[]).map((part) => part.text ?? '').join('')
      : '';

const lastUser = (messages: ChatMessage[]) =>
  text([...messages].reverse().find((m) => m.role === 'user')?.content);

let calls = 0;
fake.onChat((body) => {
  const messages = (body.messages ?? []) as ChatMessage[];
  if (JSON.stringify(messages).includes('Write a title'))
    return {
      content: 'オフライン確認',
      usage: { prompt_tokens: 20, completion_tokens: 4 },
    };
  const last = messages.at(-1);
  if (last?.role === 'tool')
    return {
      content: `（偽プロバイダ）ツールの結果を受け取りました: ${text(last.content).slice(0, 300)}`,
      usage: { prompt_tokens: 150, completion_tokens: 30 },
    };
  const user = lastUser(messages);
  const tool = /\[tool:(\w+)\s*(\{.*?\})?\]/.exec(user);
  const bash = /\[bash:([^\]]+)\]/.exec(user);
  if (tool || bash)
    return {
      toolCalls: [
        {
          id: `call_fake_${++calls}`,
          name: tool ? tool[1]! : 'bash',
          arguments: tool
            ? (tool[2] ?? '{}')
            : JSON.stringify({ command: bash![1]!.trim() }),
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 20 },
    };
  return {
    content: `（偽プロバイダ ${body.model}）受け取りました: ${user.slice(-200)}`,
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  };
});

console.log(`Fake CommandCode listening at ${fake.baseURL}`);
const stop = () => void fake.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
