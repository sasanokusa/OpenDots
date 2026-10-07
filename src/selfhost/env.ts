import type { PlatformConfig } from '../server/platform-config.js';
import type { WorkspaceStore } from '../server/workspace.js';
import { roles, turn } from './config/models.js';
import { createSelfhostBackend, type SelfhostBackend } from './index.js';
import { CommandCodeClient } from './llm/commandcode.js';
import { createTurnPlanner } from './router/router.js';
import {
  agentHarness,
  createSasacode,
  permissionMode,
  privatePaths,
  sshHosts,
} from './sasacode/index.js';
import { dirname, join, resolve } from 'node:path';
import { chat } from '@tanstack/ai';
import {
  discordConfigFromEnv,
  type DiscordClientLike,
} from './discord/bridge.js';

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

function discordSettings(env: Env, client?: DiscordClientLike) {
  const settings = discordConfigFromEnv(env);
  return (
    settings && {
      ...settings,
      routerCommands: modelRouterEnabled(env),
      client,
    }
  );
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
  deps: {
    databasePath: string;
    workspace: WorkspaceStore;
    /** Test seam for the Discord gateway client. */
    discordClient?: DiscordClientLike;
  },
): SelfhostBackend | undefined {
  if (conversationBackend(env, config) !== 'selfhost') return undefined;
  const commandCodeKey = env.COMMAND_CODE_API_KEY?.trim();
  if (commandCodeKey) {
    config.apiKey = commandCodeKey;
    config.baseUrl = env.COMMAND_CODE_BASE_URL?.trim() || COMMAND_CODE_BASE_URL;
  }
  const routerEnabled = modelRouterEnabled(env);
  const harness = agentHarness(env);
  if (routerEnabled) config.model = roles.chat.model;
  const monthStartDay = positiveInt(env, 'USAGE_MONTH_START_DAY', 1);
  if (monthStartDay > 31)
    throw new Error('USAGE_MONTH_START_DAY must be between 1 and 31.');
  const backend = createSelfhostBackend({
    databasePath: deps.databasePath,
    workspace: deps.workspace,
    usage: { monthStartDay },
    discord: discordSettings(env, deps.discordClient),
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
    const planTurn = createTurnPlanner({
      client,
      meter: backend.meter,
      db: backend.db,
      routerEnabled,
      singleModel,
      log: backend.decisions,
    });
    config.selfhost.planTurn = planTurn;
    if (harness === 'sasacode') {
      const dataDir =
        deps.databasePath === ':memory:'
          ? resolve('data')
          : dirname(resolve(deps.databasePath));
      const sasacode = createSasacode({
        db: backend.db,
        client,
        planTurn,
        binary: env.SASACODE_BIN?.trim() || 'sasacode',
        home: env.SASACODE_HOME?.trim() || join(dataDir, 'sasacode'),
        workRoot: env.SASACODE_WORKDIR?.trim() || join(dataDir, 'dots'),
        sshHosts: sshHosts(env),
        privatePaths: privatePaths(env),
        appDir: resolve('.'),
        approvals: backend.approvals,
        mode: permissionMode(env),
      });
      backend.use(sasacode);
      config.selfhost.runHarness = (input) => sasacode.runHarness(input);
    }
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
