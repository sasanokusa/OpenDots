import type { PageIntelligence } from '../../server/page-service.js';
import type { SelfhostAgentRunner } from '../runner/sqlite-runner.js';
import type { ThreadService } from './service.js';

/** The two thread calls PageService makes, served from local storage. */
export function pageThreads(
  threads: ThreadService,
  runner: SelfhostAgentRunner,
): PageIntelligence {
  return {
    async getOrCreateThread({ threadId, name }) {
      threads.ensure(threadId, name);
      return { threadId };
    },
    async getThreadMessages({ threadId }) {
      return {
        messages: runner.getThreadMessages(threadId).map((message) => ({
          role: message.role,
          content: (message as { content?: unknown }).content,
        })),
      };
    },
  };
}
