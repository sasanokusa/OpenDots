import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  Dot,
  Task,
  State,
  WorkspaceState,
} from '../../src/shared/types';
import type { PolicyFlags } from '../../src/selfhost/usage/policy';
import type { UsageSummary } from '../../src/selfhost/usage/meter';

vi.mock('@copilotkit/react-core/v2', () => ({
  useThreads: () => ({
    threads: [],
    error: undefined,
    hasMoreThreads: false,
    isFetchingMoreThreads: false,
    fetchMoreThreads: vi.fn(),
  }),
}));
vi.mock('../../src/client/selfhost/api', () => ({
  listSelfhostThreads: vi.fn(),
  patchSelfhostThread: vi.fn(),
  fetchSelfhostUsage: vi.fn(),
  fetchSelfhostObserved: vi.fn(),
  putSelfhostObserved: vi.fn(),
}));
vi.mock('../../src/client/selfhost/events', () => ({
  useSelfhostEvents: () => {},
}));

import { setLocale, t, tMessage } from '../../src/client/selfhost/i18n/index';
import { entries as appEntries } from '../../src/client/selfhost/i18n/ja-app';
import { entries as chatEntries } from '../../src/client/selfhost/i18n/ja-chat';
import { entries as pageEntries } from '../../src/client/selfhost/i18n/ja-pages';
import {
  entries as serverEntries,
  patterns as serverPatterns,
} from '../../src/client/selfhost/i18n/ja-server';
import { ThreadList } from '../../src/client/ThreadList';
import { WorkspaceDialog } from '../../src/client/WorkspaceDialog';
import { TaskActions } from '../../src/client/TaskActions';
import { TaskRow, statusLabel } from '../../src/client/TaskPresentation';
import { Mascot } from '../../src/client/Mascot';
import { ResultPane } from '../../src/client/ResultPane';
import { UsagePanelView } from '../../src/client/selfhost/UsagePanel';

afterEach(() => setLocale('en'));

const dot: Dot = {
  id: 'd1',
  spaceId: 's1',
  spaceIds: ['s1'],
  name: 'Scout',
  instructions: 'Help.',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 1,
};
const task: Task = {
  id: 'one',
  prompt: 'A recurring task',
  status: 'completed',
  intervalSeconds: 3600,
  nextRunAt: Date.now() + 3600000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  error: null,
  lease: null,
  leaseUntil: null,
};
const settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
};
const workspace = (
  overrides: Partial<WorkspaceState['setup']> = {},
): WorkspaceState =>
  ({
    spaces: [{ id: 's1', name: 'Home' }],
    dots: [dot],
    conversations: [],
    calls: [],
    setup: {
      backend: 'selfhost',
      intelligence: true,
      model: true,
      browser: false,
      voice: false,
      slack: 'not_configured',
      missing: [],
      ...overrides,
    },
  }) as unknown as WorkspaceState;
const dialog = (
  type: 'settings' | 'memory' | 'schedule',
  setup: Partial<WorkspaceState['setup']> = {},
) =>
  renderToStaticMarkup(
    <WorkspaceDialog
      dialog={
        type === 'schedule'
          ? { type, threadId: 't1' }
          : ({ type } as { type: 'settings' })
      }
      state={{ settings } as State}
      workspace={workspace(setup)}
      onClose={() => {}}
      mutate={async () => true}
    />,
  );

describe('app shell in Japanese', () => {
  it('renders the settings dialog without English UI text', () => {
    setLocale('ja');
    const html = dialog('settings', { missing: ['COMMAND_CODE_API_KEY'] });
    for (const text of [
      'ワークスペースの設定',
      'ダイアログを閉じる',
      '公開ページの調査',
      '保存した記憶を使う',
      'サービスのセットアップ',
      'サーバーの環境にCOMMAND_CODE_API_KEYを追加して、再起動します。',
      'Slack: 未設定。音声通話: VOICE_API_KEYとVOICE_MODELが必要。',
      'テンプレートのセットアップガイド',
      '>保存<',
    ])
      expect(html).toContain(text);
    for (const text of [
      'Your workspace, your rules',
      'Public-page research',
      'Service setup',
      'Close dialog',
      '>Save<',
    ])
      expect(html).not.toContain(text);
  });

  it('renders the schedule and memory dialogs in Japanese', () => {
    setLocale('ja');
    const schedule = dialog('schedule');
    expect(schedule).toContain('定期タスクを設定');
    expect(schedule).toContain('1時間ごと');
    expect(schedule).toContain('毎週');
    expect(schedule).not.toContain('Every hour');
    const memory = dialog('memory');
    expect(memory).toContain('好みや前提');
    expect(memory).not.toContain('Preference or context');
  });

  it('keeps the English dialog text in the test locale', () => {
    expect(dialog('settings')).toContain('Service setup');
    expect(dialog('settings')).toContain('Slack: not configured.');
  });

  it('renders the thread list in Japanese and translates the default title', () => {
    setLocale('ja');
    const local: Conversation[] = [
      {
        id: 't1',
        dotId: 'd1',
        ownerId: 'o',
        title: 'A new thought',
        createdAt: 1,
      },
      { id: 't2', dotId: 'd1', ownerId: 'o', title: 'Save', createdAt: 2 },
    ];
    const html = renderToStaticMarkup(
      <ThreadList
        dots={[dot]}
        dotId="d1"
        local={local}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
    expect(html).toContain('最近の会話');
    expect(html).toContain('新しい会話');
    // A user's own title is never translated, even if it matches a UI string.
    expect(html).toContain('>Save<');
    expect(html).not.toContain('RECENT CHATS');
    const empty = renderToStaticMarkup(
      <ThreadList
        dots={[dot]}
        dotId="d1"
        local={[]}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
    expect(empty).toContain('最初の会話がここに表示されます。');
    expect(empty).not.toContain('Your first conversation');
  });

  it('renders task rows and actions in Japanese', () => {
    setLocale('ja');
    const actions = renderToStaticMarkup(
      <TaskActions
        task={task}
        settings={settings}
        busy={false}
        onAction={() => {}}
        onSchedule={() => {}}
      />,
    );
    expect(actions).toContain('定期実行を一時停止');
    expect(actions).toContain('定期実行を編集');
    expect(actions).toContain('キャンセル');
    expect(actions).not.toContain('Pause schedule');
    const row = renderToStaticMarkup(
      <TaskRow task={task} onClick={() => {}} />,
    );
    expect(row).toContain('1時間ごとに繰り返し');
    expect(row).toContain('たった今');
    expect(row).toContain('定期実行');
    expect(statusLabel({ ...task, nextRunAt: null, status: 'failed' })).toBe(
      '失敗',
    );
    expect(statusLabel({ ...task, nextRunAt: null, status: 'queued' })).toBe(
      '実行待ち',
    );
  });

  it('keeps the English task labels in the test locale', () => {
    expect(statusLabel({ ...task, nextRunAt: null, status: 'failed' })).toBe(
      'Failed',
    );
    const row = renderToStaticMarkup(
      <TaskRow task={task} onClick={() => {}} />,
    );
    expect(row).toContain('Repeats every 1 hr');
  });

  it('describes the mascot and the result pane in Japanese', () => {
    setLocale('ja');
    expect(
      renderToStaticMarkup(<Mascot name="Scout" state="working" />),
    ).toContain('Scoutは作業中です');
    const pane = renderToStaticMarkup(
      <ResultPane
        dots={[dot]}
        defaultDotId="d1"
        dotState="idle"
        onClose={() => {}}
      />,
    );
    expect(pane).toContain('Scoutのコンピューター');
    expect(pane).toContain('結果パネルを閉じる');
    expect(pane).not.toContain('’s computer');
  });

  describe('usage panel', () => {
    const NOW = Date.UTC(2026, 9, 6, 15, 21);
    const window = (usedUSD: number, limitUSD: number) => ({
      usedUSD,
      limitUSD,
      ratio: usedUSD / limitUSD,
      since: NOW - 3_600_000,
      resetsAt: NOW + 3_600_000,
      externalUSD: 0,
    });
    const role = (weekUSD: number, monthUSD: number) => ({
      weekUSD,
      monthUSD,
      fiveHourUSD: 0,
    });
    const summary = {
      at: NOW,
      windows: {
        fiveHour: window(3.5, 14),
        week: window(29.75, 35),
        month: window(70, 70),
      },
      byRole: { router: role(0, 0), chat: role(1, 2) },
      pace: {
        dayOfMonth: 12,
        idealToDateUSD: 28,
        monthUSD: 31.5,
        diffUSD: 3.5,
      },
    } as unknown as UsageSummary;
    const flags: PolicyFlags = {
      pauseEscalation: true,
      plannerUrgentOnly: false,
      stopBacklog: false,
      plannerOverWeekly: false,
      plannerReserved: false,
      advisorManualOnly: false,
      chatExhausted: false,
      coolingDown: { worker: NOW + 60_000 },
      behindPace: true,
      backlogWindowOpen: false,
    };
    const view = (props: { data?: boolean; collapsed?: boolean } = {}) =>
      renderToStaticMarkup(
        <UsagePanelView
          data={props.data === false ? undefined : { summary, policy: flags }}
          collapsed={props.collapsed ?? false}
          onToggle={() => {}}
          now={NOW}
        />,
      );

    it('shows labels, pace and policy chips in Japanese', () => {
      setLocale('ja');
      const html = view();
      for (const text of [
        'モデルの使用量',
        '使用量',
        '5時間 25% · 週 85% · 月 100%',
        '理想のペースより$3.50多い',
        '12日目: $31.50使用、理想は$28.00',
        'エスカレーション停止',
        'worker: クールダウン中',
        'ペース遅れ',
        '有効なポリシー',
        // Existing Japanese is kept as it was.
        'CommandCodeの表示と合わせる',
        'あと1時間でリセット',
      ])
        expect(html).toContain(text);
      for (const text of [
        'Model usage',
        'ahead of ideal pace',
        'Escalation paused',
        'cooling down',
        'Active policies',
      ])
        expect(html).not.toContain(text);
    });

    it('shows loading text in Japanese', () => {
      setLocale('ja');
      expect(view({ data: false })).toContain('使用量を読み込み中…');
      expect(view({ data: false, collapsed: true })).toContain('読み込み中…');
    });

    it('stays English in the test locale', () => {
      const html = view();
      expect(html).toContain('5h 25% · Week 85% · Month 100%');
      expect(html).toContain('$3.50 ahead of ideal pace');
      expect(html).toContain('Escalation paused');
    });
  });
});

describe('tMessage with real server messages', () => {
  it('translates exact API errors', () => {
    setLocale('ja');
    expect(tMessage('Memory not found.')).toBe('記憶が見つかりません。');
    expect(tMessage('Research is disabled in Settings.')).toBe(
      '設定で調査が無効になっています。',
    );
    expect(tMessage('Backlog item not found.')).toBe(
      'バックログの項目が見つかりません。',
    );
    expect(
      tMessage('Enter your owner access token to unlock OpenDots.'),
    ).toContain('アクセストークン');
  });

  it('translates messages with variable parts through patterns', () => {
    setLocale('ja');
    expect(
      tMessage('Setup required: COMMAND_CODE_API_KEY, OPENAI_MODEL.'),
    ).toBe('セットアップが必要です: COMMAND_CODE_API_KEY, OPENAI_MODEL。');
    expect(
      tMessage(
        'Setup required: COMMAND_CODE_API_KEY. Conversations require CopilotKit Intelligence.',
      ),
    ).toBe(
      'セットアップが必要です: COMMAND_CODE_API_KEY。会話にはCopilotKit Intelligenceが必要です。',
    );
    expect(tMessage('Request failed (502).')).toBe(
      'リクエストに失敗しました（502）。',
    );
    expect(tMessage('Research exceeded the 120 second time limit.')).toBe(
      '調査が制限時間（120秒）を超えました。',
    );
    expect(
      tMessage('fiveHour: an open window needs resetsIn or resetsAt.'),
    ).toBe('5時間枠: 開いている枠にはresetsInかresetsAtが必要です。');
  });

  it('translates browser network failures and leaves unknown text alone', () => {
    setLocale('ja');
    for (const text of [
      'Failed to fetch',
      'Load failed',
      'NetworkError when attempting to fetch resource.',
    ])
      expect(tMessage(text)).toMatch(/^サーバーに接続できません/);
    expect(tMessage('Some provider said no')).toBe('Some provider said no');
  });

  it('returns the original message in the test locale', () => {
    expect(tMessage('Memory not found.')).toBe('Memory not found.');
    expect(tMessage('Setup required: A.')).toBe('Setup required: A.');
  });

  it('covers the literal error strings in the server routes', () => {
    setLocale('ja');
    const files = [
      'src/server/app.ts',
      'src/server/workspace-routes.ts',
      'src/selfhost/routes.ts',
      'src/selfhost/backlog/routes.ts',
      'src/selfhost/backlog/runner.ts',
    ];
    const messages = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /(?:error:|BacklogRefusedError\()\s*'((?:[^'\\]|\\.)*)'/g,
      ))
        messages.add(match[1].replace(/\\'/g, "'"));
    }
    expect(messages.size).toBeGreaterThan(30);
    const untranslated = [...messages].filter(
      (message) => tMessage(message) === message,
    );
    expect(untranslated).toEqual([]);
  });
});

describe('catalog coverage', () => {
  const owned = [
    'src/client/App.tsx',
    'src/client/WorkspaceDialog.tsx',
    'src/client/ThreadList.tsx',
    'src/client/TaskActions.tsx',
    'src/client/TaskPresentation.tsx',
    'src/client/ResultPane.tsx',
    'src/client/Mascot.tsx',
    'src/client/api.ts',
    'src/client/poll-notice.ts',
    'src/client/selfhost/UsagePanel.tsx',
    'src/client/selfhost/ThreadActions.tsx',
    'src/client/selfhost/events.ts',
  ];
  // Strings that are deliberately left in English; none at the moment.
  const keepEnglish = new Set<string>();
  // Translations that are the product term itself, written in Latin letters.
  const latinOk = new Set(['DOTS', 'Dots']);
  const literal = /\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  const keys = new Set<string>();
  for (const file of owned)
    for (const match of readFileSync(file, 'utf8').matchAll(literal))
      keys.add(match[2].replace(/\\(['"])/g, '$1'));
  const catalogs = [appEntries, chatEntries, pageEntries, serverEntries];

  it('finds the t() keys of the owned files', () => {
    expect(keys.size).toBeGreaterThan(150);
  });

  it('has a Japanese entry for every t() key', () => {
    const missing = [...keys].filter(
      (key) =>
        !keepEnglish.has(key) &&
        !catalogs.some((entries) => Object.hasOwn(entries, key)),
    );
    expect(missing).toEqual([]);
  });

  it('translates every key to Japanese with the same placeholders', () => {
    setLocale('ja');
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of keys) {
      if (keepEnglish.has(key)) continue;
      const translated = t(key);
      if (!latinOk.has(key)) expect(translated, key).toMatch(/[぀-ヿ一-鿿]/u);
      expect(placeholders(translated), key).toEqual(placeholders(key));
    }
  });

  it('translates every dynamic status label the UI can show', () => {
    setLocale('ja');
    for (const key of [
      'idle',
      'working',
      'paused',
      'complete',
      'needs-input',
      'online',
      'not configured',
      'setup required',
      'activation failed',
    ])
      expect(t(key), key).not.toBe(key);
  });

  it('has well-formed server catalog entries', () => {
    for (const [key, value] of Object.entries(serverEntries))
      expect(value, key).toMatch(/[぀-ヿ一-鿿]/u);
    for (const [pattern, replacement] of serverPatterns) {
      expect(pattern.source.startsWith('^'), pattern.source).toBe(true);
      expect(pattern.source.endsWith('$'), pattern.source).toBe(true);
      expect(replacement).toMatch(/[぀-ヿ一-鿿]/u);
    }
  });
});
