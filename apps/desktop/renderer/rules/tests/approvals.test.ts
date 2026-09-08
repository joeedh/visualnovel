import { controls, rowAction } from '../approvals.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import type { Approvable } from '@vn/authoring';

const plate: Approvable = {
  hash : 'a1b2c3d4',
  kind : 'plate',
  label: 'Café Mori — night',
  slot : 'plate:cafe/night',
  door : 'accept',
};

describe('rowAction', () => {
  it('closes the popup, then opens the picture in the Asset editor elsewhere', () => {
    expect(rowAction(plate)).toEqual({
      ok     : true,
      id     : 'popup.close',
      props  : { popup: 'approvals' },
      on     : 'a1b2c3d4',
      label  : '[plate] Café Mori — night — plate:cafe/night',
      tooltip: 'Open Café Mori — night in the Asset editor.',
      then: [
        {
          id   : 'view.open',
          props: { editor: 'asset', where: 'elsewhere', subject: 'a1b2c3d4' },
        },
      ],
    });
  });

  it('says why a blocked row cannot be approved yet, and still opens it', () => {
    const blocked = rowAction({ ...plate, blocked: 'The concept is not approved.' });
    expect(blocked.tooltip).toBe(
      'The concept is not approved. Opens Café Mori — night in the Asset editor all the same.',
    );
    expect(blocked).toMatchObject({ ok: true, then: [{ id: 'view.open' }] });
  });

  it('keys each row by its hash', () => {
    expect(keyOf(rowAction(plate))).toBe('fx:popup.close#a1b2c3d4');
  });
});

describe('controls', () => {
  it('lists one row per picture, each key once', () => {
    const items = [plate, { ...plate, hash: 'ffff', label: 'Aiko' }];
    const listed = controls({ items });
    expect(listed.map(keyOf)).toEqual(['fx:popup.close#a1b2c3d4', 'fx:popup.close#ffff']);
    expect(duplicateKeys(listed)).toEqual([]);
    expect(controls({ items: [] })).toEqual([]);
  });
});
