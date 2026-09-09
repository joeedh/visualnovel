import { applyStyleAction, controls, reloadAction, styleBox } from '../projectbar.js';
import { duplicateKeys, keyOf } from '../anchors.js';

describe('applyStyleAction', () => {
  it('writes the style the box supplies once something in it has changed', () => {
    expect(applyStyleAction(true, true)).toEqual({
      ok      : true,
      id      : 'project.setArtStyle',
      props   : {},
      label   : 'Apply',
      tooltip : 'Write these settings back to project.yaml',
      supplies: ['style'],
    });
  });

  it('refuses with no project, and with nothing to write', () => {
    expect(applyStyleAction(false, true)).toMatchObject({
      ok     : false,
      id     : 'project.setArtStyle',
      refusal: { reason: 'No project is open.' },
    });
    expect(applyStyleAction(true, false)).toMatchObject({
      ok     : false,
      id     : 'project.setArtStyle',
      refusal: { reason: 'No changes' },
    });
  });
});

describe('styleBox', () => {
  it('is the same write as Apply, supplied by the box, refused only with no project', () => {
    expect(styleBox(true)).toEqual({
      ok      : true,
      id      : 'project.setArtStyle',
      props   : {},
      on      : 'style',
      label   : 'Art style',
      tooltip : 'The sentence every image prompt opens with. Applying it re-keys every image task.',
      supplies: ['style'],
    });
    expect(styleBox(false)).toMatchObject({
      ok     : false,
      refusal: { reason: 'No project is open.' },
    });
    expect(reloadAction()).toMatchObject({ props: { what: 'reload' }, on: 'reload', label: '⟳' });
  });
});

describe('controls', () => {
  it('lists Apply, reload and the box, each key once', () => {
    for (const state of [
      { opened: true, dirty: true },
      { opened: false, dirty: false },
    ]) {
      const listed = controls(state);
      expect(listed).toEqual([
        applyStyleAction(state.opened, state.dirty),
        reloadAction(),
        styleBox(state.opened),
      ]);
      expect(duplicateKeys(listed)).toEqual([]);
    }
    expect(controls({ opened: true, dirty: true }).map(keyOf)).toEqual([
      'cmd:project.setArtStyle',
      'fx:pane.view#reload',
      'cmd:project.setArtStyle#style',
    ]);
  });
});
