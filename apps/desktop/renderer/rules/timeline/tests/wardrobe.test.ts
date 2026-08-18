import { INHERIT, outfitInvocation, outfitRows, shadowedMarker, sourceLabel } from '../wardrobe.js';
import type { CoverageCast, CoverageShot, SceneCoverage } from '../../../../src/shared/ipc';

const AIKO: CoverageCast = { id: 'aiko', outfits: ['uniform', 'track'], defaultOutfit: 'uniform' };
const REN: CoverageCast = { id: 'ren', outfits: ['uniform'], defaultOutfit: 'uniform' };

const shot = (outfits: Record<string, string>, subjects = ['aiko', 'ren']): CoverageShot => ({
  id: 'club__beat1',
  framing: 'medium',
  subjects,
  outfits,
  coversLines: ['club:L1'],
  status: 'accepted',
  drift: 'current',
});

const coverage = (cast: CoverageCast[], shots: CoverageShot[]): SceneCoverage => ({
  sceneId: 'club',
  location: 'club_room',
  heading: 'INT. CLUB ROOM - DAY',
  lines: [],
  shots,
  cast,
  decomposed: shots.length > 0,
});

describe('outfitRows', () => {
  it('gives a scene row per cast member, falling back to the sheet', () => {
    const rows = outfitRows(coverage([AIKO, REN], []), null);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      level: 'scene',
      scene: 'club',
      character: 'aiko',
      outfits: ['uniform', 'track'],
      value: INHERIT,
      effective: { id: 'uniform', origin: 'default' },
      inherits: { id: 'uniform', origin: 'default' },
    });
    expect(rows[0]).not.toHaveProperty('shot');
  });

  it('reads a scene marker as the row that is in force', () => {
    const rows = outfitRows(coverage([{ ...AIKO, marked: 'track' }], []), null);
    expect(rows[0]).toMatchObject({
      value: 'track',
      effective: { id: 'track', origin: 'scene' },
      // Clearing the marker goes to the sheet, never to a shot: the shot level is below it.
      inherits: { id: 'uniform', origin: 'default' },
    });
  });

  it('adds a subject row per subject of the selected shot, and only then', () => {
    const data = coverage([AIKO, REN], [shot({})]);
    expect(outfitRows(data, null).map((r) => r.level)).toEqual(['scene', 'scene']);
    // A shot the coverage no longer has leaves the scene rows alone rather than emptying the strip.
    expect(outfitRows(data, 'club__beat9').map((r) => r.level)).toEqual(['scene', 'scene']);
    const rows = outfitRows(data, 'club__beat1');
    expect(rows.map((r) => `${r.level}:${r.character}`)).toEqual([
      'scene:aiko',
      'scene:ren',
      'shot:aiko',
      'shot:ren',
    ]);
    expect(rows[2]).toMatchObject({ shot: 'club__beat1', value: INHERIT });
  });

  // The chain the whole feature is: the subject's own outfit, then the marker, then the sheet.
  it('resolves a subject through every level, and says which one answered', () => {
    const data = coverage([{ ...AIKO, marked: 'track' }, REN], [shot({ ren: 'uniform' })]);
    const rows = outfitRows(data, 'club__beat1');
    const aiko = rows.find((r) => r.level === 'shot' && r.character === 'aiko')!;
    const ren = rows.find((r) => r.level === 'shot' && r.character === 'ren')!;
    expect(aiko).toMatchObject({
      value: INHERIT,
      effective: { id: 'track', origin: 'scene' },
      inherits: { id: 'track', origin: 'scene' },
    });
    expect(ren).toMatchObject({
      value: 'uniform',
      effective: { id: 'uniform', origin: 'shot' },
      inherits: { id: 'uniform', origin: 'default' },
    });
  });

  it('skips a subject with no sheet, because there is no wardrobe to offer', () => {
    const data = coverage([AIKO], [shot({}, ['aiko', 'ghost'])]);
    expect(outfitRows(data, 'club__beat1').map((r) => `${r.level}:${r.character}`)).toEqual([
      'scene:aiko',
      'shot:aiko',
    ]);
  });

  it('has no rows at all before the coverage has loaded', () => {
    expect(outfitRows(null, 'club__beat1')).toEqual([]);
  });
});

describe('shadowedMarker', () => {
  it('names the marker a shot override is hiding, and nothing otherwise', () => {
    const data = coverage(
      [{ ...AIKO, marked: 'track' }, REN],
      [shot({ aiko: 'uniform', ren: 'uniform' })],
    );
    const rows = outfitRows(data, 'club__beat1');
    const shots = rows.filter((r) => r.level === 'shot');
    // aiko's override hides the scene's "track"; ren's hides nothing — there is no marker for them.
    expect(shadowedMarker(shots[0]!)).toBe('track');
    expect(shadowedMarker(shots[1]!)).toBeNull();
    // A scene row is never shadowing, and neither is a shot row that says nothing.
    expect(shadowedMarker(rows[0]!)).toBeNull();
    expect(shadowedMarker({ ...shots[0]!, value: INHERIT })).toBeNull();
  });
});

describe('outfitInvocation', () => {
  it('sends each level to its own command', () => {
    const rows = outfitRows(coverage([AIKO], [shot({}, ['aiko'])]), 'club__beat1');
    expect(outfitInvocation(rows[0]!, 'track')).toEqual({
      id: 'story.setSceneOutfit',
      props: { scene: 'club', character: 'aiko', outfit: 'track' },
    });
    expect(outfitInvocation(rows[1]!, INHERIT)).toEqual({
      id: 'story.setOutfit',
      props: { scene: 'club', shot: 'club__beat1', character: 'aiko', outfit: '' },
    });
  });
});

describe('sourceLabel', () => {
  it('names the level that answered, not the fact of inheriting', () => {
    expect(sourceLabel({ id: 'track', origin: 'shot' })).toBe('"track" (this shot)');
    expect(sourceLabel({ id: 'track', origin: 'scene' })).toBe('"track" (scene marker)');
    expect(sourceLabel({ id: 'uniform', origin: 'default' })).toBe('"uniform" (character sheet)');
  });
});
