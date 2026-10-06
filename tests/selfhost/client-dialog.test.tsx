import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WorkspaceDialog } from '../../src/client/WorkspaceDialog';
import type {
  Dot,
  SetupStatus,
  State,
  WorkspaceState,
} from '../../src/shared/types';

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
const setup = (backend: SetupStatus['backend']): SetupStatus => ({
  backend,
  intelligence: true,
  model: true,
  browser: false,
  voice: false,
  slack: 'off',
  missing: [],
});
const render = (backend: SetupStatus['backend']) =>
  renderToStaticMarkup(
    <WorkspaceDialog
      dialog={{ type: 'dot', dot, spaceId: 's1' }}
      state={
        { settings: { researchAllowed: true, memoryAllowed: true } } as State
      }
      workspace={
        {
          spaces: [{ id: 's1', name: 'Home' }],
          dots: [dot],
          conversations: [],
          setup: setup(backend),
          calls: [],
        } as unknown as WorkspaceState
      }
      onClose={() => {}}
      mutate={async () => true}
    />,
  );

it('hides the Intelligence-only learning section for the self-hosted backend', () => {
  const html = render('selfhost');
  expect(html).not.toContain('Automatic Learning');
  expect(html).not.toContain('Learning container ID');
  expect(html).not.toContain('Use published skills');
  expect(html).toContain('Space access');
  expect(html).toContain('Public-page research');
});

it.each(['intelligence', undefined] as const)(
  'keeps the learning section for the %s backend',
  (backend) => {
    const html = render(backend);
    expect(html).toContain('Automatic Learning');
    expect(html).toContain('Learning container ID');
    expect(html).toContain('Use published skills');
  },
);
