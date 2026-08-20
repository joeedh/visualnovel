import { ShellState } from '../state.js';
import { pinnedView, type Pin } from '../pin.js';

function pinned(field: Pin['field'], held: string): { live: ShellState; view: ShellState } {
  const live = new ShellState();
  let value = held;
  const view = pinnedView(live, {
    field,
    get: () => value,
    set: (next) => {
      value = next;
    },
  });
  return { live, view };
}

describe('what a pinned editor reads', () => {
  test('the pin, where the shell has moved on', () => {
    const { live, view } = pinned('sceneId', 'arrival');
    live.sceneId = 'ending';
    expect(view.sceneId).toBe('arrival');
    expect(live.sceneId).toBe('ending');
  });

  test('the shell, for everything the pin does not hold', () => {
    const { live, view } = pinned('sceneId', 'arrival');
    live.shotId = 'sh2';
    live.projectTitle = 'Test4';
    live.busyWhat = 'a pipeline run';
    // A pinned Coverage holds its scene and still follows the selected shot, so a pinned pane is a
    // second view of the project rather than a frozen copy of it.
    expect(view.shotId).toBe('sh2');
    expect(view.projectTitle).toBe('Test4');
    expect(view.busyWhat).toBe('a pipeline run');
  });

  test('each editor pins its own field, and only that one', () => {
    const { live, view } = pinned('docPath', 'wiki/history.md');
    live.docPath = 'wiki/cast.md';
    live.assetHash = 'abc123';
    expect(view.docPath).toBe('wiki/history.md');
    expect(view.assetHash).toBe('abc123');
  });
});

describe('what a write through a pinned editor does', () => {
  test('moves the pin and the shell together', () => {
    const { live, view } = pinned('sceneId', 'arrival');
    // A scene chosen in a pinned Script's picker moves that pane's pin. Selection is shared across
    // the app, so the shell moves with it.
    view.sceneId = 'market';
    expect(view.sceneId).toBe('market');
    expect(live.sceneId).toBe('market');
  });

  test('leaves the pin alone when the write is about something else', () => {
    const { live, view } = pinned('sceneId', 'arrival');
    view.shotId = 'sh7';
    expect(live.shotId).toBe('sh7');
    expect(view.sceneId).toBe('arrival');
  });
});
