import {
  controls,
  defaultMark,
  entryAdd,
  entryArt,
  entryField,
  entryRemove,
  modelOffer,
  promptEdit,
  SAVE_FIRST,
  swatchAdd,
  swatchOffer,
  swatchRemove,
  type SheetFormState,
} from '../sheetform.js';
import { duplicateKeys, keyOf } from '../anchors.js';

const state = (over: Partial<SheetFormState> = {}): SheetFormState => ({
  path   : 'characters/aiko/character.md',
  palette: { swatches: 2 },
  ...over,
});

describe('the palette offers', () => {
  it("are the box's write, told apart by what they are on", () => {
    expect(swatchOffer(state(), 1)).toEqual({
      ok      : true,
      id      : 'doc.write',
      props   : { path: 'characters/aiko/character.md' },
      on      : 'palette/1',
      label   : 'Swatch 2',
      tooltip : "Pick this swatch's colour; Apply answers writes the palette into the sheet",
      supplies: ['text', 'seenHash'],
    });
    expect(swatchRemove(state(), 0)).toMatchObject({ ok: true, on: 'palette/0/remove' });
    expect(swatchAdd(state())).toMatchObject({ ok: true, on: 'palette/add', label: '+' });
  });

  it('refuse with nothing open and with a session that cannot be written', () => {
    expect(swatchAdd(state({ path: '' }))).toMatchObject({
      ok     : false,
      refusal: { reason: 'No document is open.' },
    });
    expect(swatchOffer(state({ readOnly: true }), 0)).toMatchObject({
      ok     : false,
      refusal: { reason: 'This document cannot be written' },
    });
  });
});

describe('the image-model menu', () => {
  it("is the box's write on `model`, listed after the rest, and refused like the swatches", () => {
    expect(modelOffer(state())).toEqual({
      ok      : true,
      id      : 'doc.write',
      props   : { path: 'characters/aiko/character.md' },
      on      : 'model',
      label   : 'Image model',
      tooltip : expect.stringContaining('inherit draws with the project'),
      supplies: ['text', 'seenHash'],
    });
    expect(modelOffer(state({ readOnly: true }))).toMatchObject({
      refusal: { reason: 'This document cannot be written' },
    });
    expect(controls(state()).map(keyOf)).not.toContain('cmd:doc.write#model');
    const listed = controls(state({ model: true }));
    expect(listed.at(-1)).toEqual(modelOffer(state()));
    expect(duplicateKeys(listed)).toEqual([]);
  });
});

describe('the wardrobe offers', () => {
  it("are the box's write too, keyed by the row's id and what the box edits", () => {
    expect(entryField(state(), 'wardrobe', 'gala', 'seed')).toEqual({
      ok      : true,
      id      : 'doc.write',
      props   : { path: 'characters/aiko/character.md' },
      on      : 'wardrobe/gala/seed',
      label   : 'Seed',
      tooltip:
        "Image seed for every picture of this outfit; empty inherits the sheet's; Apply answers writes the wardrobe into the sheet",
      supplies: ['text', 'seenHash'],
    });
    expect(entryRemove(state(), 'wardrobe', 'gala')).toMatchObject({
      ok: true,
      on: 'wardrobe/gala/remove',
    });
    expect(entryAdd(state(), 'wardrobe')).toMatchObject({
      ok   : true,
      on   : 'wardrobe/add',
      label: 'Add an outfit',
    });
    expect(entryAdd(state(), 'variants')).toMatchObject({
      on   : 'variants/add',
      label: 'Add a variant',
    });
  });

  it('marks the default as already worn and offers to make any other row it', () => {
    expect(defaultMark(state(), 'uniform', true)).toMatchObject({
      ok     : false,
      on     : 'wardrobe/uniform/default',
      label  : 'default',
      refusal: { reason: 'This is already the outfit a scene wears when it names none' },
    });
    expect(defaultMark(state(), 'gala', false)).toMatchObject({
      ok   : true,
      on   : 'wardrobe/gala/default',
      label: 'make default',
    });
    expect(defaultMark(state({ readOnly: true }), 'gala', false)).toMatchObject({
      ok     : false,
      refusal: { reason: 'This document cannot be written' },
    });
  });

  it("draws a row's art as the strip's own cell, keyed apart from the strip", () => {
    const asset = { hash: 'a1b2c3', label: 'gala / side', accepted: false };
    expect(entryArt('wardrobe', 'gala', asset, ['wiki'])).toMatchObject({
      ok   : true,
      on   : 'wardrobe/gala/asset/a1b2c3',
      label: 'gala / side',
    });
  });
});

describe('the prompt button', () => {
  it("selects the portrait and opens it where the route says, as a thumbnail's click does", () => {
    expect(promptEdit(state(), { hash: 'c3d4e5', visible: ['wiki'] })).toEqual({
      ok     : true,
      id     : 'ui.publish',
      props  : { assetHash: 'c3d4e5' },
      on     : 'prompt/edit',
      label  : 'Edit the prompt in the Asset editor',
      tooltip:
        "Open the picture this sheet's prompt draws, where its clauses are edited and written back into the sheet",
      then: [
        { id: 'view.open', props: { editor: 'asset', where: 'elsewhere', subject: 'c3d4e5' } },
      ],
    });
  });

  it('refuses with nothing drawn, with unsaved edits, and with nothing open', () => {
    expect(promptEdit(state(), {})).toMatchObject({
      ok     : false,
      id     : 'view.open',
      refusal: {
        reason: 'Nothing has been drawn for this character yet, so there is no prompt to edit',
      },
    });
    expect(promptEdit(state(), { hash: 'c3d4e5', dirty: true })).toMatchObject({
      ok     : false,
      refusal: { reason: SAVE_FIRST },
    });
    expect(promptEdit(state({ path: '' }), { hash: 'c3d4e5' })).toMatchObject({
      ok     : false,
      refusal: { reason: 'No document is open.' },
    });
  });
});

describe('controls', () => {
  it('lists the prompt button after the rows', () => {
    const listed = controls(state({ palette: undefined, prompt: { hash: 'c3d4e5' } }));
    expect(listed.map(keyOf)).toEqual(['item:prompt/edit']);
  });

  it('lists each row in order, then the button that adds, each key once', () => {
    const listed = controls(
      state({
        palette : undefined,
        wardrobe: {
          ids    : ['uniform', 'gala'],
          default: 'uniform',
          art: [{ id: 'gala', asset: { hash: 'a1b2c3', label: 'gala / side', accepted: false } }],
        },
      }),
    );
    expect(listed.map(keyOf)).toEqual([
      'cmd:doc.write#wardrobe/uniform/id',
      'cmd:doc.write#wardrobe/uniform/default',
      'cmd:doc.write#wardrobe/uniform/description',
      'cmd:doc.write#wardrobe/uniform/notes',
      'cmd:doc.write#wardrobe/uniform/seed',
      'cmd:doc.write#wardrobe/uniform/model',
      'cmd:doc.write#wardrobe/uniform/remove',
      'cmd:doc.write#wardrobe/gala/id',
      'cmd:doc.write#wardrobe/gala/default',
      'cmd:doc.write#wardrobe/gala/description',
      'cmd:doc.write#wardrobe/gala/notes',
      'cmd:doc.write#wardrobe/gala/seed',
      'cmd:doc.write#wardrobe/gala/model',
      'item:wardrobe/gala/asset/a1b2c3',
      'cmd:doc.write#wardrobe/gala/remove',
      'cmd:doc.write#wardrobe/add',
    ]);
    expect(duplicateKeys(listed)).toEqual([]);
    expect(controls(state({ palette: undefined, wardrobe: { ids: [] } })).map(keyOf)).toEqual([
      'cmd:doc.write#wardrobe/add',
    ]);
  });

  it('lists a variant row without the default mark', () => {
    const listed = controls(state({ palette: undefined, variants: { ids: ['night'] } }));
    expect(listed.map(keyOf)).toEqual([
      'cmd:doc.write#variants/night/id',
      'cmd:doc.write#variants/night/description',
      'cmd:doc.write#variants/night/notes',
      'cmd:doc.write#variants/night/seed',
      'cmd:doc.write#variants/night/model',
      'cmd:doc.write#variants/night/remove',
      'cmd:doc.write#variants/add',
    ]);
  });

  it('lists each swatch with its ✕, then the slot that adds, each key once', () => {
    const listed = controls(state());
    expect(listed.map(keyOf)).toEqual([
      'cmd:doc.write#palette/0',
      'cmd:doc.write#palette/0/remove',
      'cmd:doc.write#palette/1',
      'cmd:doc.write#palette/1/remove',
      'cmd:doc.write#palette/add',
    ]);
    expect(duplicateKeys(listed)).toEqual([]);
    expect(controls(state({ palette: { swatches: 0 } })).map(keyOf)).toEqual([
      'cmd:doc.write#palette/add',
    ]);
    expect(controls(state({ palette: undefined }))).toEqual([]);
  });
});
