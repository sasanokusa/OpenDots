import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelfhostClientEvent } from '../../src/client/selfhost/events';
import type { PendingApproval } from '../../src/selfhost/approvals/broker';

const mocks = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: vi.fn(),
    listener: undefined as undefined | ((event: SelfhostClientEvent) => void),
  };
});
vi.mock('../../src/client/api', () => ({
  api: mocks.api,
  ApiError: mocks.ApiError,
  authHeaders: () => ({}),
}));
vi.mock('../../src/client/selfhost/events', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/client/selfhost/events')
  >()),
  useSelfhostEvents: (
    _enabled: boolean,
    listener: (event: SelfhostClientEvent) => void,
  ) => {
    mocks.listener = listener;
  },
}));
import { ApprovalCard } from '../../src/client/selfhost/ApprovalCard';
import {
  SelfhostEventHub,
  toClientEvent,
} from '../../src/client/selfhost/events';
import { setLocale } from '../../src/client/selfhost/i18n/index';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 7, 0, 0, 0);

const approval = (extra: Partial<PendingApproval> = {}): PendingApproval => ({
  id: 'a1',
  threadId: 't1',
  dotId: 'd1',
  tool: 'bash',
  summary: 'bash: rm -rf build',
  reason: 'Deleting a directory changes files.',
  createdAt: NOW,
  expiresAt: NOW + 5 * MINUTE,
  ...extra,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Answers the list request with `pending`, and every POST with `{ ok: true }`. */
function serve(pending: PendingApproval[]) {
  mocks.api.mockImplementation(async (path: string, method = 'GET') =>
    method === 'GET' ? { approvals: pending } : { ok: true },
  );
}

let root: ReactTestRenderer | undefined;
async function render(threadId = 't1') {
  await act(async () => {
    root = create(<ApprovalCard threadId={threadId} />);
  });
  return root!;
}
const emit = (event: SelfhostClientEvent) =>
  act(async () => {
    mocks.listener?.(event);
  });
const text = () => JSON.stringify(root!.toJSON());
const buttons = () => root!.root.findAllByType('button');
const press = (label: string) =>
  act(async () => {
    const button = buttons().find((item) => item.children.join('') === label);
    if (!button) throw new Error(`No button "${label}"`);
    button.props.onClick();
  });

beforeEach(() => {
  mocks.api.mockReset();
  mocks.listener = undefined;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  setLocale('en');
  vi.useRealTimers();
});

describe('ApprovalCard', () => {
  it('lists the pending approvals of its own thread', async () => {
    serve([approval()]);
    await render('t1');
    expect(mocks.api).toHaveBeenCalledWith(
      '/selfhost/approvals?threadId=t1',
      'GET',
      undefined,
      undefined,
    );
    expect(text()).toContain('Needs your approval');
    expect(
      root!.root.findByProps({ className: 'approval-summary' }).children,
    ).toEqual(['bash: rm -rf build']);
    expect(text()).toContain('Deleting a directory changes files.');
    expect(buttons().map((item) => item.children.join(''))).toEqual([
      'Allow',
      'Deny',
    ]);
  });

  it('shows the time left and counts down', async () => {
    serve([approval()]);
    await render();
    expect(text()).toContain('Expires in 5:00');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(text()).toContain('Expires in 3:59');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
    });
    expect(text()).toContain('Expired');
  });

  it('renders nothing when nothing is pending or the endpoint is missing', async () => {
    serve([]);
    await render();
    expect(root!.toJSON()).toBeNull();

    await act(async () => root!.unmount());
    mocks.api.mockRejectedValue(new mocks.ApiError('Not found.', 404));
    await render();
    expect(root!.toJSON()).toBeNull();
  });

  it('sends allow with the right body and removes the card', async () => {
    serve([approval()]);
    await render();
    await press('Allow');
    expect(mocks.api).toHaveBeenLastCalledWith(
      '/selfhost/approvals/a1',
      'POST',
      { decision: 'allow' },
    );
    expect(root!.toJSON()).toBeNull();
  });

  it('sends deny with the right body', async () => {
    serve([approval({ id: 'b/2' })]);
    await render();
    await press('Deny');
    expect(mocks.api).toHaveBeenLastCalledWith(
      '/selfhost/approvals/b%2F2',
      'POST',
      { decision: 'deny' },
    );
    expect(root!.toJSON()).toBeNull();
  });

  it('disables both buttons while the answer is on its way', async () => {
    serve([approval()]);
    await render();
    const gate = deferred<{ ok: true }>();
    mocks.api.mockImplementationOnce(() => gate.promise);
    await press('Allow');
    expect(buttons().map((item) => item.props.disabled)).toEqual([true, true]);
    expect(text()).toContain('Sending…');
    // A second click while waiting does not send again.
    await act(async () => buttons()[1]!.props.onClick());
    expect(mocks.api.mock.calls.filter(([, m]) => m === 'POST')).toHaveLength(
      1,
    );
    await act(async () => gate.resolve({ ok: true }));
    expect(root!.toJSON()).toBeNull();
  });

  it('says so when the request had already closed (409)', async () => {
    serve([approval()]);
    await render();
    mocks.api.mockRejectedValueOnce(
      new mocks.ApiError('This approval request has already closed.', 409),
    );
    await press('Allow');
    expect(root!.root.findByProps({ role: 'alert' }).children).toEqual([
      'This request has already closed.',
    ]);
    expect(buttons().map((item) => item.props.disabled)).toEqual([true, true]);
  });

  it('shows other failures and lets the owner try again', async () => {
    serve([approval()]);
    await render();
    mocks.api.mockRejectedValueOnce(new Error('Failed to fetch'));
    await press('Deny');
    expect(root!.root.findByProps({ role: 'alert' }).children).toEqual([
      'Failed to fetch',
    ]);
    expect(buttons().map((item) => item.props.disabled)).toEqual([
      false,
      false,
    ]);
    await press('Deny');
    expect(root!.toJSON()).toBeNull();
  });

  it('disappears when the approval is resolved from another place', async () => {
    serve([approval(), approval({ id: 'a2', summary: 'bash: ls' })]);
    await render();
    expect(root!.root.findAllByType('section')).toHaveLength(2);
    await emit({
      type: 'approval_resolved',
      id: 'a1',
      threadId: 't1',
      decision: 'allow',
      by: 'discord',
    });
    expect(root!.root.findAllByType('section')).toHaveLength(1);
    expect(text()).toContain('bash: ls');
    await emit({
      type: 'approval_resolved',
      id: 'a2',
      threadId: 't1',
      decision: 'deny',
      by: 'timeout',
    });
    expect(root!.toJSON()).toBeNull();
  });

  it('shows a request that arrives while the conversation is open', async () => {
    serve([]);
    await render();
    await emit({ type: 'approval_requested', approval: approval() });
    expect(text()).toContain('rm -rf build');
    // The same request again, or one for another conversation, adds nothing.
    await emit({ type: 'approval_requested', approval: approval() });
    await emit({
      type: 'approval_requested',
      approval: approval({ id: 'a9', threadId: 'other' }),
    });
    expect(root!.root.findAllByType('section')).toHaveLength(1);
  });

  it('loads again when the event stream reconnects', async () => {
    serve([]);
    await render();
    serve([approval()]);
    await emit({ type: 'ready' });
    expect(text()).toContain('rm -rf build');
    serve([]);
    await emit({ type: 'ready' });
    expect(root!.toJSON()).toBeNull();
  });

  it('does not bring a resolved approval back from a late list response', async () => {
    const gate = deferred<{ approvals: PendingApproval[] }>();
    mocks.api.mockImplementationOnce(() => gate.promise);
    await render();
    await emit({
      type: 'approval_resolved',
      id: 'a1',
      threadId: 't1',
      decision: 'allow',
      by: 'web',
    });
    await act(async () => gate.resolve({ approvals: [approval()] }));
    expect(root!.toJSON()).toBeNull();
  });

  it('starts empty for another conversation', async () => {
    serve([approval()]);
    await render('t1');
    expect(text()).toContain('rm -rf build');
    serve([]);
    await act(async () => {
      root!.update(<ApprovalCard threadId="t2" />);
    });
    expect(root!.toJSON()).toBeNull();
    expect(mocks.api).toHaveBeenLastCalledWith(
      '/selfhost/approvals?threadId=t2',
      'GET',
      undefined,
      undefined,
    );
  });

  it('is written in Japanese for the Japanese app', async () => {
    setLocale('ja');
    serve([approval()]);
    await render();
    expect(text()).toContain('確認が必要です');
    expect(text()).toContain('残り5:00');
    expect(buttons().map((item) => item.children.join(''))).toEqual([
      '許可',
      '拒否',
    ]);
    mocks.api.mockRejectedValueOnce(new mocks.ApiError('closed', 409));
    await press('許可');
    expect(root!.root.findByProps({ role: 'alert' }).children).toEqual([
      'すでに締め切られました',
    ]);
  });
});

describe('approval events from the server stream', () => {
  const requested = {
    type: 'approval_requested',
    approval: approval(),
  };
  const resolved = {
    type: 'approval_resolved',
    id: 'a1',
    threadId: 't1',
    decision: 'allow',
    by: 'discord',
  };

  it('maps both events', () => {
    expect(
      toClientEvent({
        event: 'approval_requested',
        data: JSON.stringify(requested),
      }),
    ).toEqual(requested);
    expect(
      toClientEvent({
        event: 'approval_resolved',
        data: JSON.stringify(resolved),
      }),
    ).toEqual(resolved);
  });

  it('ignores incomplete or unknown payloads', () => {
    const frame = (event: string, payload: unknown) =>
      toClientEvent({ event, data: JSON.stringify(payload) });
    expect(frame('approval_requested', {})).toBeUndefined();
    expect(frame('approval_requested', { approval: null })).toBeUndefined();
    expect(
      frame('approval_requested', {
        approval: { ...approval(), expiresAt: 'soon' },
      }),
    ).toBeUndefined();
    expect(frame('approval_resolved', { ...resolved, by: 'ghost' })).toBe(
      undefined,
    );
    expect(frame('approval_resolved', { ...resolved, decision: 'maybe' })).toBe(
      undefined,
    );
    expect(frame('approval_resolved', { id: 'a1' })).toBeUndefined();
    expect(
      toClientEvent({ event: 'approval_resolved', data: '{' }),
    ).toBeUndefined();
  });

  it('reaches listeners of the shared connection', async () => {
    vi.useRealTimers();
    const body = [requested, resolved]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join('');
    const hub = new SelfhostEventHub({
      fetchFn: (async () => new Response(body)) as unknown as typeof fetch,
      headers: () => ({}),
    });
    const seen: SelfhostClientEvent[] = [];
    const stop = hub.subscribe((event) => seen.push(event));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    stop();
    expect(seen.map((event) => event.type)).toEqual([
      'approval_requested',
      'approval_resolved',
    ]);
  });
});
