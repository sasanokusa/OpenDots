import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prices, roles } from '../config/models.js';

/** Provider name OpenDots registers in sasacode for its loopback relay. */
export const PROVIDER = 'opendots';
/** Environment variable carrying the per-run token into sasacode. */
export const TOKEN_ENV = 'OPENDOTS_RUN_TOKEN';

/** OpenDots tools sasacode may call without asking; OpenDots checks them itself. */
export const OPENDOTS_TOOLS = [
  'list_authorized_spaces',
  'list_space_pages',
  'read_space_page',
  'create_space_page',
  'edit_space_page',
  'review_space_page',
  'search_web',
  'read_public_page',
  'delegate_tasks',
  'handover_to_planner',
  'ask_advisor',
  'computer_*',
];

/**
 * Shell commands that only read state run without approval. A command chained
 * with `;`, `&&` or a pipe is allowed only when every part matches, and
 * substitutions or redirections are never allowed (sasacode's rule matcher).
 */
export const READ_ONLY_COMMANDS = [
  'echo',
  'echo *',
  'uptime',
  'uptime *',
  'uname *',
  'hostname',
  'whoami',
  'date',
  'date *',
  'df',
  'df *',
  'du -sh *',
  'free',
  'free *',
  'lsblk',
  'lsblk *',
  'cat /proc/loadavg',
  'cat /proc/meminfo',
  'cat /proc/cpuinfo',
  'nproc',
  'ps',
  'top -bn1*',
  'ss -tln*',
  'ip -br *',
  'sensors',
  'nvidia-smi',
  'nvidia-smi *',
  'systemctl status*',
  'systemctl --user status*',
  'systemctl is-active *',
  'systemctl --user is-active *',
  'systemctl list-units*',
  'systemctl --user list-units*',
  'systemctl list-timers*',
  'systemctl --user list-timers*',
  'systemctl --failed*',
  'systemctl --user --failed*',
  'journalctl -u *',
  'journalctl --user -u *',
  'docker ps*',
  'docker stats --no-stream*',
  'docker images*',
  'tailscale status*',
  'ls',
  'ls *',
];

export const PERMISSION_MODES = ['agent', 'edits', 'ask', 'auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface SasacodeConfigOptions {
  /**
   * sasacode's permission mode. `agent` (default): the model judges each call
   * that no rule decides and only risky ones reach the owner.
   */
  mode?: PermissionMode;
  /** SASACODE_HOME for OpenDots' sasacode runs. */
  home: string;
  /** Port of the loopback internal server. */
  port: number;
  /** Paths whose secrets must never be read or changed (the app, HOME). */
  appDir: string;
  homeDir: string;
}

const CONTEXT_WINDOW = 131_072;

export function sasacodeConfig(options: SasacodeConfigOptions) {
  const base = `http://127.0.0.1:${options.port}`;
  const models = [roles.chat, roles.planner, roles.worker];
  const secret = [
    `${options.appDir}/.env*`,
    `${options.appDir}/data/*.sqlite*`,
    `${options.homeDir}/.ssh/**`,
    `${options.homeDir}/.config/**`,
    `${options.home}/.env`,
  ];
  return {
    model: `${PROVIDER}/${roles.chat.model}`,
    // agent mode asks a fast, cheap model whether each unlisted call is safe.
    judgeModel: `${PROVIDER}/${roles.worker.model}`,
    providers: {
      [PROVIDER]: {
        api: 'openai-chat',
        baseUrl: `${base}/llm/v1`,
        apiKeyEnv: TOKEN_ENV,
      },
    },
    modelOverrides: Object.fromEntries(
      models.map((role) => {
        const price = prices[role.model];
        return [
          `${PROVIDER}/${role.model}`,
          {
            contextWindow: CONTEXT_WINDOW,
            maxOutput: role.maxOutputTokens ?? 8000,
            reasoning: true,
            ...(price && {
              price: {
                input: price.inputPerM,
                output: price.outputPerM,
                ...(price.cacheReadPerM !== undefined && {
                  cacheRead: price.cacheReadPerM,
                }),
              },
            }),
          },
        ];
      }),
    ),
    mcpServers: {
      opendots: {
        url: `${base}/mcp`,
        headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
        toolNames: 'plain',
        alwaysLoad: true,
        timeout: 600_000,
      },
    },
    permissions: {
      mode: options.mode ?? 'agent',
      allow: [
        ...OPENDOTS_TOOLS,
        ...READ_ONLY_COMMANDS.map((command) => `bash(${command})`),
      ],
      deny: [
        ...secret.flatMap((path) => [
          `read(${path})`,
          `write(${path})`,
          `edit(${path})`,
        ]),
        'bash(*.env*)',
        'bash(*.ssh*)',
        'bash(*/.config/*)',
        'bash(*.netrc*)',
        'bash(*credential*)',
        'bash(*TOKEN*)',
        'bash(*API_KEY*)',
        'bash(sudo *)',
      ],
    },
    plugins: { disabled: ['openai-codex', 'browsr', 'background-sessions'] },
    updateCheck: false,
  };
}

/** Writes `<home>/config.json`; sasacode reads it as its trusted global config. */
export function writeSasacodeConfig(options: SasacodeConfigOptions): string {
  mkdirSync(options.home, { recursive: true, mode: 0o700 });
  const path = join(options.home, 'config.json');
  writeFileSync(path, `${JSON.stringify(sasacodeConfig(options), null, 2)}\n`, {
    mode: 0o600,
  });
  return path;
}
