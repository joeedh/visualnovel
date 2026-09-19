import {
  RAW_TIP,
  RELOAD_TIP,
  TEXT_TIP,
  controls,
  discardOffer,
  rawOffer,
  type WikiState,
} from '../wiki.js';
import { reloadOffer, saveOffer, textBox } from '../docbuffer.js';
import { cellAction } from '../assetstrip.js';
import { duplicateKeys, keyOf } from '../anchors.js';

const state = (over: Partial<WikiState> = {}): WikiState => ({
  path : 'wiki/lore.md',
  dirty: true,
  ...over,
});

describe('textBox', () => {
  it('is the same write as Save, supplied by the box, refused only with nothing open', () => {
    expect(textBox('wiki/lore.md', TEXT_TIP)).toEqual({
      ok      : true,
      id      : 'doc.write',
      props   : { path: 'wiki/lore.md' },
      on      : 'text',
      label   : 'The file, as text',
      tooltip : TEXT_TIP,
      supplies: ['text', 'seenHash'],
    });
    expect(textBox('', TEXT_TIP)).toMatchObject({
      ok     : false,
      refusal: { reason: 'No document is open.' },
    });
    expect(reloadOffer(RELOAD_TIP)).toMatchObject({ props: { what: 'reload' }, label: '⟳' });
  });
});

describe('controls', () => {
  it('is Save, reload, Raw, the box and the strip over the buffer, each key once', () => {
    const strip = {
      assets : [{ hash: 'a1b2c3d4', label: 'Aiko', accepted: true }],
      visible: ['wiki' as const],
    };
    for (const s of [state(), state({ dirty: false }), state({ path: '', dirty: false, strip })]) {
      const listed = controls(s);
      expect(listed).toEqual([
        saveOffer(s.path, s.dirty),
        reloadOffer(RELOAD_TIP),
        rawOffer(false, s.path),
        textBox(s.path, TEXT_TIP),
        ...(s.strip ? s.strip.assets.map((a) => cellAction(a, s.strip!.visible)) : []),
      ]);
      expect(duplicateKeys(listed)).toEqual([]);
    }
    expect(controls(state({ strip })).map(keyOf)).toEqual([
      'cmd:doc.write',
      'fx:pane.view#reload',
      'fx:pane.view#raw',
      'cmd:doc.write#text',
      'item:link/asset/a1b2c3d4',
    ]);
  });

  it('labels the Raw switch with the view a press shows, and the box with the view it is', () => {
    expect(rawOffer(false, 'wiki/lore.md')).toMatchObject({
      ok   : true,
      props: { what: 'mode' },
      on   : 'raw',
      label: 'Raw',
    });
    expect(rawOffer(true, 'wiki/lore.md')).toMatchObject({ ok: true, label: 'Rich' });
    expect(rawOffer(false, '')).toMatchObject({
      ok     : false,
      refusal: { reason: 'No document is open.' },
    });
    const listed = controls(state({ raw: true }));
    expect(listed).toContainEqual(rawOffer(true, 'wiki/lore.md'));
    expect(listed).toContainEqual(textBox('wiki/lore.md', RAW_TIP));
    expect(listed).not.toContainEqual(textBox('wiki/lore.md', TEXT_TIP));
  });

  it('offers to discard detached form answers only while there are some', () => {
    expect(controls(state()).map(keyOf)).not.toContain('fx:pane.view#discard');
    const listed = controls(state({ detached: 2 }));
    expect(listed).toContainEqual(discardOffer(2));
    expect(duplicateKeys(listed)).toEqual([]);
    expect(discardOffer(1).tooltip).toContain('the answer a form');
    expect(discardOffer(2).tooltip).toContain('the 2 answers');
  });

  it('offers to discard stale raw source under the same control', () => {
    const listed = controls(state({ raw: true, stale: true }));
    expect(listed).toContainEqual(discardOffer(0, true));
    expect(duplicateKeys(listed)).toEqual([]);
    expect(discardOffer(0, true).tooltip).toContain('the source typed here');
    // Closed answers are the earlier problem, and the one sentence names them
    expect(discardOffer(1, true).tooltip).toContain('the answer a form');
    expect(controls(state({ raw: true })).map(keyOf)).not.toContain('fx:pane.view#discard');
  });
});
