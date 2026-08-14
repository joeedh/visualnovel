/**
 * The one list of editors, and the check that the renderer's registry agrees with it. The check
 * shipped one-directional and untested, which is how an editor can be registered, offered in
 * path.ux's own pane menu, and unreachable from `view.*` at the same time.
 */
import { EDITOR_IDS, EDITORS, OPEN_WHERE, editorNameProblems, editorTitle } from '../editors.js';

describe('the editor vocabulary', () => {
  it('names every editor once', () => {
    expect(new Set(EDITOR_IDS).size).toBe(EDITORS.length);
  });

  it('falls back to the id for a title it has not got', () => {
    expect(editorTitle('wiki')).toBe('Wiki');
    expect(editorTitle('nope' as (typeof EDITOR_IDS)[number])).toBe('nope');
  });

  // `where` is a `oneOf` prop built from this, so a direction missing here is a direction no
  // command can express — the reason it is a list rather than a union spelled twice.
  it('offers a direction and its opposite', () => {
    expect([...OPEN_WHERE].sort()).toEqual(['above', 'below', 'here', 'left', 'right']);
  });
});

describe('editorNameProblems', () => {
  it('is quiet when the registry matches the list', () => {
    expect(editorNameProblems(EDITOR_IDS)).toEqual({ unregistered: [], unnamed: [] });
  });

  it('reports an editor `view.*` offers that nothing registered', () => {
    const registered = EDITOR_IDS.filter((id) => id !== 'wiki');
    expect(editorNameProblems(registered)).toEqual({ unregistered: ['wiki'], unnamed: [] });
  });

  /**
   * The direction that was silent. A registered editor absent from `EDITORS` is not merely
   * unreachable — path.ux's area switcher enumerates the area classes and offers it from the pane
   * menu, so the author can be looking at an editor no command in the app can name.
   */
  it('reports an editor registered under a name the list has not got', () => {
    expect(editorNameProblems([...EDITOR_IDS, 'sidebar'])).toEqual({
      unregistered: [],
      unnamed: ['sidebar'],
    });
  });

  it('reports both directions at once, sorted, so one boot says everything', () => {
    const registered = [...EDITOR_IDS.filter((id) => id !== 'play'), 'zed', 'aardvark'];
    expect(editorNameProblems(registered)).toEqual({
      unregistered: ['play'],
      unnamed: ['aardvark', 'zed'],
    });
  });
});
