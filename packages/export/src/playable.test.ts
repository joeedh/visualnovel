import type { Asset, AssetStore, ProjectModel } from '@vn/types';
import { playableSchema } from '@vn/types';
import { parseFountain, parseFrontMatter } from '@vn/parse';
import { buildModel } from '@vn/model';
import { buildPlayable } from './playable.js';

/** A minimal in-memory {@link AssetStore}: only `manifest()` matters to the exporter. */
function fakeStore(assets: Asset[] = []): AssetStore {
  return {
    has: (h) => assets.some((a) => a.hash === h),
    write: () => Promise.reject(new Error('not implemented')),
    read: () => Promise.reject(new Error('not implemented')),
    pathOf: (r) => r.hash,
    manifest: () => assets,
    accept: () => Promise.resolve(),
  };
}

const asset = (partial: Partial<Asset> & Pick<Asset, 'hash' | 'kind'>): Asset => ({
  ext: 'png',
  sourceTask: 'task',
  refs: [],
  modelId: 'mock',
  satisfies: {},
  accepted: true,
  ...partial,
});

const charDoc = (id: string, name: string) =>
  parseFrontMatter(`---\nid: ${id}\nname: ${name}\n---\n\n${name}.\n`);

// A small branching story that mirrors examples/sample's shape: narration + attributed
// dialogue, a choice fork, a linear next, and a two-character scene.
const SCRIPT = `INT. CLASSROOM - AFTERNOON

[[scene: arrival]]

The door slides open. Aiko steps in.

AIKO
Um... hello.

[[next: rooftop]]

EXT. ROOFTOP - EVENING

[[scene: rooftop]]

Aiko pushes through the door. Haruki leans on the fence.

AIKO
Sorry.

HARUKI
Most people don't come up here.

[[choice: Stay -> good_end]]
[[choice: Leave -> bad_end]]

INT. CLASSROOM - EVENING

[[scene: good_end]]

The light fades warmly.

INT. HALL - NIGHT

[[scene: bad_end]]

The hall is empty.
`;

function sampleModel(): ProjectModel {
  return buildModel({
    title: 'The Transfer Student',
    characterDocs: [charDoc('aiko', 'Aiko'), charDoc('haruki', 'Haruki')],
    locationDocs: [],
    script: parseFountain(SCRIPT),
  });
}

describe('buildPlayable', () => {
  const model = sampleModel();

  it('carries the title and entry scene', () => {
    const play = buildPlayable(model, fakeStore());
    expect(play.version).toBe(1);
    expect(play.title).toBe('The Transfer Student');
    expect(play.start).toBe('arrival');
  });

  it('validates against the playable schema', () => {
    const play = buildPlayable(model, fakeStore());
    expect(() => playableSchema.parse(play)).not.toThrow();
  });

  it('flattens lines into ordered beats with a show at each shot change', () => {
    const play = buildPlayable(model, fakeStore());
    const beats = play.scenes['arrival']!.beats;
    // narration → establishing show; then dialogue → aiko show; text in reading order.
    expect(beats.map((b) => b.type)).toEqual(['show', 'narrate', 'show', 'say']);
    expect(beats[1]).toMatchObject({
      type: 'narrate',
      text: 'The door slides open. Aiko steps in.',
    });
    expect(beats[3]).toMatchObject({ type: 'say', who: 'aiko', text: 'Um... hello.' });
  });

  it('attributes each character in a multi-character scene', () => {
    const play = buildPlayable(model, fakeStore());
    const beats = play.scenes['rooftop']!.beats;
    expect(beats.map((b) => b.type)).toEqual(['show', 'narrate', 'show', 'say', 'show', 'say']);
    const says = beats.filter((b) => b.type === 'say');
    expect(says.map((b) => (b.type === 'say' ? b.who : null))).toEqual(['aiko', 'haruki']);
  });

  it('wires choices and the linear next', () => {
    const play = buildPlayable(model, fakeStore());
    expect(play.scenes['arrival']!.next).toBe('rooftop');
    expect(play.scenes['arrival']!.choices).toEqual([]);
    expect(play.scenes['rooftop']!.choices).toEqual([
      { label: 'Stay', goto: 'good_end' },
      { label: 'Leave', goto: 'bad_end' },
    ]);
    expect(play.scenes['rooftop']!.next).toBeUndefined();
  });

  it('omits asset refs cleanly when nothing is generated', () => {
    const play = buildPlayable(model, fakeStore());
    expect(play.characters['aiko']).toEqual({ name: 'Aiko' });
    const shows = play.scenes['arrival']!.beats.filter((b) => b.type === 'show');
    expect(shows.every((b) => b.type === 'show' && b.image === undefined)).toBe(true);
  });

  it('resolves shot images and portraits from the manifest when present', () => {
    const store = fakeStore([
      asset({
        hash: 'bg1',
        kind: 'shot_image',
        satisfies: { sceneId: 'arrival', shotId: 'arrival__establishing' },
      }),
      asset({ hash: 'por1', kind: 'portrait', satisfies: { characterId: 'aiko' } }),
    ]);
    const play = buildPlayable(model, store);
    expect(play.characters['aiko']!.portrait).toEqual({ hash: 'por1', ext: 'png' });
    const firstShow = play.scenes['arrival']!.beats.find((b) => b.type === 'show');
    expect(firstShow).toMatchObject({ type: 'show', image: { hash: 'bg1', ext: 'png' } });
  });

  it('prefers a character.approvedPortrait hash for the portrait ref', () => {
    const withApproved: ProjectModel = {
      ...model,
      characters: new Map(
        [...model.characters].map(([id, c]) =>
          id === 'aiko' ? [id, { ...c, approvedPortrait: 'approved-hash' }] : [id, c],
        ),
      ),
    };
    const play = buildPlayable(withApproved, fakeStore());
    expect(play.characters['aiko']!.portrait).toEqual({ hash: 'approved-hash', ext: 'png' });
  });
});
