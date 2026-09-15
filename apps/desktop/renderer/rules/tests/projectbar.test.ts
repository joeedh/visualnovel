import {
  applyStyleAction,
  controls,
  imageModelAction,
  imageModelRows,
  reloadAction,
  styleBox,
} from '../projectbar.js';
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

describe('imageModelAction', () => {
  it('names the model in use, and the rows supply the id', () => {
    expect(imageModelAction(true, 'openai/gpt-image-2')).toMatchObject({
      ok      : true,
      id      : 'project.setImageModel',
      props   : {},
      label   : 'openai/gpt-image-2',
      supplies: ['model'],
    });
    expect(imageModelAction(true, '').label).toBe('model…');
    expect(imageModelAction(false, 'x')).toMatchObject({
      ok     : false,
      refusal: { reason: 'No project is open.' },
    });
  });
});

describe('imageModelRows', () => {
  it('lists the shipped Gemini ids and says how each row draws', () => {
    const rows = imageModelRows('gemini-2.5-flash-image');
    expect(rows.map((row) => row.id)).toEqual(['gemini-2.5-flash-image']);
    expect(rows[0]?.tooltip).toContain('through Gemini');
  });

  it('adds the current value as a row when the list lacks it, saying OpenRouter routes it', () => {
    const rows = imageModelRows('openai/gpt-image-2');
    expect(rows.map((row) => row.id)).toEqual(['gemini-2.5-flash-image', 'openai/gpt-image-2']);
    expect(rows[1]?.tooltip).toContain('routed by OpenRouter; not zero-data-retention');
  });
});

describe('controls', () => {
  it('lists Apply, reload, the box and the picker, each key once', () => {
    for (const state of [
      { opened: true, dirty: true, imageModel: 'gemini-2.5-flash-image' },
      { opened: false, dirty: false, imageModel: '' },
    ]) {
      const listed = controls(state);
      expect(listed).toEqual([
        applyStyleAction(state.opened, state.dirty),
        reloadAction(),
        styleBox(state.opened),
        imageModelAction(state.opened, state.imageModel),
      ]);
      expect(duplicateKeys(listed)).toEqual([]);
    }
    expect(
      controls({ opened: true, dirty: true, imageModel: 'gemini-2.5-flash-image' }).map(keyOf),
    ).toEqual([
      'cmd:project.setArtStyle',
      'fx:pane.view#reload',
      'cmd:project.setArtStyle#style',
      'cmd:project.setImageModel',
    ]);
  });
});
