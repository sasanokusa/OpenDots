import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '../../src/server/pages';
import type { Space } from '../../src/shared/types';

vi.mock('../../src/client/api', () => ({ api: vi.fn() }));
import {
  setLocale,
  t,
  tMessage,
} from '../../src/client/selfhost/i18n/index.js';
import { entries as appEntries } from '../../src/client/selfhost/i18n/ja-app.js';
import { entries as chatEntries } from '../../src/client/selfhost/i18n/ja-chat.js';
import { entries as pageEntries } from '../../src/client/selfhost/i18n/ja-pages.js';
import { entries as serverEntries } from '../../src/client/selfhost/i18n/ja-server.js';
import {
  PageAutosave,
  saveStatusLabel,
} from '../../src/client/editor/autosave';
import { DocumentMenu } from '../../src/client/editor/DocumentMenu';
import { blocks, searchBlocks } from '../../src/client/editor/slash-commands';
import { inspectMarkdown } from '../../src/client/editor/markdown';
import { PageOutline } from '../../src/client/PageOutline';
import { pageExcerpt, SpaceLibrary } from '../../src/client/SpaceLibrary';
import { SpaceNav } from '../../src/client/SpaceNav';

afterEach(() => setLocale('en'));

const page = (id: string, title: string, extra: Partial<Page> = {}): Page => ({
  id,
  spaceId: 's1',
  parentId: null,
  title,
  content: '',
  revision: 1,
  createdAt: 1,
  updatedAt: Date.UTC(2026, 0, 15, 12),
  sourceThreadId: null,
  ...extra,
});
const space = { id: 's1', name: 'Research', description: 'Notes' } as Space;

describe('slash commands', () => {
  it('shows Japanese labels and keeps the English identifiers', () => {
    setLocale('ja');
    expect(blocks.map((block) => t(block.title))).toEqual([
      'テキスト',
      '見出し1',
      '見出し2',
      '見出し3',
      '箇条書き',
      '番号付きリスト',
      'チェックリスト',
      '引用',
      'コード',
      '区切り線',
      '表',
    ]);
    expect(blocks[1].title).toBe('Heading 1');
    expect(t('A code block')).toBe('コードブロック');
    expect(t('INSERT BLOCK')).toBe('ブロックを挿入');
  });

  it('finds blocks by English or Japanese terms', () => {
    setLocale('ja');
    const names = (query: string) =>
      searchBlocks(query).map((block) => block.title);
    expect(names('heading')).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
    expect(names('見出し')).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
    expect(names('みだし')).toHaveLength(3);
    expect(names('チェック')).toEqual(['Checklist']);
    expect(names('表')).toContain('Table');
    expect(names('zzz')).toEqual([]);
  });

  it('keeps English labels in English', () => {
    expect(blocks.map((block) => t(block.title))).toContain('Bullet list');
    expect(searchBlocks('table').map((block) => block.title)).toEqual([
      'Table',
    ]);
  });
});

describe('autosave status', () => {
  const statuses = ['saving', 'saved', 'dirty', 'conflict', 'error'] as const;
  it('labels every status in Japanese', () => {
    setLocale('ja');
    expect(statuses.map(saveStatusLabel)).toEqual([
      '保存中…',
      'すべての変更を保存済み',
      '未保存の変更',
      '変更のレビューが必要です',
      '保存できませんでした',
    ]);
  });

  it('labels every status in English', () => {
    expect(statuses.map(saveStatusLabel)).toEqual([
      'Saving…',
      'All changes saved',
      'Unsaved changes',
      'Changes need review',
      'Could not save',
    ]);
  });

  it('translates server errors and conflicts in the draft banner', async () => {
    setLocale('ja');
    const failing = new PageAutosave(async () => {
      throw new Error('Page not found in this Space.');
    });
    failing.receive(page('a', 'Title'));
    failing.edit({ content: 'Changed' });
    await failing.flush();
    expect(failing.getSnapshot().status).toBe('error');
    expect(failing.getSnapshot().error).toBe(
      'このスペースにページが見つかりません。',
    );
    failing.dispose();

    const conflicting = new PageAutosave(async () => {
      throw Object.assign(new Error('This page changed.'), { status: 409 });
    });
    conflicting.receive(page('a', 'Title'));
    conflicting.edit({ content: 'Changed' });
    await conflicting.flush();
    expect(conflicting.getSnapshot().status).toBe('conflict');
    expect(conflicting.getSnapshot().error).toContain(
      '下書きは保持されています',
    );
    conflicting.dispose();
  });

  it('translates the Markdown source-mode reasons', () => {
    setLocale('ja');
    expect(inspectMarkdown('![x](https://example.com/a.png)').reason).toContain(
      'Markdownソースモード',
    );
    expect(inspectMarkdown('[^1]: note').reason).toContain('拡張Markdown');
  });
});

describe('rendered components', () => {
  const render = (node: React.ReactElement) => renderToStaticMarkup(node);

  it('renders the outline in Japanese and leaves page titles alone', () => {
    setLocale('ja');
    const html = render(
      <PageOutline
        pages={[page('a', 'Roadmap'), page('b', 'Child', { parentId: 'a' })]}
        selected="a"
        onPage={() => {}}
        onNew={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('aria-label="このスペースのページ"');
    expect(html).toContain('<strong>ページ</strong>');
    expect(html).toContain('aria-label="目次に新しいページを追加"');
    expect(html).toContain('aria-label="目次を閉じる"');
    expect(html).toContain('Roadmap');
    expect(html).not.toContain('Pages in this Space');
  });

  it('renders the library in Japanese with localized dates and counts', () => {
    setLocale('ja');
    const html = render(
      <SpaceLibrary
        space={space}
        pages={[page('a', 'Roadmap'), page('b', 'Plan', { content: '# Plan' })]}
        onPage={() => {}}
        onNew={() => {}}
      />,
    );
    expect(html).toContain('Researchのページライブラリ');
    expect(html).toContain('>スペース<');
    expect(html).toContain('新しいページ');
    expect(html).toContain('placeholder="ページを検索"');
    expect(html).toContain('最近編集した順');
    expect(html).toContain('すべてのページ');
    expect(html).toContain('2ページ');
    expect(html).toContain('空のページです。書き始めましょう。');
    expect(html).toMatch(/\d+月\d+日に編集/);
    expect(html).toContain('Roadmap');
    expect(html).toContain('Research');
  });

  it('renders the empty library in Japanese', () => {
    setLocale('ja');
    const html = render(
      <SpaceLibrary
        space={space}
        pages={[]}
        onPage={() => {}}
        onNew={() => {}}
      />,
    );
    expect(html).toContain('まだページがありません');
    expect(html).toContain(
      '最初のページを作成して、このスペースの整理を始めましょう。',
    );
  });

  it('renders the library in English by default', () => {
    const html = render(
      <SpaceLibrary
        space={space}
        pages={[page('a', 'Roadmap')]}
        onPage={() => {}}
        onNew={() => {}}
      />,
    );
    expect(html).toContain('Research page library');
    expect(html).toContain('1 page<');
    expect(html).toContain('Edited Jan 15');
  });

  it('localizes the space navigation and page menu labels', () => {
    setLocale('ja');
    expect(
      render(<SpaceNav space={space} active={false} onOpen={() => {}} />),
    ).toContain('aria-label="Researchを展開"');
    expect(
      render(<DocumentMenu items={[{ label: t('Move page'), action() {} }]} />),
    ).toContain('aria-label="ページの操作"');
    expect(pageExcerpt('Intro\n\n```ts\nx\n```')).toBe('Intro コードブロック');
  });
});

describe('server messages', () => {
  it('translates exact page and Space messages', () => {
    setLocale('ja');
    expect(tMessage('Page not found in this Space.')).toBe(
      'このスペースにページが見つかりません。',
    );
    expect(
      tMessage(
        'This page changed. Reload the latest revision before saving your draft.',
      ),
    ).toBe(
      'このページは変更されました。下書きを保存する前に、最新の版を読み込んでください。',
    );
    expect(tMessage('Space not found.')).toBe('スペースが見つかりません。');
  });

  it('translates pattern messages and leaves unknown text alone', () => {
    setLocale('ja');
    expect(tMessage('Request failed (404).')).toBe(
      'リクエストに失敗しました（404）。',
    );
    expect(tMessage('Something nobody anticipated')).toBe(
      'Something nobody anticipated',
    );
  });

  it('returns messages untouched in English', () => {
    expect(tMessage('Request failed (404).')).toBe('Request failed (404).');
    expect(tMessage('Space not found.')).toBe('Space not found.');
  });
});

describe('catalog coverage', () => {
  const owned = [
    'PageConversation.tsx',
    'PageDocument.tsx',
    'PageOutline.tsx',
    'SpaceLibrary.tsx',
    'SpaceNav.tsx',
    'SpaceWorkspace.tsx',
    'page-chat-requests.ts',
    'editor/DocumentMenu.tsx',
    'editor/RichEditor.tsx',
    'editor/slash-commands.ts',
    'editor/autosave.ts',
    'editor/markdown.ts',
    'editor/use-page-autosave.ts',
  ];
  const sources = owned.map((file) => ({
    file,
    text: readFileSync(new URL(`../../src/client/${file}`, import.meta.url), {
      encoding: 'utf8',
    }),
  }));
  const catalog = {
    ...serverEntries,
    ...appEntries,
    ...chatEntries,
    ...pageEntries,
  };
  /** Keys that are deliberately shown in English even in Japanese. */
  const intentionallyEnglish = new Set<string>([]);
  const literalKeys = sources.flatMap(({ file, text }) =>
    [...text.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/gs)].map((match) => ({
      file,
      key: match[2].replace(/\\(['"\\])/g, '$1'),
    })),
  );

  it('finds the literal t() keys in the owned files', () => {
    expect(literalKeys.length).toBeGreaterThan(90);
  });

  it('has a Japanese entry for every literal t() key', () => {
    const missing = literalKeys.filter(
      ({ key }) =>
        !intentionallyEnglish.has(key) &&
        (!Object.hasOwn(catalog, key) || !catalog[key]),
    );
    expect(missing).toEqual([]);
  });

  it('translates instead of copying the English text', () => {
    const copied = literalKeys.filter(
      ({ key }) => !intentionallyEnglish.has(key) && catalog[key] === key,
    );
    expect(copied).toEqual([]);
  });

  it('only calls t() with a non-literal key for the slash-command blocks', () => {
    const dynamic = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/\bt\((?!\s*['"])([^)]*)\)/g)].map(
        (match) => `${file}: ${match[1]}`,
      ),
    );
    expect(dynamic.sort()).toEqual([
      'editor/slash-commands.ts: block.description',
      'editor/slash-commands.ts: block.title',
      'editor/slash-commands.ts: item.description',
      'editor/slash-commands.ts: item.title',
    ]);
  });

  it('has Japanese for every slash-command title and description', () => {
    for (const block of blocks) {
      expect(pageEntries[block.title], block.title).toBeTruthy();
      expect(pageEntries[block.description], block.description).toBeTruthy();
    }
  });

  it('keeps the placeholders of every page entry', () => {
    const names = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, value] of Object.entries(pageEntries))
      expect(names(value), key).toEqual(names(key));
  });
});
