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
import { unapprovedSentence, unapprovedTakes } from '../unapproved.js';

/** A minimal in-memory {@link AssetStore}: only `manifest()` matters to the exporter. */
function fakeStore(assets: Asset[] = []): AssetStore {
  return {
    has         : (h) => assets.some((a) => a.hash === h),
    write       : () => Promise.reject(new Error('not implemented')),
    read        : () => Promise.reject(new Error('not implemented')),
    pathOf      : (r) => r.hash,
    manifest    : () => assets,
    hold        : () => Promise.resolve(),
    accept      : () => Promise.resolve(),
    unstamped   : false,
    migrateTakes: () => Promise.resolve(),
  };
}

const asset = (partial: Partial<Asset> & Pick<Asset, 'hash' | 'kind'>): Asset => ({
  ext       : 'png',
  sourceTask: 'task',
  refs      : [],
  modelId   : 'mock',
  satisfies : [],
  accepted  : true,
  current   : true,
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
    title        : 'The Transfer Student',
    characterDocs: [charDoc('aiko', 'Aiko'), charDoc('haruki', 'Haruki')],
    locationDocs : [],
    script       : parseFountain(SCRIPTS.branching),
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
        hash     : 'bg1',
        kind     : 'shot_image',
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

  it('carries bubble_names, written even when off', () => {
    expect(buildPlayable(model, fakeStore()).bubbleNames).toBe(false);
    expect(buildPlayable(model, fakeStore(), { bubbleNames: true }).bubbleNames).toBe(true);
  });
});

describe('unapprovedTakes', () => {
  const model = sampleModel();
  const lines = model.scenes.get('arrival')!.lines.map((l) => l.id);
  const shots = new Map<string, Shot[]>([
    [
      'arrival',
      [
        {
          id         : 'arrival__s1',
          sceneId    : 'arrival',
          framing    : 'wide',
          location   : 'evening',
          subjects   : [],
          coversLines: lines,
          status     : 'pending',
        },
      ],
    ],
  ]);
  const frame = (over: Partial<Asset>): Asset =>
    asset({
      hash     : 'f1',
      kind     : 'shot_image',
      satisfies: [{ sceneId: 'arrival', shotId: 'arrival__s1' }],
      ...over,
    });
  const portrait = (over: Partial<Asset>): Asset =>
    asset({ hash: 'p1', kind: 'portrait', satisfies: [{ characterId: 'aiko' }], ...over });

  it('lists the frames and cast portraits the playable would show unapproved, frames first', () => {
    const store = fakeStore([frame({ accepted: false }), portrait({ accepted: false })]);
    expect(unapprovedTakes(model, store, shots)).toEqual([
      { slot: 'shot:arrival/arrival__s1', hash: 'f1' },
      { slot: 'portrait:aiko', hash: 'p1' },
    ]);
    expect(unapprovedSentence(unapprovedTakes(model, store, shots))).toMatch(
      /^shot:arrival\/arrival__s1 holds a take nobody has approved \(f1…\) and 1 more\./,
    );
  });

  it('is silent for approved takes, and for a slot that holds nothing', () => {
    // A frame a later render pushed out is history and not shown, so its flag does not matter.
    const store = fakeStore([
      frame({ accepted: true }),
      frame({ hash: 'f0', current: false, accepted: false }),
    ]);
    const approved: ProjectModel = {
      ...model,
      characters: new Map(
        [...model.characters].map(([id, c]) =>
          id === 'aiko' ? [id, { ...c, status: 'approved', approvedPortrait: 'p1' }] : [id, c],
        ),
      ),
    };
    expect(unapprovedTakes(approved, store, shots)).toEqual([]);
    expect(unapprovedSentence([])).toBeUndefined();
    // Nothing drawn at all: the player shows a placeholder, and there is nothing to approve.
    expect(unapprovedTakes(model, fakeStore(), shots)).toEqual([]);
  });

  it('reads a portrait off the gate: the flag alone approves nothing', () => {
    const store = fakeStore([portrait({ accepted: true })]);
    expect(unapprovedTakes(model, store, shots)).toEqual([{ slot: 'portrait:aiko', hash: 'p1' }]);
  });
});

describe('persisted decompositions', () => {
  const model = sampleModel();
  const lines = model.scenes.get('arrival')!.lines.map((l) => l.id);

  /** A decomposition the deterministic baseline would never produce — LLM-shaped ids. */
  const llmShots = (): Shot[] => [
    {
      id         : 'arrival__llm-1',
      sceneId    : 'arrival',
      framing    : 'wide',
      location   : 'evening',
      subjects   : [],
      coversLines: lines,
      status     : 'accepted',
    },
  ];

  it('uses the persisted shots instead of reconstructing the baseline', () => {
    const store = fakeStore([
      asset({
        hash     : 'llm1',
        kind     : 'shot_image',
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

  it('writes the line id on every say and narrate beat', () => {
    const play = buildPlayable(model, fakeStore(), { shots: new Map([['arrival', llmShots()]]) });
    const spoken = play.scenes['arrival']!.beats.flatMap((b) => (b.type === 'show' ? [] : [b]));
    expect(spoken.map((b) => b.line)).toEqual(lines);
  });

  it("carries a page shot's panels on its show beat, with the lines each letters", () => {
    const [first, ...rest] = lines;
    const page: Shot = {
      ...llmShots()[0]!,
      panels: [
        {
          shape: [
            [0, 0],
            [1, 0],
            [1, 0.5],
            [0, 0.5],
          ],
          framing    : 'wide',
          subjects   : [],
          coversLines: [first!],
        },
        {
          shape: [
            [0, 0.5],
            [1, 0.5],
            [1, 1],
            [0, 1],
          ],
          framing    : 'close',
          subjects   : [],
          coversLines: rest,
        },
      ],
    };
    const play = buildPlayable(model, fakeStore(), { shots: new Map([['arrival', [page]]]) });
    expect(() => playableSchema.parse(play)).not.toThrow();
    const show = play.scenes['arrival']!.beats[0];
    expect(show).toMatchObject({
      type  : 'show',
      panels: [
        {
          shape: [
            [0, 0],
            [1, 0],
            [1, 0.5],
            [0, 0.5],
          ],
          lines: [first],
        },
        {
          shape: [
            [0, 0.5],
            [1, 0.5],
            [1, 1],
            [0, 1],
          ],
          lines: rest,
        },
      ],
    });
    // A frame's show beat has no panels key at all, so a file with no pages is byte for byte
    // what it was.
    const frame = buildPlayable(model, fakeStore(), { shots: new Map([['arrival', llmShots()]]) });
    expect('panels' in frame.scenes['arrival']!.beats[0]!).toBe(false);
  });

  it('carries a panel’s bubbles only when the runner letters the page', () => {
    const [first, ...rest] = lines;
    const page: Shot = {
      ...llmShots()[0]!,
      panels: [
        {
          shape: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          framing    : 'wide',
          subjects   : [],
          coversLines: [first!, ...rest],
          bubbles: [
            { lineId: first!, anchor: [0.3, 0.2], tail: [0.4, 0.5] },
            { lineId: rest[0]!, anchor: [0.7, 0.2], name: true },
          ],
        },
      ],
    };
    const shots = new Map([['arrival', [page]]]);
    const runner = buildPlayable(model, fakeStore(), { shots, lettering: 'runner' });
    expect(() => playableSchema.parse(runner)).not.toThrow();
    expect(runner.scenes['arrival']!.beats[0]).toMatchObject({
      panels: [
        {
          bubbles: [
            { line: first, anchor: [0.3, 0.2], tail: [0.4, 0.5] },
            { line: rest[0], anchor: [0.7, 0.2], name: true },
          ],
        },
      ],
    });
    // The words are in the picture under model lettering, so no bubble is exported, and a
    // project that says nothing exports none either.
    for (const opts of [{ shots, lettering: 'model' as const }, { shots }]) {
      const show = buildPlayable(model, fakeStore(), opts).scenes['arrival']!.beats[0]!;
      expect(show.type === 'show' && 'bubbles' in show.panels![0]!).toBe(false);
    }
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
