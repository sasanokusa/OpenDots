import type { PlatformConfig } from '../server/platform-config.js';
import type { WorkspaceStore } from '../server/workspace.js';
import { roles, turn } from './config/models.js';
import { createSelfhostBackend, type SelfhostBackend } from './index.js';
import { CommandCodeClient } from './llm/commandcode.js';
import { createTurnPlanner } from './router/router.js';
import { chat } from '@tanstack/ai';

type Env = Record<string, string | undefined>;

export const COMMAND_CODE_BASE_URL = 'https://api.commandcode.ai/provider/v1';

export function conversationBackend(
  env: Env,
  config: Pick<PlatformConfig, 'intelligenceKey'>,
): 'selfhost' | 'intelligence' {
  const value = env.CONVERSATION_BACKEND?.trim();
  if (value === 'selfhost' || value === 'intelligence') return value;
  if (value)
    throw new Error('CONVERSATION_BACKEND must be selfhost or intelligence.');
  return config.intelligenceKey ? 'intelligence' : 'selfhost';
}

export function modelRouterEnabled(env: Env): boolean {
  const value = env.MODEL_ROUTER?.trim() ?? 'off';
  if (value !== 'on' && value !== 'off')
    throw new Error('MODEL_ROUTER must be on or off.');
  return value === 'on';
}

function positiveInt(env: Env, name: string, fallback: number) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

/**
 * Switches the upstream config to the self-hosted backend when selected.
 * Mutates `config` so every upstream consumer sees the CommandCode key and the
 * self-host hooks; returns undefined for the upstream Intelligence mode.
 */
export function enableSelfhost(
  env: Env,
  config: PlatformConfig,
  deps: { databasePath: string; workspace: WorkspaceStore },
): SelfhostBackend | undefined {
  if (conversationBackend(env, config) !== 'selfhost') return undefined;
  const commandCodeKey = env.COMMAND_CODE_API_KEY?.trim();
  if (commandCodeKey) {
    config.apiKey = commandCodeKey;
    config.baseUrl = env.COMMAND_CODE_BASE_URL?.trim() || COMMAND_CODE_BASE_URL;
  }
  const routerEnabled = modelRouterEnabled(env);
  if (routerEnabled) config.model = roles.chat.model;
  const monthStartDay = positiveInt(env, 'USAGE_MONTH_START_DAY', 1);
  if (monthStartDay > 31)
    throw new Error('USAGE_MONTH_START_DAY must be between 1 and 31.');
  const weekStartDay = env.USAGE_WEEK_START?.trim() || 'mon';
  if (weekStartDay !== 'mon' && weekStartDay !== 'sun')
    throw new Error('USAGE_WEEK_START must be mon or sun.');
  const backend = createSelfhostBackend({
    databasePath: deps.databasePath,
    workspace: deps.workspace,
    usage: { monthStartDay, weekStartDay },
  });
  config.selfhost = {
    turnTimeLimitMs: positiveInt(env, 'TURN_TIME_LIMIT_MS', turn.timeLimitMs),
  };
  if (config.apiKey && config.model) {
    const client = new CommandCodeClient({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      recorder: backend.meter,
    });
    const singleModel = config.model;
    config.selfhost.planTurn = createTurnPlanner({
      client,
      meter: backend.meter,
      db: backend.db,
      routerEnabled,
      singleModel,
    });
    backend.threads.setNamer((user, assistant) =>
      chat({
        adapter: client.chatAdapter({ role: 'chat', model: singleModel }),
        messages: [
          {
            role: 'user',
            content: `Owner: ${user}\n\nAssistant: ${assistant}`,
          },
        ],
        systemPrompts: [
          'Write a title for this conversation in its language: at most 20 Japanese characters or 6 English words. Reply with the title only, no quotes.',
        ],
        modelOptions: { max_completion_tokens: 200 },
        stream: false,
      }),
    );
  }
  return backend;
}
