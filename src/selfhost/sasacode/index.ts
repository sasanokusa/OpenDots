import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { ApprovalBroker } from '../approvals/broker.js';
import type { CommandCodeClient } from '../llm/commandcode.js';
import type { TurnPlanner } from '../router/router.js';
import type { HarnessRunInput } from '../router/types.js';
import {
  PERMISSION_MODES,
  writeSasacodeConfig,
  type PermissionMode,
} from './config.js';
import { createSasacodeHarness } from './harness.js';
import { startInternalServer, type InternalServer } from './internal-server.js';
import { RunRegistry } from './runs.js';
import { SasacodeSessions } from './sessions.js';

type Env = Record<string, string | undefined>;

export function permissionMode(env: Env): PermissionMode {
  const value = env.SASACODE_PERMISSION?.trim() || 'agent';
  if (!(PERMISSION_MODES as readonly string[]).includes(value))
    throw new Error(
      `SASACODE_PERMISSION must be one of ${PERMISSION_MODES.join(', ')}.`,
    );
  return value as PermissionMode;
}

/** `SASACODE_SSH_HOSTS`: comma-separated names the Dot may `ssh` to. */
export function sshHosts(env: Env): string[] {
  const hosts = (env.SASACODE_SSH_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  const bad = hosts.find((host) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host));
  if (bad)
    throw new Error(
      `SASACODE_SSH_HOSTS has an invalid host name: ${JSON.stringify(bad)}.`,
    );
  return [...new Set(hosts)];
}

/** `SASACODE_PRIVATE_PATHS`: comma-separated absolute directories kept from the Dot. */
export function privatePaths(env: Env): string[] {
  const paths = (env.SASACODE_PRIVATE_PATHS ?? '')
    .split(',')
    .map((path) => path.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const bad = paths.find((path) => !path.startsWith('/') || /[*?]/.test(path));
  if (bad)
    throw new Error(
      `SASACODE_PRIVATE_PATHS needs absolute paths without wildcards: ${JSON.stringify(bad)}.`,
    );
  return [...new Set(paths)];
}

export function agentHarness(env: Env): 'builtin' | 'sasacode' {
  const value = env.AGENT_HARNESS?.trim() || 'builtin';
  if (value !== 'builtin' && value !== 'sasacode')
    throw new Error('AGENT_HARNESS must be builtin or sasacode.');
  return value;
}

export interface SasacodeOptions {
  db: DatabaseSync;
  client: CommandCodeClient;
  planTurn: TurnPlanner;
  binary: string;
  home: string;
  workRoot: string;
  sshHosts?: string[];
  privatePaths?: string[];
  appDir: string;
  port?: number;
  approvals?: ApprovalBroker;
  mode?: PermissionMode;
}

/**
 * The sasacode harness plus the loopback server it needs. `start()` must run
 * before the first turn; turns that arrive earlier wait for it.
 */
export function createSasacode(options: SasacodeOptions) {
  const runs = new RunRegistry();
  const sessions = new SasacodeSessions(options.db);
  let server: InternalServer | undefined;
  let markReady!: () => void;
  let markFailed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
  });
  // A failed start is reported by every later turn, not as an unhandled rejection.
  ready.catch(() => undefined);
  const harness = createSasacodeHarness({
    binary: options.binary,
    home: options.home,
    workRoot: options.workRoot,
    sshHosts: options.sshHosts,
    runs,
    sessions,
    planTurn: options.planTurn,
    approve: options.approvals
      ? (request, signal) => options.approvals!.request(request, signal)
      : undefined,
  });
  return {
    runs,
    sessions,
    async *runHarness(input: HarnessRunInput) {
      await ready;
      yield* harness(input);
    },
    async start() {
      try {
        server = await startInternalServer(
          { runs, client: options.client },
          options.port ?? 0,
        );
        writeSasacodeConfig({
          home: options.home,
          port: server.port,
          appDir: options.appDir,
          homeDir: homedir(),
          privatePaths: options.privatePaths,
          mode: options.mode,
        });
        markReady();
      } catch (error) {
        markFailed(error);
        throw error;
      }
    },
    async stop() {
      harness.stopAll();
      await server?.close();
    },
  };
}
