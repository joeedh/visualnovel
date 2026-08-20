import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Asset, AssetStore, ProjectModel, Shot } from '@vn/types';
import { playableSchema } from '@vn/types';
import { parseFountain, parseFrontMatter } from '@vn/parse';
import { buildModel } from '@vn/model';
import { ProjectPaths, writeShots } from '@vn/store';
import { SCRIPTS } from '@vn/testkit';
import { buildPlayable, loadSceneShots } from '../playable.js';

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
  satisfies: [],
  accepted: true,
  ...partial,
});

const charDoc = (id: string, name: string) => {
  const text = `---\nid: ${id}\nname: ${name}\n---\n\n${name}.\n`;
  return { id, file: `/p/characters/${id}/character.md`, doc: parseFrontMatter(text), text };
};

// A small branching story that mirrors templates/basic's shape: narration + attributed
// dialogue, a choice fork, a linear next, and a two-character scene.
function sampleModel(): ProjectModel {
  return buildModel({
    title: 'The Transfer Student',
    characterDocs: [charDoc('aiko', 'Aiko'), charDoc('haruki', 'Haruki')],
    locationDocs: [],
    script: parseFountain(SCRIPTS.branching),
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
        satisfies: [{ sceneId: 'arrival', shotId: 'arrival__establishing' }],
      }),
      asset({ hash: 'por1', kind: 'portrait', satisfies: [{ characterId: 'aiko' }] }),
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

  // The flag is presentation only. The ref is exported either way, so turning the overlay on is
  // a runner-side decision and never requires a re-export.
  it('says the portrait overlay is off unless the project asked for it', () => {
    const store = fakeStore([
      asset({ hash: 'por1', kind: 'portrait', satisfies: [{ characterId: 'aiko' }] }),
    ]);
    expect(buildPlayable(model, store).portraitOverlay).toBe(false);

    const on = buildPlayable(model, store, { portraitOverlay: true });
    expect(on.portraitOverlay).toBe(true);
    expect(on.characters['aiko']!.portrait).toEqual({ hash: 'por1', ext: 'png' });
  });
});

describe('persisted decompositions', () => {
  const model = sampleModel();
  const lines = model.scenes.get('arrival')!.lines.map((l) => l.id);

  /** A decomposition the deterministic baseline would never produce — LLM-shaped ids. */
  const llmShots = (): Shot[] => [
    {
      id: 'arrival__llm-1',
      sceneId: 'arrival',
      framing: 'wide',
      location: 'evening',
      subjects: [],
      coversLines: lines,
      status: 'accepted',
    },
  ];

  it('uses the persisted shots instead of reconstructing the baseline', () => {
    const store = fakeStore([
      asset({
        hash: 'llm1',
        kind: 'shot_image',
        satisfies: [{ sceneId: 'arrival', shotId: 'arrival__llm-1' }],
      }),
    ]);
    // Without the decomposition the exporter guesses `arrival__establishing`, which matches
    // nothing in the manifest: every image the run paid for stays off screen.
    const guessed = buildPlayable(model, store).scenes['arrival']!.beats;
    expect(guessed.filter((b) => b.type === 'show' && b.image)).toHaveLength(0);

    const play = buildPlayable(model, store, { shots: new Map([['arrival', llmShots()]]) });
    const shows = play.scenes['arrival']!.beats.filter((b) => b.type === 'show');
    // One shot covers every line, so the image is shown once and never changes.
    expect(shows).toHaveLength(1);
    expect(shows[0]).toMatchObject({ image: { hash: 'llm1', ext: 'png' } });
  });

  it('reads them off disk, dropping line ids the screenplay no longer has', async () => {
    const paths = new ProjectPaths(await mkdtemp(join(tmpdir(), 'vn-export-')));
    const stale = llmShots();
    stale[0]!.coversLines = [...lines, 'arrival:L99'];
    await writeShots(paths, 'arrival', stale);

    const loaded = await loadSceneShots(paths, model);
    expect([...loaded.keys()]).toEqual(['arrival']);
    expect(loaded.get('arrival')![0]!.coversLines).toEqual(lines);
  });
});
