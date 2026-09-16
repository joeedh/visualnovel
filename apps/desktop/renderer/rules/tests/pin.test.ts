import { PINNABLE, controls, pinAction } from '../pin.js';
import { pinSituations } from '../situations/pin.js';
import { duplicateKeys, keyOf } from '../anchors.js';

describe('PINNABLE', () => {
  it('is every editor declaring pins, with the field it holds', () => {
    expect(PINNABLE).toEqual([
      { editor: 'script', field: 'sceneId' },
      { editor: 'page', field: 'shotId' },
      { editor: 'timeline', field: 'sceneId' },
      { editor: 'gengraph', field: 'graphSlug' },
      { editor: 'inspector', field: 'taskHash' },
      { editor: 'wiki', field: 'docPath' },
      { editor: 'asset', field: 'assetHash' },
    ]);
  });
});

describe('pinAction', () => {
  it('pins a following pane and unpins a held one, saying which in the tooltip', () => {
    expect(pinAction('sceneId', false)).toEqual({
      ok     : true,
      id     : 'pane.pin',
      props  : { pinned: true },
      label  : 'pin scene',
      tooltip: 'Keep this pane on this scene while the rest of the app moves on.',
    });
    expect(pinAction('graphSlug', true)).toEqual({
      ok     : true,
      id     : 'pane.pin',
      props  : { pinned: false },
      label  : 'pin generation graph',
      tooltip: 'Pinned to this generation graph. Click to follow the selection again.',
    });
  });
});

describe('controls', () => {
  it('is the one toggle in either situation', () => {
    for (const { field } of PINNABLE) {
      for (const { state } of pinSituations(field)) {
        const listed = controls(field, state);
        expect(listed.map(keyOf)).toEqual(['fx:pane.pin']);
        expect(duplicateKeys(listed)).toEqual([]);
      }
    }
  });
});
