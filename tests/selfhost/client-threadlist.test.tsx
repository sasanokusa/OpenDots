import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Dot } from '../../src/shared/types';
import type { SelfhostThread } from '../../src/client/selfhost/api';
import type { SelfhostClientEvent } from '../../src/client/selfhost/events';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  patch: vi.fn(),
  remote: [] as { id: string; name?: string }[],
  listener: undefined as undefined | ((event: SelfhostClientEvent) => void),
}));
vi.mock('@copilotkit/react-core/v2', () => ({
  useThreads: () => ({
    threads: mocks.remote,
    error: undefined,
    hasMoreThreads: false,
    isFetchingMoreThreads: false,
    fetchMoreThreads: vi.fn(),
  }),
}));
vi.mock('../../src/client/selfhost/api', () => ({
  listSelfhostThreads: mocks.list,
  patchSelfhostThread: mocks.patch,
}));
vi.mock('../../src/client/selfhost/events', () => ({
  useSelfhostEvents: (
    enabled: boolean,
    listener: (event: SelfhostClientEvent) => void,
  ) => {
    mocks.listener = enabled ? listener : undefined;
  },
}));
import { ThreadList } from '../../src/client/ThreadList';

const dots = [{ id: 'd1', name: 'Scout' } as Dot];
const local: Conversation[] = [
  {
    id: 't1',
    dotId: 'd1',
    ownerId: 'o',
    title: 'Archived elsewhere',
    createdAt: 1,
  },
  { id: 't2', dotId: 'd1', ownerId: 'o', title: 'Local second', createdAt: 2 },
  { id: 't3', dotId: 'd1', ownerId: 'o', title: 'Local third', createdAt: 3 },
];
const record = (
  id: string,
  extra: Partial<SelfhostThread> = {},
): SelfhostThread => ({
  id,
  name: null,
  agentId: 'd1',
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

let root: ReactTestRenderer;
const onArchivedChange = vi.fn();
const html = () => JSON.stringify(root.toJSON());
async function mount(selfhost: boolean | undefined) {
  await act(async () => {
    root = create(
      <ThreadList
        dots={dots}
        dotId="d1"
        local={local}
        onSelect={() => {}}
        onNew={() => {}}
        selfhost={selfhost}
        onArchivedChange={onArchivedChange}
      />,
    );
  });
}
const byLabel = (label: string) =>
  root.root.findByProps({ 'aria-label': label });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  mocks.list
    .mockReset()
    .mockResolvedValue([
      record('t1', { archived: true, name: 'Archived elsewhere' }),
      record('t2', { name: 'Named on the server' }),
    ]);
  mocks.patch.mockReset();
  mocks.remote = [{ id: 't2', name: 'Upstream name' }];
  mocks.listener = undefined;
  onArchivedChange.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ThreadList in self-hosted mode', () => {
  it('hides threads archived anywhere and prefers the server-side name', async () => {
    await mount(true);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(html()).not.toContain('Archived elsewhere');
    expect(html()).toContain('Named on the server');
    expect(html()).not.toContain('Upstream name');
    expect(html()).not.toContain('Local second');
    expect(html()).toContain('Local third');
    expect(onArchivedChange).toHaveBeenLastCalledWith(new Set(['t1']));
  });

  it('refetches when the server reports a thread update', async () => {
    await mount(true);
    mocks.list.mockResolvedValue([
      record('t1', { archived: true }),
      record('t3', { archived: true }),
      record('t2', { name: 'Renamed on a phone' }),
    ]);
    await act(async () => {
      mocks.listener?.({ type: 'thread_updated', threadId: 't3' });
      mocks.listener?.({ type: 'thread_updated', threadId: 't2' });
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(html()).toContain('Renamed on a phone');
    expect(html()).not.toContain('Local third');
    expect(onArchivedChange).toHaveBeenLastCalledWith(new Set(['t1', 't3']));
  });

  it('shows the empty message when everything is archived', async () => {
    mocks.list.mockResolvedValue(
      local.map((item) => record(item.id, { archived: true })),
    );
    await mount(true);
    expect(html()).toContain('Your first conversation will live here.');
  });

  it('archives from the "…" menu and removes the row', async () => {
    mocks.patch.mockResolvedValue(record('t3', { archived: true }));
    await mount(true);
    await act(async () => byLabel('Options for Local third').props.onClick());
    expect(html()).toContain('Rename');
    expect(html()).toContain('Archive');
    mocks.list.mockResolvedValue([
      record('t1', { archived: true }),
      record('t3', { archived: true }),
    ]);
    const archive = root.root
      .findAllByProps({ role: 'menuitem' })
      .find((item) => item.children.join('') === 'Archive')!;
    await act(async () => archive.props.onClick());
    expect(mocks.patch).toHaveBeenCalledWith('t3', { archived: true });
    expect(html()).not.toContain('Local third');
  });

  it('renames inline: Enter saves, Escape and unchanged names do not', async () => {
    mocks.patch.mockResolvedValue(record('t3', { name: 'Fresh name' }));
    await mount(true);
    const startRename = async () => {
      await act(async () => byLabel('Options for Local third').props.onClick());
      const rename = root.root
        .findAllByProps({ role: 'menuitem' })
        .find((item) => item.children.join('') === 'Rename')!;
      await act(async () => rename.props.onClick());
      return byLabel('Rename conversation');
    };
    const key = (key: string, value: string) => ({
      key,
      currentTarget: { value },
      preventDefault: () => {},
      stopPropagation: () => {},
    });
    let input = await startRename();
    expect(input.props.defaultValue).toBe('Local third');
    await act(async () => input.props.onKeyDown(key('Escape', 'Nope')));
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(html()).toContain('Local third');

    input = await startRename();
    await act(async () =>
      input.props.onKeyDown(key('Enter', '  Local third ')),
    );
    expect(mocks.patch).not.toHaveBeenCalled();

    input = await startRename();
    await act(async () => input.props.onKeyDown(key('Enter', ' Fresh name ')));
    expect(mocks.patch).toHaveBeenCalledWith('t3', { name: 'Fresh name' });
    expect(
      root.root.findAllByProps({ 'aria-label': 'Rename conversation' }),
    ).toHaveLength(0);
  });

  it('shows the server error and keeps the input open when a rename fails', async () => {
    mocks.patch.mockRejectedValue(new Error('Conversation not found.'));
    await mount(true);
    await act(async () => byLabel('Options for Local third').props.onClick());
    const rename = root.root
      .findAllByProps({ role: 'menuitem' })
      .find((item) => item.children.join('') === 'Rename')!;
    await act(async () => rename.props.onClick());
    await act(async () =>
      byLabel('Rename conversation').props.onKeyDown({
        key: 'Enter',
        currentTarget: { value: 'Whatever' },
        preventDefault: () => {},
      }),
    );
    expect(html()).toContain('Conversation not found.');
    expect(byLabel('Rename conversation')).toBeTruthy();
  });
});

describe('ThreadList with the upstream backend', () => {
  for (const selfhost of [undefined, false]) {
    it(`is unchanged when selfhost is ${String(selfhost)}`, async () => {
      await mount(selfhost);
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.listener).toBeUndefined();
      expect(onArchivedChange).not.toHaveBeenCalled();
      for (const title of [
        'Archived elsewhere',
        'Upstream name',
        'Local third',
      ])
        expect(html()).toContain(title);
      expect(html()).not.toContain('Named on the server');
      expect(html()).not.toContain('Local second');
      expect(html()).not.toContain('thread-row');
      expect(html()).not.toContain('Options for');
    });
  }
});
