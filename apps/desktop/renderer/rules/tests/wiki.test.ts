import { controls, type WikiState } from '../wiki.js';
import { saveOffer } from '../docbuffer.js';
import { duplicateKeys, keyOf } from '../anchors.js';

const state = (over: Partial<WikiState> = {}): WikiState => ({
  path : 'wiki/lore.md',
  dirty: true,
  ...over,
});

describe('controls', () => {
  it('is the save offer over the buffer, each key once', () => {
    for (const s of [state(), state({ dirty: false }), state({ path: '', dirty: false })]) {
      const listed = controls(s);
      expect(listed).toEqual([saveOffer(s.path, s.dirty)]);
      expect(new Set(listed.map(keyOf))).toEqual(new Set(['cmd:doc.write']));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});
