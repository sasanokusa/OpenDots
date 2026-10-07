import { readFileSync } from 'node:fs';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Connection,
  PendingApproval,
} from '../../src/shared/connection-types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../src/client/api', () => ({ api, authHeaders: () => ({}) }));
import { ConnectionActionCard } from '../../src/client/ConnectionActionCard';
import { ConnectionsSection } from '../../src/client/ConnectionsSection';
import { setLocale, t } from '../../src/client/selfhost/i18n/index';
import { entries as appEntries } from '../../src/client/selfhost/i18n/ja-app';
import { entries as chatEntries } from '../../src/client/selfhost/i18n/ja-chat';
import { entries as pageEntries } from '../../src/client/selfhost/i18n/ja-pages';
import {
  entries as serverEntries,
  patterns as serverPatterns,
} from '../../src/client/selfhost/i18n/ja-server';

beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setLocale('ja');
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocale('en');
});

const connection: Connection = {
  id: 'c1',
  dotId: 'd1',
  name: 'GitHub',
  url: 'https://example.com/mcp',
  hasToken: true,
  error: 'The connected service did not respond in time.',
  createdAt: 1,
  updatedAt: 1,
  tools: [
    {
      name: 'search',
      title: 'Search issues',
      description: 'Looks things up.',
      inputSchema: {},
      readOnly: true,
      enabled: true,
      requiresApproval: false,
    },
  ],
};
const empty: Connection = { ...connection, id: 'c2', error: null, tools: [] };

const render = async (element: Parameters<typeof create>[0]) => {
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(element);
  });
  return root;
};
const labelled = (root: ReturnType<typeof create>, label: string) =>
  root.root.findAll(
    (node) =>
      typeof node.type === 'string' && node.props['aria-label'] === label,
  )[0];

describe('ConnectionsSection', () => {
  it('shows the connection list and the add form in Japanese', async () => {
    api.mockResolvedValue([connection, empty]);
    const root = await render(<ConnectionsSection dotId="d1" />);
    const text = JSON.stringify(root.toJSON());
    for (const expected of [
      'サービス連携',
      'MCPサーバーのツールを、このDotに使わせることができます。',
      'トークン保存済み',
      '読み取り専用',
      '実行前に確認',
      'このサーバーが提供するツールはありません。',
      '連携サービスから時間内に応答がありませんでした。',
      'MCPサーバーを追加',
      '名前（例: GitHub）',
      'Bearerトークン（任意）',
      '接続',
    ])
      expect(text).toContain(expected);
    expect(labelled(root, 'GitHubのツールを更新')).toBeTruthy();
    expect(labelled(root, 'GitHubを削除')).toBeTruthy();
    expect(labelled(root, 'MCPサーバーのURL')).toBeTruthy();
    for (const english of [
      'Connections',
      'token saved',
      'read-only',
      'Ask first',
      'This server offers no tools.',
      'did not respond in time',
      'Add an MCP server',
      'Bearer token',
      'Refresh GitHub tools',
    ])
      expect(text).not.toContain(english);
    root.unmount();
  });

  it('asks before removing a connection in Japanese', async () => {
    api.mockResolvedValue([empty]);
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', { confirm });
    const root = await render(<ConnectionsSection dotId="d1" />);
    await act(async () => {
      await labelled(root, 'GitHubを削除').props.onClick();
    });
    expect(confirm).toHaveBeenCalledWith('このDotからGitHubを削除しますか？');
    expect(api).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('translates server errors and the fallback message', async () => {
    api.mockRejectedValue(new Error('Dot not found.'));
    const known = await render(<ConnectionsSection dotId="d1" />);
    expect(JSON.stringify(known.toJSON())).toContain('Dotが見つかりません。');
    known.unmount();
    api.mockRejectedValue('offline');
    const unknown = await render(<ConnectionsSection dotId="d1" />);
    expect(JSON.stringify(unknown.toJSON())).toContain(
      'サービス連携を読み込めませんでした。',
    );
    unknown.unmount();
  });
});

describe('ConnectionActionCard', () => {
  const approval: PendingApproval = {
    id: 'approval-1',
    connection: 'GitHub',
    title: 'Create issue',
    description: 'Creates an issue.',
    arguments: { title: 'Bug' },
    expiresAt: Date.now() + 60_000,
  };
  const props = {
    args: { approvalId: 'approval-1', summary: 'Open an issue about the bug.' },
    status: 'executing',
    respond: async () => {},
    threadId: 'thread',
    toolCallId: 'call',
  };

  it('asks for approval in Japanese once the server record is loaded', async () => {
    api.mockImplementation(async (path: string) =>
      path.includes('connection-approvals') ? approval : null,
    );
    const root = await render(<ConnectionActionCard {...props} />);
    const text = JSON.stringify(root.toJSON());
    for (const expected of [
      '確認が必要です',
      '承認して実行',
      '却下',
      '承認するまで何も実行されません。',
      'GitHub · Create issue',
    ])
      expect(text).toContain(expected);
    expect(labelled(root, '連携サービスの操作を承認')).toBeTruthy();
    for (const english of ['Needs your approval', 'Approve', 'Decline'])
      expect(text).not.toContain(english);
    root.unmount();
  });

  it('shows the finished action in Japanese', async () => {
    api.mockImplementation(async (path: string) =>
      path.includes('connection-approvals')
        ? approval
        : {
            approvalId: 'approval-1',
            status: 'done',
            result: {
              isError: true,
              text: 'The connected service did not respond in time.',
            },
          },
    );
    const root = await render(<ConnectionActionCard {...props} />);
    const text = JSON.stringify(root.toJSON());
    for (const expected of [
      '失敗',
      'サービスのエラー',
      '連携サービスから時間内に応答がありませんでした。',
      '会話を続ける',
    ])
      expect(text).toContain(expected);
    expect(text).not.toContain('Service error');
    root.unmount();
  });

  it('translates a request the server no longer has', async () => {
    api.mockImplementation(async (path: string) => {
      if (path.includes('connection-approvals'))
        throw new Error(
          'This approval request expired. Ask the Dot to try again.',
        );
      return null;
    });
    const root = await render(<ConnectionActionCard {...props} />);
    const text = JSON.stringify(root.toJSON());
    expect(text).toContain('実行できません');
    expect(text).toContain('この承認リクエストは有効期限が切れました。');
    root.unmount();
  });
});

describe('catalog coverage', () => {
  const files = ['ConnectionsSection.tsx', 'ConnectionActionCard.tsx'];
  const catalogs = [chatEntries, appEntries, pageEntries, serverEntries];
  const literal = /\bt\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  const keys = files.flatMap((file) =>
    [
      ...readFileSync(
        new URL(`../../src/client/${file}`, import.meta.url),
        'utf8',
      ).matchAll(literal),
    ].map((match) => match[1].slice(1, -1).replace(/\\(['"])/g, '$1')),
  );
  const placeholders = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  it('finds the wrapped strings', () => {
    expect(keys.length).toBeGreaterThan(30);
  });

  it('translates every wrapped string with the same placeholders', () => {
    for (const key of keys) {
      const entry = catalogs
        .map((entries) => entries[key])
        .find((value) => value !== undefined);
      expect(entry, key).toBeTruthy();
      expect(placeholders(entry!), key).toEqual(placeholders(key));
      expect(t(key, { name: 'X' }), key).not.toBe(
        key.replace(/\{name\}/g, 'X'),
      );
    }
  });

  it('translates the connection messages the server sends', () => {
    for (const message of [
      'Connection not found.',
      'Approval request not found.',
      'This action is already running.',
      'The connected service rejected the credentials. Check the bearer token.',
      'The service returned an unreadable result.',
    ])
      expect(serverEntries[message], message).toMatch(/[぀-ヿ一-鿿]/u);
    const pattern = serverPatterns.find(([regexp]) =>
      regexp.test('Could not reach the connected service: ECONNREFUSED'),
    );
    expect(pattern).toBeTruthy();
  });
});
