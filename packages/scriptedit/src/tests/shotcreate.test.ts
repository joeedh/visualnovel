import type { Shot } from '@vn/types';
import { deleteShot, derivedNextShot, newShot } from '../shotcreate.js';

const SCENE = {
  id: 's',
  lines: [
    { id: 's:L1' },
    { id: 's:L2', speaker: 'aiko' },
    { id: 's:L3', speaker: 'ren' },
    { id: 's:L4', speaker: 'aiko' },
  ],
  locationVariant: 'dusk',
};

const shot = (id: string, coversLines: string[], extra: Partial<Shot> = {}): Shot => ({
  id,
  sceneId: 's',
  framing: 'medium',
  location: 'day',
  subjects: [],
  coversLines,
  status: 'pending',
  ...extra,
});

describe('derivedNextShot', () => {
  it('is one past the highest __shot<n> suffix, and 1 when there is none', () => {
    expect(derivedNextShot([shot('s__establishing', []), shot('s__beat1', [])])).toBe(1);
    expect(derivedNextShot([shot('s__shot2', []), shot('s__shot7', [])])).toBe(8);
  });

  it('counts a model-minted shot<n> id, not just hand-allocated ones', () => {
    // The model decomposer may answer with a raw `shot3`, which `shotId` namespaces to
    // `s__shot3`, so a file carrying no mark can still hold allocated shot<n> ids
    expect(derivedNextShot([shot('s__shot3', []), shot('s__beat1', [])])).toBe(4);
  });
});

describe('newShot', () => {
  it('creates the storyboard on an undecomposed scene, and says what that ends', () => {
    const op = newShot(SCENE, null, { lines: ['s:L2', 's:L3'] });
    if (!op.ok) throw new Error(op.error);
    expect(op.created).toBe(true);
    expect(op.shot.id).toBe('s__shot1');
    expect(op.nextShot).toBe(2);
    expect(op.shots).toEqual([op.shot]);
    expect(op.uncovered).toEqual(['s:L1', 's:L4']);
    expect(op.message).toContain('ends decomposition');
    expect(op.message).toContain('new frame');
  });

  it('allocates from the persisted mark, never from the count', () => {
    const board = { shots: [shot('s__shot1', ['s:L1'])], nextShot: 5 };
    const op = newShot(SCENE, board, { lines: ['s:L2'] });
    if (!op.ok) throw new Error(op.error);
    expect(op.shot.id).toBe('s__shot5');
    expect(op.nextShot).toBe(6);
    expect(op.created).toBe(false);
  });

  it('derives the mark when an older file never recorded one', () => {
    const board = { shots: [shot('s__shot2', ['s:L1'])] };
    const op = newShot(SCENE, board, { lines: ['s:L2'] });
    if (!op.ok) throw new Error(op.error);
    // Recreating a retired id would hash to an already-done task and silently inherit the
    // deleted shot's frame, so s__shot2 is not handed out again
    expect(op.shot.id).toBe('s__shot3');
  });

  it('refuses to make an orphan: at least one line, from birth', () => {
    expect(newShot(SCENE, null, { lines: [] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('at least one line'),
    });
  });

  it('refuses a birth that would empty a neighbour, with the coverage rule’s own sentence', () => {
    const board = { shots: [shot('s__shot1', ['s:L1']), shot('s__shot2', ['s:L2', 's:L3'])] };
    const op = newShot(SCENE, board, { lines: ['s:L1'] });
    expect(op).toMatchObject({ ok: false, error: expect.stringContaining('s__shot1') });
  });

  it('takes claimed lines off a neighbour it does not empty', () => {
    const board = { shots: [shot('s__shot1', ['s:L1', 's:L2'])], nextShot: 2 };
    const op = newShot(SCENE, board, { lines: ['s:L2', 's:L3'] });
    if (!op.ok) throw new Error(op.error);
    expect(op.shots.find((s) => s.id === 's__shot1')!.coversLines).toEqual(['s:L1']);
    expect(op.shot.coversLines).toEqual(['s:L2', 's:L3']);
  });

  it('casts the speakers of the claimed lines, deduped, with no outfit', () => {
    const op = newShot(SCENE, null, { lines: ['s:L2', 's:L3', 's:L4'] });
    if (!op.ok) throw new Error(op.error);
    expect(op.shot.subjects).toEqual([{ characterId: 'aiko' }, { characterId: 'ren' }]);
  });

  it('casts who was named instead, deduped and in the order given', () => {
    const op = newShot(SCENE, null, { lines: ['s:L2'], subjects: ['ren', 'aiko', 'ren'] });
    if (!op.ok) throw new Error(op.error);
    expect(op.shot.subjects).toEqual([{ characterId: 'ren' }, { characterId: 'aiko' }]);
    expect(op.message).toContain('It frames ren, aiko.');
  });

  // The alternative — an empty list meaning nobody on screen — buys a state narration already
  // produces, at the cost of a silently empty cast whenever an argument arrives empty
  it('reads an empty list as no answer, and falls back to the speakers', () => {
    const op = newShot(SCENE, null, { lines: ['s:L2'], subjects: [] });
    if (!op.ok) throw new Error(op.error);
    expect(op.shot.subjects).toEqual([{ characterId: 'aiko' }]);
    expect(op.message).not.toContain('It frames');
  });

  // Nothing sets a shot's subjects after birth, so a typo here would reach the prompt as an id
  // no character sheet answers
  it('refuses a subject the project has no character for', () => {
    expect(
      newShot(SCENE, null, { lines: ['s:L2'], subjects: ['aiko', 'kaz'], cast: ['aiko', 'ren'] }),
    ).toMatchObject({ ok: false, error: 'No character "kaz" in this project.' });
  });

  it('validates nothing when the caller names no cast', () => {
    const op = newShot(SCENE, null, { lines: ['s:L2'], subjects: ['kaz'] });
    expect(op.ok).toBe(true);
  });

  it('defaults framing to medium and honours an explicit one', () => {
    const a = newShot(SCENE, null, { lines: ['s:L1'] });
    if (!a.ok) throw new Error(a.error);
    expect(a.shot.framing).toBe('medium');
    const b = newShot(SCENE, null, { lines: ['s:L1'], framing: 'wide' });
    if (!b.ok) throw new Error(b.error);
    expect(b.shot.framing).toBe('wide');
  });

  it('validates the heading’s variant the way a decomposer’s answer is validated', () => {
    const claim = { lines: ['s:L1'] as const };
    const kept = newShot(SCENE, null, { ...claim, variants: ['day', 'dusk'] });
    if (!kept.ok) throw new Error(kept.error);
    expect(kept.shot.location).toBe('dusk');

    const fallback = newShot(SCENE, null, { ...claim, variants: ['day', 'night'] });
    if (!fallback.ok) throw new Error(fallback.error);
    expect(fallback.shot.location).toBe('day');

    const bare = newShot({ ...SCENE, locationVariant: undefined }, null, claim);
    if (!bare.ok) throw new Error(bare.error);
    expect(bare.shot.location).toBe('day');
  });
});

describe('deleteShot', () => {
  it('releases the shot’s lines as gaps, never to a neighbour', () => {
    const board = {
      shots: [shot('s__shot1', ['s:L1', 's:L3']), shot('s__shot2', ['s:L2'])],
      nextShot: 3,
    };
    const op = deleteShot(board, { shot: 's__shot1' });
    if (!op.ok) throw new Error(op.error);
    expect(op.released).toEqual(['s:L1', 's:L3']);
    expect(op.shots.map((s) => s.id)).toEqual(['s__shot2']);
    expect(op.shots[0]!.coversLines).toEqual(['s:L2']);
    expect(op.deleteFile).toBe(false);
    expect(op.nextShot).toBe(3);
  });

  it('deletes the file with the last shot, restoring the decompose-this signal', () => {
    const op = deleteShot(
      { shots: [shot('s__shot1', ['s:L1'])], nextShot: 2 },
      { shot: 's__shot1' },
    );
    if (!op.ok) throw new Error(op.error);
    expect(op.deleteFile).toBe(true);
    expect(op.shots).toEqual([]);
    expect(op.message).toContain('decomposed again');
  });

  it('prices an orphaned rendered frame in the message', () => {
    const board = {
      shots: [shot('s__shot1', ['s:L1'], { image: 'abc123' }), shot('s__shot2', ['s:L2'])],
    };
    const op = deleteShot(board, { shot: 's__shot1' });
    if (!op.ok) throw new Error(op.error);
    expect(op.message).toContain('orphaned');
    const plain = deleteShot(board, { shot: 's__shot2' });
    if (!plain.ok) throw new Error(plain.error);
    expect(plain.message).not.toContain('orphaned');
  });

  it('keeps the deleted id retired when the file carried no mark', () => {
    const op = deleteShot({ shots: [shot('s__shot4', ['s:L1'])] }, { shot: 's__shot4' });
    if (!op.ok) throw new Error(op.error);
    // Derived over the board before the removal, so the freed id cannot be minted again
    expect(op.nextShot).toBe(5);
  });

  it('refuses an unknown shot', () => {
    expect(deleteShot({ shots: [shot('s__shot1', [])] }, { shot: 'nope' })).toMatchObject({
      ok: false,
    });
  });
});
