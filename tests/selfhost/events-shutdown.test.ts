import { expect, it } from 'vitest';
import { WorkspaceStore } from '../../src/server/workspace.js';
import { createSelfhostBackend } from '../../src/selfhost/index.js';
import { selfhostRoutes } from '../../src/selfhost/routes.js';

it('ends open event streams when the backend closes, so the server can stop', async () => {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const backend = createSelfhostBackend({
    databasePath: ':memory:',
    workspace,
  });
  const app = selfhostRoutes(backend, { heartbeatMs: 60_000 });
  const response = await app.request('/events');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('event: ready')) {
    const chunk = await reader.read();
    text += decoder.decode(chunk.value);
  }
  backend.events.emit({ type: 'usage_updated' });
  await backend.close();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  expect(text).toContain('event: usage_updated');
  expect(text).not.toContain('shutdown');
  workspace.close();
});
