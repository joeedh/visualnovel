import { splitScenes } from '@vn/model';
import { parseFountain } from '@vn/parse';
import type { Shot } from '@vn/types';
import {
  deleteLine,
  deleteScene,
  insertLine,
  mergeScene,
  moveLine,
  setHeading,
  setLineText,
  splitScene,
  type AppliedLineOp,
  type LineOp,
  type ScriptState,
} from '../lineops.js';
import { scenesTouchedBy, shotFallout, type ShotsByScene } from '../shotfallout.js';

/**
 * Four lines in `arrival`, two in `rooftop` that it continues to, and two in an `attic` nothing
 * points at — the only scene a delete can reach, since `deleteScene` refuses while it is a target.
 * Ids come from the real reader's allocator rather than being stamped by hand.
 */
const SCRIPT = `INT. CLASSROOM - EVENING

[[scene: arrival]]
[[next: rooftop]]

Aiko slips into the seat by the window.

AIKO
You're late.

REN
The train stopped.

AIKO
It always does.

EXT. ROOFTOP - SUNSET

[[scene: rooftop]]

REN
I know.

AIKO
Then say it.

INT. ATTIC - NIGHT

[[scene: attic]]

Dust, and one chair.

Nobody has been here in years.
`;

const state = (): ScriptState => {
  const split = splitScenes(parseFountain(SCRIPT));
  expect(split.diagnostics).toEqual([]);
  return { scenes: new Map(split.scenes.map((s) => [s.id, s])), entry: 'arrival' };
};

const applied = (op: LineOp): AppliedLineOp => {
  if (!op.ok) throw new Error(op.error);
  return op;
};

/** A persisted shot: rendered when `image` is given, since drift only applies to real art. */
const shot = (id: string, sceneId: string, lines: string[], image?: string): Shot => ({
  id,
  sceneId,
  framing: 'medium',
  location: 'classroom/evening',
  subjects: [],
  coversLines: lines,
  status: image ? 'accepted' : 'pending',
  ...(image ? { image } : {}),
});

const stored = (entries: Record<string, Shot[]>): ShotsByScene => new Map(Object.entries(entries));

/** The head half keeps L1–L2, the tail takes L3–L4 into `climb`. */
const split = () =>
  applied(splitScene(state(), { scene: 'arrival', at: 'arrival:L3', into: 'climb' }));

describe('scenesTouchedBy', () => {
  it('names every scene an edit writes, removes, or renames a line out of', () => {
    expect(scenesTouchedBy(split()).sort()).toEqual(['arrival', 'climb']);
    expect(scenesTouchedBy(applied(deleteScene(state(), { scene: 'attic' })))).toEqual(['attic']);
    expect(scenesTouchedBy(applied(setLineText(state(), { line: 'arrival:L1', text: 'Late.' })))) //
      .toEqual(['arrival']);
  });
});

describe('a shot whose lines all leave together', () => {
  it('moves to the destination file with rewritten coverage, keeping its id and art', () => {
    const shots = stored({
      arrival: [
        shot('arrival__establishing', 'arrival', ['arrival:L1', 'arrival:L2'], 'aaa'),
        shot('arrival__beat1', 'arrival', ['arrival:L3', 'arrival:L4'], 'bbb'),
      ],
    });
    const out = shotFallout(split(), shots);

    expect(out.carried).toEqual([['arrival__beat1', 'climb']]);
    expect(out.detached).toEqual([]);
    expect([...out.writes.keys()].sort()).toEqual(['arrival', 'climb']);
    // The id is part of the shot's task hash, so a carried shot never gets renamed.
    expect(out.writes.get('climb')).toEqual([
      { ...shot('arrival__beat1', 'climb', ['climb:L3', 'climb:L4'], 'bbb') },
    ]);
    expect(out.writes.get('arrival')?.map((s) => s.id)).toEqual(['arrival__establishing']);
    expect(out.note).toBe('1 shot(s) follow their lines into climb.');
  });

  it('leaves the origin file alone when every shot in it left', () => {
    const shots = stored({
      arrival: [shot('arrival__beat1', 'arrival', ['arrival:L3', 'arrival:L4'])],
    });
    const out = shotFallout(split(), shots);

    expect(out.carried).toEqual([['arrival__beat1', 'climb']]);
    // `arrival` has no shots left, so its file goes: an absent one is the only "decompose me".
    expect(out.removes).toEqual(['arrival']);
    expect(out.writes.has('arrival')).toBe(false);
    expect(out.note).toMatch(/arrival has no shots left and will be decomposed again/);
  });
});

describe('a shot that straddles a split', () => {
  it('stays where it is and loses the lines that left, priced by what was rendered', () => {
    const shots = stored({
      arrival: [shot('arrival__wide', 'arrival', ['arrival:L2', 'arrival:L3'], 'aaa')],
    });
    const out = shotFallout(split(), shots);

    expect(out.carried).toEqual([]);
    expect(out.detached).toEqual([['arrival__wide', 1]]);
    expect(out.writes.get('arrival')?.[0]?.coversLines).toEqual(['arrival:L2']);
    expect(out.note).toBe('1 shot(s) lose 1 line(s) of coverage, 1 already rendered.');
  });
});

describe('a merge', () => {
  it('carries the absorbed scene’s shots into the survivor under their new ids', () => {
    const shots = stored({
      rooftop: [shot('rooftop__beat1', 'rooftop', ['rooftop:L1', 'rooftop:L2'], 'ccc')],
    });
    const out = shotFallout(
      applied(mergeScene(state(), { scene: 'rooftop', into: 'arrival' })),
      shots,
    );

    expect(out.carried).toEqual([['rooftop__beat1', 'arrival']]);
    expect(out.discarded).toEqual([]);
    expect(out.writes.get('arrival')?.[0]?.coversLines).toEqual(['arrival:L5', 'arrival:L6']);
    // The absorbed scene stopped existing, so its storyboard file goes with the chunk.
    expect(out.removes).toEqual(['rooftop']);
  });
});

describe('a deleted scene', () => {
  it('drops the shots that went with its file, and says how many were paid for', () => {
    const shots = stored({
      attic: [shot('attic__beat1', 'attic', ['attic:L1', 'attic:L2'], 'ccc')],
    });
    const out = shotFallout(applied(deleteScene(state(), { scene: 'attic' })), shots);

    expect(out.discarded).toEqual(['attic__beat1']);
    expect(out.carried).toEqual([]);
    expect(out.writes.size).toBe(0);
    expect(out.removes).toEqual(['attic']);
    expect(out.note).toBe('1 shot(s) go with it, 1 already rendered.');
  });
});

describe('a deleted line', () => {
  it('empties the shot that covered nothing else, and says so', () => {
    const shots = stored({ arrival: [shot('arrival__beat1', 'arrival', ['arrival:L4'])] });
    const out = shotFallout(applied(deleteLine(state(), { line: 'arrival:L4' })), shots);

    expect(out.orphaned).toEqual(['arrival__beat1']);
    expect(out.detached).toEqual([['arrival__beat1', 1]]);
    // Covering nothing is a state the timeline shows; the shot stays, with an empty set.
    expect(out.writes.get('arrival')?.[0]?.coversLines).toEqual([]);
    expect(out.removes).toEqual([]);
    expect(out.note).toMatch(/1 shot\(s\) end up covering nothing/);
  });
});

describe('drift', () => {
  it('reports a rendered shot whose covered prose changed, and that nothing will fix it', () => {
    const shots = stored({
      arrival: [shot('arrival__beat1', 'arrival', ['arrival:L2'], 'aaa')],
    });
    const out = shotFallout(
      applied(setLineText(state(), { line: 'arrival:L2', text: 'You are late.' })),
      shots,
    );

    expect(out.drifted).toEqual(['arrival__beat1']);
    expect(out.note).toBe(
      '1 rendered shot(s) still illustrate the old prose and will not re-render on their own.',
    );
    // Coverage did not move, so there is nothing to write.
    expect(out.writes.size).toBe(0);
  });

  it('says nothing about a shot that was never rendered', () => {
    const shots = stored({ arrival: [shot('arrival__beat1', 'arrival', ['arrival:L2'])] });
    const out = shotFallout(
      applied(setLineText(state(), { line: 'arrival:L2', text: 'You are late.' })),
      shots,
    );

    expect(out.drifted).toEqual([]);
    expect(out.note).toBe('');
  });

  it('follows a reordered line, since order is what the covered prose reads as', () => {
    const shots = stored({
      arrival: [shot('arrival__beat1', 'arrival', ['arrival:L2'], 'aaa')],
    });
    const out = shotFallout(
      applied(moveLine(state(), { line: 'arrival:L2', after: 'arrival:L4' })),
      shots,
    );
    expect(out.drifted).toEqual(['arrival__beat1']);
  });
});

describe('an edit with no coverage consequence', () => {
  it('writes nothing, removes nothing and stays quiet', () => {
    const shots = stored({
      arrival: [shot('arrival__beat1', 'arrival', ['arrival:L2'], 'aaa')],
    });
    const out = shotFallout(
      applied(
        insertLine(state(), {
          scene: 'arrival',
          after: '',
          kind: 'narration',
          speaker: '',
          text: 'Rain.',
        }),
      ),
      shots,
    );

    expect(out).toMatchObject({
      removes: [],
      carried: [],
      detached: [],
      orphaned: [],
      discarded: [],
      drifted: [],
      note: '',
    });
    expect(out.writes.size).toBe(0);
  });

  it('is a no-op for a scene with no storyboard at all', () => {
    const out = shotFallout(split(), stored({}));
    expect(out.writes.size).toBe(0);
    expect(out.removes).toEqual([]);
    expect(out.note).toBe('');
  });
});

describe('a scene that changed place', () => {
  const moved = () =>
    applied(setHeading(state(), { scene: 'arrival', heading: 'EXT. PIER - DAWN' }));

  it('restages every shot onto the new variant, so each one still has a plate to wait for', () => {
    const shots = stored({
      arrival: [
        shot('arrival__establishing', 'arrival', ['arrival:L1'], 'aaa'),
        shot('arrival__beat1', 'arrival', ['arrival:L3']),
      ],
    });
    const out = shotFallout(moved(), shots);

    expect(out.restaged).toEqual(['arrival__establishing', 'arrival__beat1']);
    expect(out.writes.get('arrival')?.map((s) => s.location)).toEqual(['dawn', 'dawn']);
    // Coverage is untouched: a heading is not a line, so nothing detaches or drifts.
    expect(out).toMatchObject({ carried: [], detached: [], orphaned: [], drifted: [] });
  });

  it('prices the ones already rendered, because a location is in a shot’s task inputs', () => {
    const shots = stored({
      arrival: [shot('arrival__establishing', 'arrival', ['arrival:L1'], 'aaa')],
    });
    expect(shotFallout(moved(), shots).note).toMatch(/1 already rendered/);
  });

  it('says nothing and writes nothing when the shots are already staged there', () => {
    const shots = stored({
      arrival: [{ ...shot('arrival__establishing', 'arrival', ['arrival:L1']), location: 'dawn' }],
    });
    const out = shotFallout(moved(), shots);
    expect(out.restaged).toEqual([]);
    expect(out.writes.size).toBe(0);
    expect(out.note).toBe('');
  });
});
