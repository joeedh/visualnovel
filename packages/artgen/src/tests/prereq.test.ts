/**
 * The approval frontier for one asset.
 *
 * The rule's whole risk is the three arms that answer "approved" for something nobody ever
 * approved — a portrait, an upload, a concept — so most of this is about those: get one of them
 * wrong and Approve becomes permanently unreachable for everything drawn from one.
 */
import type { Asset, AssetKind, ProjectModel, Shot } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import { assetPrereqs, prereqRefusal, type PrereqContext } from '../index.js';

function asset(
  hash: string,
  kind: AssetKind,
  satisfies: Asset['satisfies'],
  over: Partial<Asset> = {},
): Asset {
  return {
    hash,
    ext: 'png',
    kind,
    sourceTask: `task-${hash}`,
    refs: [],
    modelId: 'm',
    accepted: false,
    satisfies,
    ...over,
  };
}

const PLATE = asset('plate1', 'location_ref', [{ locationId: 'cafe', variant: 'night' }]);
const PORTRAIT = asset('p-aiko', 'portrait', [{ characterId: 'aiko' }]);
const FRAME = asset('frame', 'shot_image', [{ sceneId: 'arrival', shotId: 'arrival__a' }], {
  refs: ['plate1', 'p-aiko'],
});

/** Aiko approved with `p-aiko`, and a frame drawn from the night plate and that portrait. */
function ctx(assets: Asset[], m?: ProjectModel): PrereqContext {
  return {
    model:
      m ??
      model(
        [character('aiko', 'approved', 'p-aiko')],
        [scene('arrival', ['aiko'], 'cafe')],
        [location('cafe')],
      ),
    assets,
    shots: new Map(),
    angleOf: () => undefined,
  };
}

describe('assetPrereqs', () => {
  it('lists what the task fed the model, in that order, with the slot each fills', () => {
    const rows = assetPrereqs(FRAME, ctx([PLATE, PORTRAIT, FRAME]));
    expect(rows.map((p) => p.hash)).toEqual(['plate1', 'p-aiko']);
    expect(rows[0]!.slot).toBe('plate:cafe/night');
    expect(rows[0]!.label).toBe('cafe — night plate');
    expect(rows[0]!.approved).toBe(false);
    // The gate approved this portrait, so it is not what is holding the frame up.
    expect(rows[1]!.approved).toBe(true);
  });

  it('answers a portrait from the gate, not from `accepted`', () => {
    // `p-aiko` is unaccepted in the manifest and approved in the model. The model wins: the gate is
    // what "approved" means for a portrait, and reading `accepted` here would deadlock every frame.
    const rows = assetPrereqs(FRAME, ctx([PLATE, PORTRAIT, FRAME]));
    expect(rows[1]!.note).toBe('Approved at the character gate.');

    const draft = model(
      [character('aiko', 'draft')],
      [scene('arrival', ['aiko'], 'cafe')],
      [location('cafe')],
    );
    const pending = assetPrereqs(FRAME, ctx([PLATE, PORTRAIT, FRAME], draft));
    expect(pending[1]!.approved).toBe(false);
    expect(pending[1]!.note).toContain('has not cleared the character gate');
  });

  it('refuses to let a draft portrait beside the approved one count', () => {
    // Aiko is approved *with* `p-aiko`; these are different bytes for the same character.
    const other = asset('p-aiko-2', 'portrait', [{ characterId: 'aiko' }], { accepted: true });
    const frame = { ...FRAME, refs: ['p-aiko-2'] };
    const rows = assetPrereqs(frame, ctx([other, frame]));
    expect(rows[0]!.approved).toBe(false);
  });

  it('never blocks on an upload, a concept, or bytes the manifest has never heard of', () => {
    const upload = asset('up1', 'reference', [{ characterId: 'aiko' }]);
    const sketch = asset('c1', 'concept', []);
    const frame = { ...FRAME, refs: ['up1', 'c1', 'gone'] };
    const rows = assetPrereqs(frame, ctx([upload, sketch, frame]));
    expect(rows.map((p) => p.approved)).toEqual([true, true, true]);
    expect(rows[2]!.missing).toBe(true);
    expect(rows[2]!.label).toBe('asset gone');
    expect(prereqRefusal('this frame', rows)).toBeUndefined();
  });

  it('counts the references an author attached, and drops a muted chunk with its evidence', () => {
    // The pins hang at the frame's own rung — its shot — so this reads them out of `work/shots/`.
    const pinned = asset('pin1', 'location_ref', [{ locationId: 'cafe', variant: 'dawn' }]);
    const shot = (mute?: string[]): Shot => ({
      id: 'arrival__a',
      sceneId: 'arrival',
      framing: 'medium',
      location: 'night',
      subjects: [],
      coversLines: [],
      status: 'pending',
      promptOverride: {
        mode: 'chunks',
        ...(mute ? { mute } : {}),
        refs: {
          setting: [
            {
              pin: 'pin1',
              ext: 'png',
              from: { kind: 'plate', locationId: 'cafe', variant: 'dawn' },
            },
          ],
        },
      },
    });
    const attached = ctx([PLATE, PORTRAIT, FRAME, pinned]);
    attached.shots = new Map([['arrival', [shot()]]]);
    expect(assetPrereqs(FRAME, attached).map((p) => p.hash)).toEqual(['plate1', 'p-aiko', 'pin1']);

    // The clause is not being sent, so neither is its evidence — and nothing about the pin is in
    // the way of approving a picture the model was never shown it for.
    const muted = ctx([PLATE, PORTRAIT, FRAME, pinned]);
    muted.shots = new Map([['arrival', [shot(['setting'])]]]);
    expect(assetPrereqs(FRAME, muted).map((p) => p.hash)).toEqual(['plate1', 'p-aiko']);
  });

  it('lists one row for a picture fed in twice', () => {
    const frame = { ...FRAME, refs: ['plate1', 'plate1'] };
    expect(assetPrereqs(frame, ctx([PLATE, frame]))).toHaveLength(1);
  });
});

describe('prereqRefusal', () => {
  it('names the first thing in the way, and counts the rest', () => {
    const rows = assetPrereqs(FRAME, ctx([PLATE, PORTRAIT, FRAME]));
    expect(prereqRefusal('this frame', rows)).toBe(
      'Approve what this frame was drawn from first: cafe — night plate is not approved yet.',
    );
  });

  it('says nothing once everything under it is approved', () => {
    const plate = { ...PLATE, accepted: true };
    const rows = assetPrereqs(FRAME, ctx([plate, PORTRAIT, FRAME]));
    expect(prereqRefusal('this frame', rows)).toBeUndefined();
  });

  it('counts the others rather than listing them', () => {
    const second = asset('plate2', 'location_ref', [{ locationId: 'cafe', variant: 'dawn' }]);
    const frame = { ...FRAME, refs: ['plate1', 'plate2'] };
    const rows = assetPrereqs(frame, ctx([PLATE, second, frame]));
    expect(prereqRefusal('the frame', rows)).toContain(', and 1 more.');
  });
});
