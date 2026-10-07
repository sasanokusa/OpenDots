import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../src/client/api', () => ({ api, authHeaders: () => ({}) }));
import { CallView } from '../../src/client/CallView';
import { ChatTranscript } from '../../src/client/ChatTranscript';
import { ComputerPanel } from '../../src/client/ComputerPanel';
import { ComputerToolCard } from '../../src/client/ComputerToolCard';
import { PageReviewCard } from '../../src/client/PageReviewCard';
import { decidePageReview } from '../../src/client/page-review-decision';
import { setLocale, t, tMessage } from '../../src/client/selfhost/i18n/index';
import { entries as appEntries } from '../../src/client/selfhost/i18n/ja-app';
import { entries as chatEntries } from '../../src/client/selfhost/i18n/ja-chat';
import { entries as pageEntries } from '../../src/client/selfhost/i18n/ja-pages';
import { entries as serverEntries } from '../../src/client/selfhost/i18n/ja-server';
import { useVoice } from '../../src/client/useVoice';
import type { Dot } from '../../src/shared/types';
import type { ComputerStatus } from '../../src/shared/computer-types';

beforeEach(() => {
  api.mockReset();
  setLocale('ja');
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocale('en');
});

const dot: Dot = {
  id: 'scout',
  spaceId: 's1',
  spaceIds: ['s1'],
  name: 'Scout',
  instructions: 'Help.',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 1,
};

const card = (props: Partial<Parameters<typeof ComputerToolCard>[0]> = {}) =>
  renderToStaticMarkup(
    <ComputerToolCard
      name="computer_exec"
      toolCallId="exec"
      status="complete"
      dotId="scout"
      dotName="Scout"
      showScreen={false}
      running={false}
      {...props}
    />,
  );

describe('ComputerToolCard', () => {
  it('shows Japanese labels and state for a finished command', () => {
    const html = card({
      result: JSON.stringify({ exitCode: 0, stdout: 'hello', stderr: '' }),
    });
    expect(html).toContain('ターミナルコマンドを実行');
    expect(html).toContain('完了');
    expect(html).toContain('コンピューターのターミナル出力');
    expect(html).toContain('Scoutのコンピューター: ターミナルコマンドを実行');
    expect(html).toContain('hello');
    expect(html).not.toContain('Finished');
  });

  it('translates server errors and keeps raw tool output as is', () => {
    const html = card({
      result: JSON.stringify({
        status: 'error',
        message: 'Computer permission is disabled.',
        stderr: 'File not found',
      }),
    });
    expect(html).toContain('要確認');
    expect(html).toContain('コンピューターの権限が無効です。');
    expect(html).not.toContain('Computer permission is disabled.');
  });

  it('translates the interruption text the runtime adds', () => {
    const html = card({
      name: 'computer_navigate',
      result: JSON.stringify({
        status: 'stopped',
        reason: 'stop_requested',
        message: 'Run stopped by user',
      }),
    });
    expect(html).toContain('中断');
    expect(html).toContain('ユーザーが実行を停止しました。');
  });

  it('labels the live view and the expand button', () => {
    const html = card({
      name: 'computer_navigate',
      status: 'inProgress',
      showScreen: true,
      running: true,
      args: { url: 'https://example.com' },
      onExpand: () => {},
    });
    expect(html).toContain('Webサイトを開く');
    expect(html).toContain('実行中');
    expect(html).toContain('Scoutのコンピューター · 現在のブラウザー画面');
    expect(html).toContain('コンピューターに接続しています…');
    expect(html).toContain('Scoutのコンピューターを拡大');
    expect(html).toContain('https://example.com');
  });

  it('stays English when the locale is en', () => {
    setLocale('en');
    const html = card({ result: JSON.stringify({ exitCode: 0, stdout: '' }) });
    expect(html).toContain('Running terminal command');
    expect(html).toContain('Finished');
  });
});

describe('PageReviewCard', () => {
  const props = {
    args: { title: 'Brief', content: 'Evidence', spaceId: 'space' },
    status: 'executing',
    respond: async () => {},
    threadId: 'thread',
    toolCallId: 'call',
    onSaved: () => {},
  };

  it('shows the pending state in Japanese before the receipt is checked', () => {
    const html = renderToStaticMarkup(<PageReviewCard {...props} />);
    expect(html).toContain('保存済みのレビューを確認しています…');
    expect(html).toContain('確認中');
    expect(html).toContain(
      'この下書きがすでに保存されているか確認しています。',
    );
    expect(html).toContain('ページ下書きのレビュー');
    expect(html).not.toContain('Checking');
  });

  it('shows the decision buttons in Japanese once the receipt is checked', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    api.mockResolvedValue(null);
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<PageReviewCard {...props} />);
    });
    const text = JSON.stringify(root.toJSON());
    expect(text).toContain('レビューの準備ができました');
    expect(text).toContain('あなたが決めます');
    expect(text).toContain('承認して保存');
    expect(text).toContain('却下');
    expect(text).toContain('承認するまで何も保存されません。');
    expect(text).not.toContain('Approve');
    root.unmount();
  });

  it('shows the saved state with a link to the page', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const draft = props.args;
    api.mockResolvedValue({ id: 'p1', spaceId: 'space', reviewDraft: draft });
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<PageReviewCard {...props} />);
    });
    const text = JSON.stringify(root.toJSON());
    expect(text).toContain('スペースに保存しました');
    expect(text).toContain('承認済み');
    expect(text).toContain('ページを開く');
    expect(text).toContain('会話を続ける');
    root.unmount();
  });

  it('throws the changed-draft error in Japanese', async () => {
    const draft = { title: 'Brief', content: 'Evidence', spaceId: 'space' };
    api.mockResolvedValue({ id: 'p1', ...draft, reviewDraft: draft });
    await expect(
      decidePageReview('thread', 'call', { ...draft, title: 'Changed' }, true),
    ).rejects.toThrow('このレビューは別の下書きで保存されています。');
  });
});

describe('ChatTranscript', () => {
  const call = (extra: Record<string, unknown>) => ({
    id: 'call',
    threadId: 'thread',
    status: 'ended' as const,
    startedAt: 1000,
    endedAt: 6000,
    transcript: '',
    error: null,
    anchorMessageId: 'before',
    ...extra,
  });
  const render = (calls: ReturnType<typeof call>[]) =>
    renderToStaticMarkup(
      <ChatTranscript
        messages={[{ id: 'before', role: 'user', content: '調べてください' }]}
        calls={calls}
      />,
    );

  it('labels a scheduled task message in Japanese', () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        messages={[
          { id: 'opendots:scheduled_task:one', role: 'user', content: '日報' },
        ]}
        calls={[]}
      />,
    );
    expect(html).toContain('>定期実行<');
    expect(html).not.toContain('>Scheduled<');
  });

  it('shows call receipts in Japanese and leaves messages alone', () => {
    const html = render([call({})]);
    expect(html).toContain('5秒 · 通話を終了しました');
    expect(html).toContain('調べてください');
  });

  it('translates failed and running receipts and their server errors', () => {
    const failed = render([
      call({
        status: 'failed',
        error: 'Call stopped because the workspace was paused.',
      }),
    ]);
    expect(failed).toContain('通話に失敗しました');
    expect(failed).toContain('ワークスペースが一時停止されたため');
    const running = render([call({ status: 'active', endedAt: null })]);
    expect(running).toContain('通話中');
  });
});

describe('CallView', () => {
  const voice = (extra: Record<string, unknown> = {}) =>
    ({
      status: 'active',
      phase: 'listening',
      muted: false,
      speakerMuted: false,
      startedAt: Date.now(),
      caption: '',
      userCaption: '',
      error: '',
      toggleMute: () => {},
      toggleSpeaker: () => {},
      end: async () => {},
      ...extra,
    }) as unknown as Parameters<typeof CallView>[0]['voice'];

  it('labels the call controls in Japanese', () => {
    const html = renderToStaticMarkup(<CallView dot={dot} voice={voice()} />);
    for (const text of [
      'Scoutとの音声通話',
      '聞いています',
      'スピーカー',
      'ミュート',
      '音声通話を終了',
      '通話時間',
      '自然に話しかけてください。Dotがそばにいます。',
      'テキストと音声は同じ会話を共有します',
    ])
      expect(html).toContain(text);
  });

  it('follows the call phase', () => {
    const speaking = renderToStaticMarkup(
      <CallView dot={dot} voice={voice({ phase: 'speaking' })} />,
    );
    expect(speaking).toContain('Scoutが話しています');
    const muted = renderToStaticMarkup(
      <CallView dot={dot} voice={voice({ muted: true })} />,
    );
    expect(muted).toContain('マイクをミュート中');
    expect(muted).toContain('ミュート解除');
  });
});

describe('ComputerPanel', () => {
  const status: ComputerStatus = {
    configured: true,
    state: 'running',
    permissions: { enabled: true, browser: true, files: true, shell: true },
    audit: [
      {
        id: 'a1',
        action: 'files_write',
        actor: 'agent',
        outcome: 'succeeded',
        createdAt: 1000,
      },
    ],
    control: {
      holder: 'bot',
      requested: false,
      transitioning: false,
      resumeSnapshotRequired: false,
    },
  };

  it('renders the panel chrome and audit log in Japanese', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('document', { hidden: false });
    api.mockImplementation(async (_path: string, method?: string) => {
      if (method === 'POST')
        throw new Error('Computer permission is disabled.');
      return status;
    });
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<ComputerPanel dot={dot} />);
    });
    const text = JSON.stringify(root.toJSON());
    for (const label of [
      'Scoutのコンピューター',
      '実行中',
      'ブラウザー',
      'ファイル',
      'ターミナル',
      '履歴',
      'ファイル書き込み',
      'Dot',
      '成功',
      'コンピューターを起動',
      'コンピューターを停止',
      '操作を引き継ぐ',
      'Dotが操作中',
      'コンピューターの権限が無効です。',
    ])
      expect(text).toContain(label);
    expect(text).not.toContain('Recent activity');
    root.unmount();
  });
});

describe('useVoice', () => {
  it('reports a denied microphone in Japanese', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => {
          throw new Error('Permission denied');
        },
      },
    });
    let voice!: ReturnType<typeof useVoice>;
    const Hook = () => {
      voice = useVoice('thread', () => {});
      return null;
    };
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(createElement(Hook));
    });
    await act(async () => {
      await voice.start();
    });
    expect(voice.error).toBe('マイクの使用が許可されていません。');
    expect(voice.status).toBe('idle');
    root.unmount();
  });
});

describe('tMessage on server messages', () => {
  it.each([
    [
      'This turn reached the 90 second time limit and was stopped. Try a smaller request.',
      'このターンは90秒の制限時間に達したため停止しました。依頼を小さくして、もう一度お試しください。',
    ],
    [
      'Computer service returned HTTP 502.',
      'コンピューターサービスがHTTP 502を返しました。',
    ],
    [
      'Voice provider returned HTTP 429. Check voice configuration and quota.',
      '音声プロバイダーがHTTP 429を返しました。音声の設定と利用枠を確認してください。',
    ],
    [
      'The local call stopped, but provider hangup failed (TypeError).',
      '通話は停止しましたが、プロバイダー側の切断に失敗しました（TypeError）。',
    ],
    [
      'Setup required: COMMAND_CODE_API_KEY, OPENAI_MODEL.',
      'セットアップが必要です: COMMAND_CODE_API_KEY, OPENAI_MODEL。',
    ],
    [
      'Space access has been revoked.',
      'スペースへのアクセスが取り消されました。',
    ],
    ['Request failed (503).', 'リクエストに失敗しました（503）。'],
  ])('translates %s', (message, expected) => {
    expect(tMessage(message)).toBe(expected);
  });

  it('returns unknown messages and English-locale messages unchanged', () => {
    expect(tMessage('Some provider said no')).toBe('Some provider said no');
    setLocale('en');
    expect(tMessage('Computer permission is disabled.')).toBe(
      'Computer permission is disabled.',
    );
  });
});

describe('catalog coverage', () => {
  const owned = [
    'Chat.tsx',
    'ChatTranscript.tsx',
    'CallView.tsx',
    'useVoice.ts',
    'PageReviewCard.tsx',
    'page-review-decision.ts',
    'ComputerPanel.tsx',
    'ComputerToolCard.tsx',
    'chat-composer.ts',
    'selfhost/ApprovalCard.tsx',
  ];
  // Keys deliberately left English. Empty: every wrapped string is translated.
  const intentionallyEnglish = new Set<string>();
  const catalogs = [chatEntries, appEntries, pageEntries, serverEntries];
  const literal = /\bt\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  const keys = owned.flatMap((file) => {
    const source = readFileSync(
      new URL(`../../src/client/${file}`, import.meta.url),
      'utf8',
    );
    return [...source.matchAll(literal)].map((match) =>
      match[1].slice(1, -1).replace(/\\(['"])/g, '$1'),
    );
  });
  const translation = (key: string) =>
    catalogs
      .map((entries) => entries[key])
      .find((value) => value !== undefined);
  const placeholders = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  it('finds the wrapped strings', () => {
    expect(keys.length).toBeGreaterThan(150);
  });

  it('has a Japanese entry for every wrapped string', () => {
    const missing = keys.filter(
      (key) => !intentionallyEnglish.has(key) && !translation(key),
    );
    expect(missing).toEqual([]);
  });

  it('keeps the placeholders of every translated string', () => {
    for (const key of keys) {
      const ja = translation(key);
      if (ja) expect(placeholders(ja), key).toEqual(placeholders(key));
    }
  });

  it('translates every wrapped string differently from its English source', () => {
    for (const key of keys) {
      if (intentionallyEnglish.has(key)) continue;
      expect(t(key, { name: 'X', dotName: 'X' }), key).not.toBe(
        key.replace(/\{(name|dotName)\}/g, 'X'),
      );
    }
  });
});
