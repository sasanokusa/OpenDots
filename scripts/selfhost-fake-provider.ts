// Offline stand-in for CommandCode so the UI can be exercised without
// spending credits: `npm run selfhost:fake`, then point
// COMMAND_CODE_BASE_URL at the printed URL.
import { startFakeCommandCode } from '../tests/selfhost/fake-commandcode.js';

const port = Number(process.env.FAKE_PROVIDER_PORT ?? 4399);
const fake = await startFakeCommandCode({ port });

const lastUser = (body: { messages?: { role: string; content?: unknown }[] }) =>
  String(
    [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')
      ?.content ?? '',
  ).slice(-200);

fake.onChat((body) => {
  if (JSON.stringify(body.messages).includes('Write a title'))
    return {
      content: 'オフライン確認',
      usage: { prompt_tokens: 20, completion_tokens: 4 },
    };
  return {
    content: `（偽プロバイダ ${body.model}）受け取りました: ${lastUser(body)}`,
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  };
});

console.log(`Fake CommandCode listening at ${fake.baseURL}`);
const stop = () => void fake.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
