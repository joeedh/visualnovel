/**
 * The one list of editors, and the check that the renderer's registry agrees with it. The check
 * shipped one-directional and untested, which is how an editor can be registered, offered in
 * path.ux's own pane menu, and unreachable from `view.*` at the same time.
 */
import {
  EDITOR_IDS,
  EDITORS,
  OPEN_WHERE,
  PIN_NOUN,
  editorNameProblems,
  editorTitle,
  editorTooltip,
  pinFieldOf,
} from '../editors.js';

describe('the editor vocabulary', () => {
  it('names every editor once', () => {
    expect(new Set(EDITOR_IDS).size).toBe(EDITORS.length);
  });

  it('falls back to the id for a title it has not got', () => {
    expect(editorTitle('wiki')).toBe('Wiki');
    expect(editorTitle('nope' as (typeof EDITOR_IDS)[number])).toBe('nope');
  });

  /**
   * The tab, the menu entry and the palette all hover the same sentence, and it is this one — so
   * it has to say what the editor shows rather than read its title back.
   */
  it('says what each editor shows, never just its name', () => {
    expect(editorTooltip('script')).toBe("Show one scene's lines in this pane");

    for (const editor of EDITORS) {
      const tooltip = editorTooltip(editor.id);
      expect(tooltip).toContain(editor.what);
      expect(tooltip).not.toBe(`Show ${editor.title} in this pane`);
    }
  });

  // `where` is a `oneOf` prop built from this, so a direction missing here is a direction no
  // command can express — the reason it is a list rather than a union spelled twice.
  it('offers a direction and its opposite', () => {
    expect([...OPEN_WHERE].sort()).toEqual([
      'above',
      'below',
      'elsewhere',
      'here',
      'left',
      'right',
      // Not a direction: `window` is where main opens a second renderer instead of splitting.
      'window',
    ]);
  });
});

/**
 * The pin is drawn, persisted and described from this one declaration, so what is asserted here
 * is that the declaration is complete: a field nobody can name a noun for would ship a toggle
 * whose tooltip says `undefined`.
 */
describe('what an editor can be pinned to', () => {
  it('answers only for an editor that declared it', () => {
    expect(pinFieldOf('script')).toBe('sceneId');
    expect(pinFieldOf('timeline')).toBe('sceneId');
    expect(pinFieldOf('wiki')).toBe('docPath');
    expect(pinFieldOf('asset')).toBe('assetHash');
    expect(pinFieldOf('inspector')).toBe('taskHash');
    // Convo follows nothing, and an unregistered name is not an error.
    expect(pinFieldOf('convo')).toBeUndefined();
    expect(pinFieldOf('nope')).toBeUndefined();
  });

  it('has a noun for every field an editor declares', () => {
    for (const editor of EDITORS) {
      const field = pinFieldOf(editor.id);
      if (field === undefined) continue;
      expect(PIN_NOUN[field]).toBeTruthy();
    }
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
