import { applyStyleAction, controls } from '../projectbar.js';
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

describe('controls', () => {
  it('lists the one control the pane draws, each key once', () => {
    for (const state of [
      { opened: true, dirty: true },
      { opened: false, dirty: false },
    ]) {
      const listed = controls(state);
      const each = [applyStyleAction(state.opened, state.dirty)];
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});
