import { splitScenes } from '@vn/model';
import { parseFountain } from '@vn/parse';
import type { Scene, Shot } from '@vn/types';
import type { LineOp, ScriptState } from '../lineops.js';
import { moveShot } from '../shotorder.js';

/** Six lines in one scene: three contiguous pairs, so a shot can sit over each. */
const SCRIPT = `INT. CLASSROOM - EVENING

[[scene: arrival]]

Aiko slips into the seat by the window.

AIKO
You're late.

REN
The train stopped.

The bell goes, and nobody moves.

AIKO
It always does.

Outside, the rain starts.
`;

const state = (): ScriptState => {
  const split = splitScenes(parseFountain(SCRIPT));
  expect(split.diagnostics).toEqual([]);
  return { scenes: new Map(split.scenes.map((s) => [s.id, s])), entry: 'arrival' };
};

const shot = (id: string, lines: string[]): Shot => ({
  id,
  sceneId    : 'arrival',
  framing    : 'medium',
  location   : 'classroom/evening',
  subjects   : [],
  coversLines: lines.map((n) => `arrival:${n}`),
  status     : 'pending',
});

/** Three shots, each over a contiguous pair — the shape a reorder is defined on. */
const SHOTS = [
  shot('arrival__establishing', ['L1', 'L2']),
  shot('arrival__beat1', ['L3', 'L4']),
  shot('arrival__beat2', ['L5', 'L6']),
];

const move = (shots: readonly Shot[], shotId: string, after: string): LineOp =>
  moveShot(shots, { shot: shotId, after })(state());

const written = (op: LineOp): Scene => {
  if (!op.ok) throw new Error(op.error);
  expect(op.writes).toHaveLength(1);
  return op.writes[0] as Scene;
};

const order = (op: LineOp): string[] => written(op).lines.map((l) => l.id);

const refusal = (op: LineOp): string => {
  if (op.ok) throw new Error(`Expected a refusal, got: ${op.message}`);
  return op.error;
};

/**
 * A shot's covered line texts in scene order — exactly what `@vn/pipeline`'s `proseHash` hashes.
 * Computed here rather than imported because `@vn/scriptedit` may not reach the pipeline.
 */
const coveredTexts = (scene: Scene, s: Shot): string[] => {
  const covered = new Set(s.coversLines);
  return scene.lines.filter((l) => covered.has(l.id)).map((l) => l.text);
};

const ids = (n: number[]): string[] => n.map((i) => `arrival:L${i}`);

describe('moveShot', () => {
  it('moves a shot down, taking its own lines and nothing else', () => {
    const op = move(SHOTS, 'arrival__establishing', 'arrival__beat1');
    expect(order(op)).toEqual(ids([3, 4, 1, 2, 5, 6]));
    expect(op.ok && op.message).toContain('taking its 2 line(s) with it');
  });

  it('moves a shot up', () => {
    expect(order(move(SHOTS, 'arrival__beat2', 'arrival__establishing'))) //
      .toEqual(ids([1, 2, 5, 6, 3, 4]));
  });

  it('moves a shot to the top when no target is named', () => {
    expect(order(move(SHOTS, 'arrival__beat2', ''))).toEqual(ids([5, 6, 1, 2, 3, 4]));
  });

  it('costs the storyboard nothing: no id retires, moves scene, or reads differently', () => {
    const op = move(SHOTS, 'arrival__establishing', 'arrival__beat2');
    if (!op.ok) throw new Error(op.error);
    expect(op.removes).toEqual([]);
    expect(op.retired).toEqual([]);
    expect(op.moved).toEqual([]);
    // `moveLine` reports drift because it moves a line between blocks. Moving a whole block
    // reports none, which is the claim the command's description makes
    expect(op.retyped).toEqual([]);
  });

  it('stamps the same allocator high-water mark every other edit does', () => {
    expect(written(move(SHOTS, 'arrival__beat1', '')).nextLineId).toBe(7);
  });
});

describe('moveShot — the prose each shot covers', () => {
  // A move permutes whole blocks, so no shot's covered lines change or change order among
  // themselves, which is why no `proseHash` moves
  it.each([
    ['arrival__establishing', 'arrival__beat1'],
    ['arrival__establishing', 'arrival__beat2'],
    ['arrival__beat1', 'arrival__beat2'],
    ['arrival__beat1', ''],
    ['arrival__beat2', ''],
    ['arrival__beat2', 'arrival__establishing'],
  ])('is unchanged by moving %s after "%s"', (id, after) => {
    const before = state().scenes.get('arrival') as Scene;
    const scene = written(move(SHOTS, id, after));
    for (const s of SHOTS) {
      expect(coveredTexts(scene, s)).toEqual(coveredTexts(before, s));
    }
  });
});

describe('moveShot — an interleaved shot', () => {
  // The establishing shot takes the narration while a medium shot takes the dialogue in between.
  // This is the deterministic decomposer's normal output, and such a shot has no single position
  const interleaved = [shot('arrival__establishing', ['L1', 'L4']), shot('arrival__beat1', ['L2'])];

  it('refuses to move, naming what draws inside it', () => {
    const error = refusal(move(interleaved, 'arrival__establishing', ''));
    expect(error).toContain('on screen in more than one place');
    expect(error).toContain('arrival__beat1');
    expect(error).toContain('Give it the lines in between');
  });

  it('can still be moved past, and keeps its coverage and its reading', () => {
    const shots = [...interleaved, shot('arrival__beat2', ['L5', 'L6'])];
    const before = state().scenes.get('arrival') as Scene;
    const op = move(shots, 'arrival__beat2', 'arrival__beat1');
    // beat2's pair lands between L2 and L3, which only widens the establishing shot's gap
    expect(order(op)).toEqual(ids([1, 2, 5, 6, 3, 4]));
    const scene = written(op);
    expect(coveredTexts(scene, interleaved[0] as Shot)).toEqual(
      coveredTexts(before, interleaved[0] as Shot),
    );
  });
});

describe('moveShot — refusals', () => {
  it('names a shot that is not there', () => {
    expect(refusal(move(SHOTS, 'arrival__beat9', ''))).toBe('No shot "arrival__beat9".');
    expect(refusal(move(SHOTS, 'arrival__beat1', 'arrival__beat9'))) //
      .toBe('No shot "arrival__beat9".');
  });

  it('refuses a shot moved after itself', () => {
    expect(refusal(move(SHOTS, 'arrival__beat1', 'arrival__beat1'))) //
      .toBe('A shot cannot be moved after itself.');
  });

  it('refuses a shot that covers nothing, which has no position at all', () => {
    expect(refusal(move([...SHOTS, shot('arrival__orphan', [])], 'arrival__orphan', ''))) //
      .toContain('no position to move');
  });

  it('refuses a target that covers nothing, since nothing can follow it', () => {
    const shots = [...SHOTS, shot('arrival__orphan', [])];
    expect(refusal(move(shots, 'arrival__beat1', 'arrival__orphan'))) //
      .toContain('nothing can follow it');
  });

  it('refuses a move that changes nothing, rather than writing the scene back unchanged', () => {
    expect(refusal(move(SHOTS, 'arrival__beat1', 'arrival__establishing'))) //
      .toBe('arrival__beat1 already sits after arrival__establishing.');
    expect(refusal(move(SHOTS, 'arrival__establishing', ''))) //
      .toBe('arrival__establishing is already first.');
  });

  it('refuses two shots that both cover the target line', () => {
    const shots = [shot('arrival__establishing', ['L1', 'L2']), shot('arrival__beat1', ['L2'])];
    expect(refusal(move(shots, 'arrival__establishing', 'arrival__beat1'))) //
      .toContain('both cover arrival:L2');
  });

  it('names a scene the shots claim but the state does not have', () => {
    const orphaned: Shot = { ...shot('gone__beat1', ['L1']), sceneId: 'gone' };
    expect(refusal(move([orphaned], 'gone__beat1', ''))).toBe('No scene "gone".');
  });
});
