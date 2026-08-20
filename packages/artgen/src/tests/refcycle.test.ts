/**
 * The reference-graph cycle check (`docs/plans/archive/chunked-prompts.md` §14). The cycle is over logical
 * slots rather than hashes, so the interesting cases are the ones where no hash repeats.
 */
import type { Asset, Location, ProjectModel, RefBinding, Shot } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import {
  cycleRefusal,
  firstCycle,
  parseSlot,
  refCycle,
  refsOfSlot,
  slotKey,
  slotLabel,
  slotOf,
} from '../index.js';

const plate = (variant: string): RefBinding => ({ kind: 'plate', locationId: 'cafe', variant });

/** A café whose variants can be wired to reference each other, giving a small cheap graph. */
function cafe(links: Record<string, RefBinding[]>): Location {
  const l = location('cafe');
  l.variants = ['dawn', 'day', 'night', 'dusk', 'noon'].map((id) => ({
    id,
    description: '',
    ...(links[id]
      ? {
          promptOverride: {
            mode: 'chunks' as const,
            refs: { variant: links[id]!.map((from) => ({ pin: `pin-${id}`, ext: 'png', from })) },
          },
        }
      : {}),
  }));
  return l;
}

function ctxOf(loc: Location, shots?: Shot[]): { model: ProjectModel; shots: Map<string, Shot[]> } {
  const aiko = character('aiko', 'approved', 'portrait-hash');
  aiko.outfits = [
    { id: 'default', characterId: 'aiko', description: 'uniform' },
    { id: 'gala', characterId: 'aiko', description: 'a long green dress' },
  ];
  const s = scene('arrival', ['aiko'], 'cafe');
  return {
    model: model([aiko], [s], [loc]),
    shots: new Map([['arrival', shots ?? []]]),
  };
}

describe('refsOfSlot', () => {
  it('derives a sheet from its portrait and a frame from its plate and cast', () => {
    const shot: Shot = {
      id: 'arrival__a',
      sceneId: 'arrival',
      framing: 'medium',
      location: 'night',
      subjects: [{ characterId: 'aiko', outfit: 'gala' }],
      coversLines: [],
      status: 'pending',
    };
    const ctx = ctxOf(cafe({}), [shot]);
    expect(
      refsOfSlot({ kind: 'sheet', characterId: 'aiko', outfit: 'gala', angle: 'front' }, ctx),
    ).toEqual([{ kind: 'portrait', characterId: 'aiko' }]);
    expect(refsOfSlot({ kind: 'shot', sceneId: 'arrival', shotId: 'arrival__a' }, ctx)).toEqual([
      plate('night'),
      { kind: 'portrait', characterId: 'aiko' },
      { kind: 'sheet', characterId: 'aiko', outfit: 'gala', angle: 'front' },
    ]);
  });

  it('gives a muted chunk no references at all', () => {
    const loc = cafe({ dawn: [plate('day')] });
    const dawn = loc.variants.find((v) => v.id === 'dawn')!;
    expect(refsOfSlot(plate('dawn'), ctxOf(loc))).toEqual([plate('day')]);
    dawn.promptOverride = { ...dawn.promptOverride!, mute: ['variant'] };
    expect(refsOfSlot(plate('dawn'), ctxOf(loc))).toEqual([]);
  });
});

describe('refCycle', () => {
  it('catches the direct case, and names the path the way the plan says', () => {
    // A portrait referencing its own gala sheet. No hash repeats, but the sheet is drawn from the
    // portrait, so the planner would starve waiting on an output that can never exist.
    const path = refCycle(
      { kind: 'portrait', characterId: 'aiko' },
      { kind: 'sheet', characterId: 'aiko', outfit: 'gala', angle: 'front' },
      ctxOf(cafe({})),
    );
    expect(path?.map(slotLabel)).toEqual([
      'aiko portrait',
      'aiko/gala front sheet',
      'aiko portrait',
    ]);
    expect(cycleRefusal(path!)).toBe(
      'that reference would close a loop: aiko portrait → aiko/gala front sheet → aiko portrait',
    );
  });

  it('catches a loop that only closes three hops later', () => {
    const ctx = ctxOf(cafe({ day: [plate('dawn')], night: [plate('day')] }));
    expect(refCycle(plate('dawn'), plate('night'), ctx)?.map(slotLabel)).toEqual([
      'cafe — dawn plate',
      'cafe — night plate',
      'cafe — day plate',
      'cafe — dawn plate',
    ]);
  });

  it('lets a diamond through — a shared upstream is not a loop', () => {
    // dawn → {day, night} → dusk. Reaching dusk twice by two routes must not read as a cycle.
    const ctx = ctxOf(
      cafe({ dawn: [plate('day'), plate('night')], day: [plate('dusk')], night: [plate('dusk')] }),
    );
    expect(refCycle(plate('noon'), plate('dawn'), ctx)).toBeUndefined();
  });

  it('catches a slot pointed straight at itself', () => {
    expect(refCycle(plate('day'), plate('day'), ctxOf(cafe({})))?.map(slotLabel)).toEqual([
      'cafe — day plate',
      'cafe — day plate',
    ]);
  });

  it('finds a loop already on disk, and says nothing about a project without one', () => {
    expect(firstCycle(ctxOf(cafe({ dawn: [plate('day')] })))).toBeUndefined();
    // A hand-edited project the write-time check never saw: two plates pointing at each other.
    const path = firstCycle(ctxOf(cafe({ dawn: [plate('day')], day: [plate('dawn')] })));
    expect(path && cycleRefusal(path)).toContain('cafe — dawn plate → cafe — day plate');
  });

  it('lets an upload through — it is a leaf with nothing under it', () => {
    expect(
      refCycle(plate('day'), { kind: 'asset', hash: 'uploaded' }, ctxOf(cafe({}))),
    ).toBeUndefined();
  });
});

describe('parseSlot', () => {
  const SLOTS: RefBinding[] = [
    { kind: 'portrait', characterId: 'aiko' },
    { kind: 'sheet', characterId: 'aiko', outfit: 'gala', angle: 'front' },
    { kind: 'plate', locationId: 'cafe', variant: 'night' },
    { kind: 'shot', sceneId: 's1', shotId: 'sh2' },
    { kind: 'asset', hash: 'deadbeefcafe1234' },
  ];

  // The address an author types is the same string the walk keys on, so the round trip has to hold.
  it('round-trips every slot through slotKey', () => {
    for (const slot of SLOTS) expect(parseSlot(slotKey(slot))).toEqual(slot);
  });

  it('reads a bare hash as an asset, which names no slot and can never drift', () => {
    expect(parseSlot('DEADBEEF')).toEqual({ kind: 'asset', hash: 'deadbeef' });
  });

  it('says nothing rather than guessing at an address it cannot read', () => {
    for (const bad of ['', 'aiko', 'portrait:', 'sheet:aiko/gala', 'plate:cafe', 'wat:a/b'])
      expect(parseSlot(bad)).toBeUndefined();
  });
});

describe('slotOf', () => {
  const asset = (kind: Asset['kind'], satisfies: Asset['satisfies']): Asset => ({
    hash: 'h',
    ext: 'png',
    kind,
    sourceTask: 't',
    refs: [],
    satisfies,
    accepted: false,
    modelId: 'm',
  });

  it('answers the slot an asset fills', () => {
    expect(slotOf(asset('location_ref', [{ locationId: 'cafe', variant: 'night' }]))).toEqual({
      kind: 'plate',
      locationId: 'cafe',
      variant: 'night',
    });
    expect(slotOf(asset('model_sheet', [{ characterId: 'aiko', outfit: 'gala' }]), 'side')).toEqual(
      {
        kind: 'sheet',
        characterId: 'aiko',
        outfit: 'gala',
        angle: 'side',
      },
    );
  });

  // Nothing plans a concept, so nothing can reference it by anything but its hash.
  it('gives a concept no slot', () => {
    expect(slotOf(asset('concept', [{ locationId: 'cafe' }]))).toBeUndefined();
  });
});
