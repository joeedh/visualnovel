import { cellAction } from '../assetstrip.js';

describe('cellAction', () => {
  const asset = { hash: 'a1b2c3d4', label: 'Aiko — uniform / front', accepted: true };

  it('selects the asset and opens it elsewhere when no asset editor is up', () => {
    expect(cellAction(asset, ['documents'])).toEqual({
      ok     : true,
      id     : 'ui.publish',
      props  : { assetHash: 'a1b2c3d4' },
      on     : 'link/asset/a1b2c3d4',
      label  : 'Aiko — uniform / front',
      tooltip: 'Aiko — uniform / front · accepted — open it in the asset editor',
      then: [
        { id: 'view.open', props: { editor: 'asset', where: 'elsewhere', subject: 'a1b2c3d4' } },
      ],
    });
  });

  it('opens it here when an asset editor is already up, and says so when unaccepted', () => {
    const cell = cellAction({ ...asset, accepted: false }, ['documents', 'asset']);
    expect(cell).toMatchObject({
      tooltip: 'Aiko — uniform / front — open it in the asset editor',
      then   : [{ id: 'view.open', props: { where: 'here' } }],
    });
  });
});
