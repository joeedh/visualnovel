import { EDITOR_IDS } from '../../../../src/shared/editors.js';
import type { Pane } from '../panes.js';
import { routeFor, visibleEditors } from '../route.js';

const pane = (editor: string, over: Partial<Pane> = {}): Pane => ({
  editor,
  chrome  : false,
  floating: false,
  active  : false,
  width   : 400,
  height  : 400,
  ...over,
});

describe('visibleEditors', () => {
  it('lists the editors some pane shows, in EDITORS order, popups included', () => {
    const shown = visibleEditors([pane('wiki', { floating: true }), pane('documents')]);
    expect(shown).toEqual(EDITOR_IDS.filter((id) => id === 'documents' || id === 'wiki'));
  });

  it('leaves out a pane showing chrome rather than an editor', () => {
    expect(visibleEditors([pane('documents'), pane('palette', { chrome: true })])).toEqual([
      'documents',
    ]);
  });
});

describe('routeFor', () => {
  const tea = { id: 'wiki:wiki/tea.md', kind: 'wiki' as const, label: 'tea', path: 'wiki/tea.md' };

  it('routes over the editors the panes show', () => {
    expect(routeFor({ node: tea, panes: [pane('documents'), pane('wiki')] })).toMatchObject({
      action: 'open',
      editor: 'wiki',
      where : 'here',
    });
    expect(routeFor({ node: tea, panes: [pane('documents')] })).toMatchObject({
      where: 'elsewhere',
    });
  });
});
