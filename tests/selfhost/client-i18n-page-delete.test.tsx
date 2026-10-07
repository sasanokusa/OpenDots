import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn());
const menu = vi.hoisted(() => ({
  items: [] as { label: string; action: () => unknown }[],
}));
vi.mock('../../src/client/api', () => ({ api }));
vi.mock('../../src/client/editor/DocumentMenu', () => ({
  DocumentMenu: ({ items }: { items: typeof menu.items }) => {
    menu.items = items;
    return null;
  },
}));
vi.mock('../../src/client/editor/RichEditor', () => ({ default: () => null }));
vi.mock('../../src/client/PageConversation', () => ({
  PageConversation: () => null,
}));
import { PageDocument } from '../../src/client/PageDocument';
import { setLocale } from '../../src/client/selfhost/i18n/index';

const page = {
  id: 'a',
  spaceId: 'space',
  parentId: null,
  title: '週次メモ',
  content: 'text',
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  sourceThreadId: null,
};
const props = () => ({
  page,
  pages: [page],
  workspace: {} as never,
  paused: false,
  onHome: vi.fn(),
  onOutline: vi.fn(),
  onSubpage: vi.fn(),
  onDirty: vi.fn(),
  onSaved: vi.fn(),
  onRefresh: vi.fn(),
  onDeleted: vi.fn(),
  onSchedule: vi.fn(),
  onThread: vi.fn(),
  onSettings: vi.fn(),
  onCreateDot: vi.fn(),
});

beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setLocale('ja');
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocale('en');
});

describe('page deletion in Japanese', () => {
  it('labels the menu item and asks for confirmation in Japanese', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', {
      confirm,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(createElement(PageDocument, props()));
    });
    expect(menu.items.map((item) => item.label)).toContain('ページを削除');
    await act(async () => {
      await menu.items.find((item) => item.label === 'ページを削除')!.action();
    });
    expect(confirm).toHaveBeenCalledWith(
      '「週次メモ」を削除しますか？この操作は元に戻せません。サブページは、このページの親ページの下に移動します。',
    );
    expect(api).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it('shows a translated notice when the page cannot be deleted', async () => {
    vi.stubGlobal('window', {
      confirm: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    api.mockRejectedValue(new Error('Page not found in this Space.'));
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(createElement(PageDocument, props()));
    });
    await act(async () => {
      await menu.items.find((item) => item.label === 'ページを削除')!.action();
    });
    expect(JSON.stringify(root.toJSON())).toContain(
      'このスペースにページが見つかりません。',
    );
    await act(async () => {
      root.unmount();
    });
  });
});
