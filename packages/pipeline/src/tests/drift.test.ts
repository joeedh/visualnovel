/**
 * Drift: whether a rendered frame still illustrates the words it covers.
 *
 * The unit cases pin what does and does not count as a change to the prose. The last case is
 * driven through the real scheduler, because the contract that matters is a temporal one — the
 * hash is stamped with the bytes and a later run must not quietly re-baseline it.
 */
import { SCRIPTS, makeProject } from '@vn/testkit';
import type { Scene, SceneLine, Shot, ShotsFile } from '@vn/types';
import { driftOf, proseHash } from '../drift.js';

const line = (id: string, text: string): SceneLine => ({ id, kind: 'narration', text });

const scene = (lines: SceneLine[]): Scene => ({
  id        : 's',
  location  : 'roof',
  characters: [],
  lines,
  choices: [],
  shots  : [],
});

const LINES = [
  line('s:L1', 'The roof, at dusk.'),
  line('s:L2', 'She bows.'),
  line('s:L3', 'Rain.'),
];
const SCENE = scene(LINES);

/** A rendered shot whose recorded hash is, by construction, the one its lines produce now. */
function rendered(coversLines: string[], from: Scene = SCENE): Shot {
  return {
    id      : 's__a',
    sceneId : 's',
    framing : 'medium',
    location: 'day',
    subjects: [],
    coversLines,
    image    : 'abc',
    proseHash: proseHash(from, coversLines),
    status   : 'accepted',
  };
}

describe('driftOf', () => {
  it('is current while the covered lines say what they said', () => {
    expect(driftOf(SCENE, rendered(['s:L1', 's:L2']))).toBe('current');
  });

  it('drifts when a covered line is retyped', () => {
    const shot = rendered(['s:L1', 's:L2']);
    const after = scene([LINES[0]!, line('s:L2', 'She bows, a little too deeply.'), LINES[2]!]);
    expect(driftOf(after, shot)).toBe('drifted');
  });

  it('does not drift when a line the shot does not cover is retyped', () => {
    const shot = rendered(['s:L1', 's:L2']);
    const after = scene([LINES[0]!, LINES[1]!, line('s:L3', 'Rain, then nothing.')]);
    expect(driftOf(after, shot)).toBe('current');
  });

  it('does not drift when only the order of `coversLines` changes', () => {
    // Coverage is a set; the hash walks the scene, so an array reshuffle is not an edit.
    const shot = rendered(['s:L1', 's:L2']);
    shot.coversLines = ['s:L2', 's:L1'];
    expect(driftOf(SCENE, shot)).toBe('current');
  });

  it('drifts when the shot is extended over a line it was not made from', () => {
    // The frame does not illustrate s:L3, so extending coverage over it counts as drift
    const shot = rendered(['s:L1']);
    shot.coversLines = ['s:L1', 's:L3'];
    expect(driftOf(SCENE, shot)).toBe('drifted');
  });

  it('reads unknown, never drifted, for a shot rendered before the hash existed', () => {
    const shot = rendered(['s:L1']);
    delete shot.proseHash;
    expect(driftOf(SCENE, shot)).toBe('unknown');
  });

  it('reads unrendered when there is no frame to be stale', () => {
    const shot = rendered(['s:L1']);
    delete shot.image;
    expect(driftOf(SCENE, shot)).toBe('unrendered');
  });

  it('ignores a covered id the scene no longer has', () => {
    // `readShots` drops these on load, so the hash must agree with the shot as loaded.
    expect(proseHash(SCENE, ['s:L1', 's:L99'])).toBe(proseHash(SCENE, ['s:L1']));
  });
});

describe('the stamp a run leaves', () => {
  jest.setTimeout(30_000);

  it('records the prose with the bytes, and a later run does not re-baseline it', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      await p.approveAll();
      await p.run();

      const file = 'vngen/work/shots/arrival.json';
      const read = async (): Promise<ShotsFile> => JSON.parse(await p.read(file)) as ShotsFile;

      const persisted = (await read()).shots.find((s) => s.coversLines.length > 0)!;
      expect(persisted.shotData?.image).toBeDefined();
      const stamped = persisted.shotData!.proseHash!;

      const before = (await p.reload()).model.scenes.get('arrival')!;
      expect(stamped).toBe(proseHash(before, persisted.coversLines));

      // Retype a covered line in the chunk the model was built from.
      const covered = before.lines.find((l) => persisted.coversLines.includes(l.id))!;
      const chunk = 'scenes/arrival.md';
      const source = await p.read(chunk);
      expect(source).toContain(covered.text);
      await p.write(chunk, source.replace(covered.text, 'Something else entirely.'));

      const after = (await p.reload()).model.scenes.get('arrival')!;
      const shot: Shot = {
        id         : persisted.id,
        sceneId    : 'arrival',
        framing    : persisted.framing,
        location   : persisted.location,
        subjects   : [],
        coversLines: persisted.coversLines,
        image      : persisted.shotData!.image,
        proseHash  : stamped,
        status     : 'accepted',
      };
      expect(driftOf(after, shot)).toBe('drifted');

      // The frame is still the frame the run produced, so the mark has to survive the rerun —
      // clearing it here would let a run that did no work answer for prose it never saw.
      await p.run();
      const reread = (await read()).shots.find((s) => s.id === persisted.id)!;
      expect(reread.shotData?.proseHash).toBe(stamped);
      expect(reread.shotData?.image).toBe(persisted.shotData!.image);
    } finally {
      await p.cleanup();
    }
  });
});
