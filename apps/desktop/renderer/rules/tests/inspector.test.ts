import { controls, reloadAction } from '../inspector.js';
import { duplicateKeys, keyOf } from '../anchors.js';

describe('controls', () => {
  it('is Refresh alone, with or without a task', () => {
    expect(reloadAction()).toEqual({
      ok     : true,
      id     : 'pane.view',
      props  : { what: 'reload' },
      on     : 'reload',
      label  : 'Refresh',
      tooltip: 'Re-read this task, its attempts and its prompt from disk',
    });
    for (const shown of [false, true]) {
      const listed = controls({ shown });
      expect(listed.map(keyOf)).toEqual(['fx:pane.view#reload']);
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});
