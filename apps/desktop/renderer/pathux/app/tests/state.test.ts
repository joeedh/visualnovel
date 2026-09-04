import { pinnedView } from '../../doctree/pin.js';
import { ShellState, type SelectionField } from '../state.js';

function watched(): { ui: ShellState; moved: SelectionField[] } {
  const ui = new ShellState();
  const moved: SelectionField[] = [];
  ui.onSelect = (field) => moved.push(field);
  return { ui, moved };
}

describe('what a selection write reports', () => {
  test('the field that moved', () => {
    const { ui, moved } = watched();
    ui.sceneId = 'arrival';
    ui.assetHash = 'abc123';
    expect(moved).toEqual(['sceneId', 'assetHash']);
    expect(ui.sceneId).toBe('arrival');
  });

  test('nothing, when the value is the one already held', () => {
    const { ui, moved } = watched();
    ui.docPath = 'wiki/cast.md';
    ui.docPath = 'wiki/cast.md';
    expect(moved).toEqual(['docPath']);
  });

  test('every field a launch remembers', () => {
    const { ui, moved } = watched();
    ui.sceneId = 's';
    ui.shotId = 'sh';
    ui.characterId = 'c';
    ui.docPath = 'd';
    ui.taskHash = 't';
    ui.assetHash = 'a';
    expect(moved).toEqual(['sceneId', 'shotId', 'characterId', 'docPath', 'taskHash', 'assetHash']);
  });

  test('nothing at all, for a field no launch remembers', () => {
    const { ui, moved } = watched();
    ui.projectTitle = 'Test4';
    ui.busyWhat = 'a pipeline run';
    expect(moved).toEqual([]);
  });

  test('the field a pinned pane wrote, since that write moves the shell too', () => {
    const { ui, moved } = watched();
    const view = pinnedView(ui, { field: 'sceneId', get: () => 'arrival', set: () => {} });
    view.sceneId = 'market';
    expect(moved).toEqual(['sceneId']);
    expect(ui.sceneId).toBe('market');
  });
});
