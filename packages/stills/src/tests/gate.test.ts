/**
 * The portrait gate reads the manifest row: a character is approved when the take their portrait
 * slot holds is one a person accepted. The character sheet mirrors that row, and is read only
 * where there is no manifest in hand or the sheet says `locked`. `@vn/artgen`'s `mirror.test.ts`
 * covers the mirror itself.
 */
import type { Asset, Character } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import { approvedPortraitOf, gateStatus, isApproved } from '../index.js';

function portrait(hash: string, over: Partial<Asset> = {}): Asset {
  return {
    hash,
    ext       : 'png',
    kind      : 'portrait',
    sourceTask: `task-${hash}`,
    refs      : [],
    modelId   : 'm',
    accepted  : false,
    satisfies : [{ characterId: 'aiko' }],
    ...over,
  };
}

describe('approvedPortraitOf', () => {
  const aiko: Character = character('aiko', 'approved', 'p1');

  it('answers the current row a person accepted, and not an accepted row the slot moved past', () => {
    expect(approvedPortraitOf(aiko, [portrait('p1', { current: true, accepted: true })])).toBe(
      'p1',
    );
    // A re-render held `p2`; `p1` keeps its accepted bit as history and no longer clears the gate
    const redrawn = [
      portrait('p1', { current: false, accepted: true }),
      portrait('p2', { current: true }),
    ];
    expect(approvedPortraitOf(aiko, redrawn)).toBeUndefined();
    expect(isApproved(aiko, redrawn)).toBe(false);
    // Restoring `p1` reopens it
    expect(
      approvedPortraitOf(aiko, [
        portrait('p1', { current: true, accepted: true }),
        portrait('p2', { current: false }),
      ]),
    ).toBe('p1');
  });

  it('reads the sheet only without a manifest, and always when the sheet says locked', () => {
    expect(approvedPortraitOf(aiko)).toBe('p1');
    expect(approvedPortraitOf(character('aiko', 'candidates', 'p1'))).toBeUndefined();
    const locked = character('aiko', 'locked', 'p1');
    expect(approvedPortraitOf(locked, [])).toBe('p1');
    expect(approvedPortraitOf(locked, [portrait('p2', { current: true })])).toBe('p1');
  });

  it('feeds gateStatus, so the sheet alone clears nobody once there is a manifest', () => {
    const m = model([aiko], [scene('arrival', ['aiko'], 'cafe')], [location('cafe')]);
    expect(gateStatus(m).cleared).toBe(true);
    expect(gateStatus(m, [portrait('p1', { current: true })])).toMatchObject({
      cleared: false,
      pending: ['aiko'],
    });
    expect(gateStatus(m, [portrait('p1', { current: true, accepted: true })]).cleared).toBe(true);
  });
});
