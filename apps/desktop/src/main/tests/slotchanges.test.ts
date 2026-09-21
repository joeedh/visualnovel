import { heldTakes, slotChanges } from '../session/history.js';

const row = (hash: string, slot: object, over: object = {}) => ({
  hash,
  ext       : 'png',
  kind      : 'location_ref',
  sourceTask: 't',
  refs      : [],
  modelId   : 'm',
  satisfies : [slot],
  accepted  : true,
  ...over,
});

const manifest = (assets: object[]): Buffer => Buffer.from(JSON.stringify({ version: 1, assets }));

const CAFE = { locationId: 'cafe', variant: 'night' };
const ROOF = { locationId: 'rooftop', variant: 'day' };

describe('heldTakes', () => {
  it('reads the current row per slot, and the accepted row where no row was ever held', () => {
    const held = manifest([
      row('a1', CAFE, { current: true }),
      row('a2', CAFE, { current: false }),
      row('b1', ROOF, { current: false, accepted: true }),
    ]);
    expect([...heldTakes(held).entries()]).toEqual([
      ['plate:cafe/night', { label: 'cafe — night plate', hash: 'a1' }],
    ]);

    const older = manifest([row('a1', CAFE), row('b1', ROOF, { accepted: false })]);
    expect([...heldTakes(older).keys()]).toEqual(['plate:cafe/night']);
  });

  it('holds nothing for a missing or unreadable manifest', () => {
    expect(heldTakes(null).size).toBe(0);
    expect(heldTakes(Buffer.from('{not json')).size).toBe(0);
    expect(heldTakes(Buffer.from('{"assets": 3}')).size).toBe(0);
  });
});

describe('slotChanges', () => {
  it('lists only the slots whose picture moved, with both sides', () => {
    const before = manifest([
      row('a1', CAFE, { current: true }),
      row('b1', ROOF, { current: true }),
    ]);
    const after = manifest([
      row('a1', CAFE, { current: false }),
      row('a2', CAFE, { current: true }),
      row('b1', ROOF, { current: true }),
      row('c1', { sceneId: 'rooftop', shotId: 's1' }, { kind: 'shot_image', current: true }),
    ]);
    expect(slotChanges(before, after)).toEqual([
      { slot: 'cafe — night plate', before: 'a1', after: 'a2' },
      { slot: 'rooftop/s1 frame', before: null, after: 'c1' },
    ]);
    expect(slotChanges(after, after)).toEqual([]);
  });

  it('reads a first manifest as filling every slot it holds', () => {
    expect(slotChanges(null, manifest([row('a1', CAFE, { current: true })]))).toEqual([
      { slot: 'cafe — night plate', before: null, after: 'a1' },
    ]);
  });
});
