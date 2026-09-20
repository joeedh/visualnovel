import {
  controls,
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

describe('controls', () => {
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
