import {
  controls,
  defaultMark,
  entryAdd,
  entryArt,
  entryField,
  entryRemove,
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

describe('controls', () => {
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
