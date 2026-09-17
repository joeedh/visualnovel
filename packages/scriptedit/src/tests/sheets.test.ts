import { setSheet, setSheetGroup } from '../sheets.js';

const shot = (id: string, sheet?: string): { id: string; sheet?: string } =>
  sheet === undefined ? { id } : { id, sheet };

describe('setSheet', () => {
  it('puts a shot in a group, counting the cells, and takes it out again', () => {
    const shots = [shot('s1', 'g'), shot('s2'), shot('s3')];
    const joined = setSheet(shots, { g: { seed: 3 } }, { shot: 's2', sheet: 'g' });
    expect(joined.ok && joined.shots.map((s) => s.sheet)).toEqual(['g', 'g', undefined]);
    expect(joined.ok && joined.message).toBe('Shot "s2" joins sheet group "g" (2 of 8 cells).');
    expect(joined.ok && joined.sheets).toEqual({ g: { seed: 3 } });

    const left = setSheet(shots, { g: { seed: 3 } }, { shot: 's1', sheet: '' });
    expect(left.ok && left.shots.map((s) => s.sheet)).toEqual([undefined, undefined, undefined]);
    expect(left.ok && left.message).toBe('Shot "s1" leaves sheet group "g".');
    // The group's settings go with its last member
    expect(left.ok && left.sheets).toEqual({});
  });

  it('refuses a missing shot, a bad id, a full group, and names a no-op', () => {
    const full = Array.from({ length: 8 }, (_, i) => shot(`m${i}`, 'g'));
    expect(setSheet([shot('s1')], undefined, { shot: 'zz', sheet: 'g' })).toEqual({
      ok   : false,
      error: 'No shot "zz" in this scene.',
    });
    expect(setSheet([shot('s1')], undefined, { shot: 's1', sheet: 'a b' }).ok).toBe(false);
    expect(setSheet([...full, shot('s1')], undefined, { shot: 's1', sheet: 'g' })).toEqual({
      ok   : false,
      error:
        'Sheet group "g" already has 8 shots, which is as many cells as a sheet carries; start another group.',
    });
    expect(setSheet([shot('s1', 'g')], undefined, { shot: 's1', sheet: 'g' })).toEqual({
      ok   : false,
      error: 'Shot "s1" is already in sheet group "g".',
      noop : true,
    });
  });
});

describe('setSheetGroup', () => {
  it('writes the seed and notes, clears them when absent, and refuses an empty group', () => {
    const shots = [shot('s1', 'g')];
    const set = setSheetGroup(shots, undefined, { sheet: 'g', seed: 7, notes: ' same room ' });
    expect(set.ok && set.sheets).toEqual({ g: { seed: 7, notes: 'same room' } });
    expect(set.ok && set.message).toBe('Sheet group "g": seed 7 and notes.');

    const cleared = setSheetGroup(shots, { g: { seed: 7 } }, { sheet: 'g' });
    expect(cleared.ok && cleared.sheets).toEqual({ g: {} });

    expect(setSheetGroup(shots, undefined, { sheet: 'h', seed: 1 }).ok).toBe(false);
    expect(setSheetGroup(shots, undefined, { sheet: 'g', seed: -1 }).ok).toBe(false);
    expect(setSheetGroup(shots, { g: { seed: 7 } }, { sheet: 'g', seed: 7 })).toMatchObject({
      ok  : false,
      noop: true,
    });
  });
});
