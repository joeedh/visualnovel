/**
 * The stills family under the solver: which slots a project implies, and what approval means for
 * each kind. Agreement with what the planner plans is `slotplan.test.ts` and `plannerwaves.test.ts`,
 * in `@vn/pipeline`, which can move a project through the planner's waves.
 */
import { pins } from '@vn/contracts';
import { solve } from '@vn/constraint-solver';
import { projectConfig, type Asset, type AssetKind, type ProjectModel } from '@vn/types';
import { character, liveOnly, location, model, scene } from '@vn/testkit';
import {
  planningSheetsOnlyWhenWorn,
  stillsFamily,
  takesApprovedMeansAccepted,
  type StillsFacts,
} from '../index.js';

const config = projectConfig.parse({
  title    : 'Test',
  art_style: 'watercolor',
  models   : { vision: ['gemini', 'claude'] },
});

const facts = (m: ProjectModel, assets: readonly Asset[] = []): StillsFacts => ({
  model: m,
  config,
  assets,
  tasks: { get: () => undefined },
});

const keys = (m: ProjectModel, prefix: string): string[] =>
  [...solve(stillsFamily, facts(m)).slots.keys()].filter((k) => k.startsWith(`${prefix}:`)).sort();

function row(hash: string, kind: AssetKind, satisfies: Asset['satisfies'], over: Partial<Asset>) {
  return {
    hash,
    ext: 'png',
    kind,
    sourceTask: `task-${hash}`,
    refs      : [],
    modelId   : 'm',
    accepted  : false,
    satisfies,
    ...over,
  } satisfies Asset;
}

describe(pins(planningSheetsOnlyWhenWorn), () => {
  /** Aiko is cast in the one live scene; Ren is authored and cast nowhere, though approved. */
  function project(): ProjectModel {
    const aiko = character('aiko');
    aiko.outfits.push({ id: 'gala', characterId: 'aiko', description: 'a gala dress' });
    const ren = character('ren', 'approved', 'p-ren');
    ren.outfits.push({ id: 'coat', characterId: 'ren', description: 'a long coat' });
    const roof = location('roof');
    roof.variants = [];
    const cafe = location('cafe');
    cafe.variants.push({ id: 'night', description: 'lamps on' });
    return model([aiko, ren], [scene('arrival', ['aiko'], 'cafe')], [cafe, roof]);
  }

  it('gives every authored character a portrait and every location variant a plate, cast or not', () => {
    const m = project();
    expect(keys(m, 'portrait')).toEqual(['portrait:aiko', 'portrait:ren']);
    // A location that declares no variants gets `day`
    expect(keys(m, 'plate')).toEqual(['plate:cafe/day', 'plate:cafe/night', 'plate:roof/day']);
  });

  it('gives sheets only to outfits a live scene puts someone in', () => {
    // Aiko's default because the scene casts her; not her gala dress, and nothing of Ren's
    expect(keys(project(), 'sheet')).toEqual([
      'sheet:aiko/default/back',
      'sheet:aiko/default/front',
      'sheet:aiko/default/side',
    ]);
  });

  it('adds an outfit a marker or a shot asks for, and none from a scene outside the story', () => {
    const m = project();
    m.scenes.set('ball', { ...scene('ball', ['aiko'], 'cafe'), outfits: { aiko: 'gala' } });
    m.scenes.set('cut', { ...scene('cut', ['aiko'], 'cafe'), outfits: { aiko: 'swim' } });
    m.production.set('arrival', {
      shots: [
        {
          id         : 'arrival__1',
          sceneId    : 'arrival',
          framing    : 'medium',
          location   : 'day',
          subjects   : [{ characterId: 'ren', outfit: 'coat' }],
          coversLines: [],
        },
      ],
    });
    m.narrative = liveOnly(['arrival', 'ball'], ['cut']);
    // The swimsuit is asked for only by the scene outside the story
    expect(keys(m, 'sheet').filter((k) => !k.includes('/default/'))).toEqual([
      'sheet:aiko/gala/back',
      'sheet:aiko/gala/front',
      'sheet:aiko/gala/side',
      'sheet:ren/coat/back',
      'sheet:ren/coat/front',
      'sheet:ren/coat/side',
    ]);
  });

  it('lists a live scene’s shots in that scene’s unit, and no shots for a scene outside the story', () => {
    const m = project();
    const shot = (sceneId: string) => ({
      id: `${sceneId}__1`,
      sceneId,
      framing    : 'medium' as const,
      location   : 'day',
      subjects   : [],
      coversLines: [],
    });
    m.scenes.set('cut', scene('cut', [], 'cafe'));
    m.production.set('arrival', { shots: [shot('arrival')] });
    m.production.set('cut', { shots: [shot('cut')] });
    m.narrative = liveOnly(['arrival'], ['cut']);
    const solved = solve(stillsFamily, facts(m));
    expect(keys(m, 'shot')).toEqual(['shot:arrival/arrival__1']);
    expect(solved.slots.get('shot:arrival/arrival__1')!.unit).toBe('arrival');
  });
});

describe(pins(takesApprovedMeansAccepted), () => {
  const m = (): ProjectModel =>
    model(
      [character('aiko', 'approved', 'p1')],
      [scene('arrival', ['aiko'], 'cafe')],
      [location('cafe')],
    );
  const approved = (assets: Asset[], key: string): boolean =>
    solve(stillsFamily, facts(m(), assets)).slots.get(key)!.approved;

  it('approves a slot whose held take was accepted, the same way for every kind', () => {
    const portrait = (over: Partial<Asset>) =>
      row('p1', 'portrait', [{ characterId: 'aiko' }], over);
    const plate = (over: Partial<Asset>) =>
      row('l1', 'location_ref', [{ locationId: 'cafe', variant: 'day' }], over);
    for (const [make, key] of [
      [portrait, 'portrait:aiko'],
      [plate, 'plate:cafe/day'],
    ] as const) {
      expect(approved([make({ current: true, accepted: true })], key)).toBe(true);
      expect(approved([make({ current: true })], key)).toBe(false);
      // The only row is the slot's take even when it is not current
      expect(approved([make({ accepted: true })], key)).toBe(true);
    }
  });

  it('does not approve a slot holding an unaccepted take beside an accepted older one', () => {
    const assets = [
      row('p0', 'portrait', [{ characterId: 'aiko' }], { accepted: true }),
      row('p1', 'portrait', [{ characterId: 'aiko' }], { current: true }),
    ];
    expect(approved(assets, 'portrait:aiko')).toBe(false);
  });

  it('approves nothing when the slot cannot say which take it holds', () => {
    const assets = [
      row('p0', 'portrait', [{ characterId: 'aiko' }], { accepted: true }),
      row('p1', 'portrait', [{ characterId: 'aiko' }], { accepted: true }),
    ];
    expect(approved(assets, 'portrait:aiko')).toBe(false);
  });
});
