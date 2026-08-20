/**
 * When the approve-and-generate pass takes another round, and what it approves when it does.
 * Both decisions spend real image calls or stop short of finishing the art, so they are pinned
 * here rather than left to a live run.
 */
import { MAX_ROUNDS, stopReason, toApprove } from '../pipeline.js';
import type { Approvable } from '@vn/authoring';

const round = (over: Partial<Parameters<typeof stopReason>[0]> = {}) => ({
  approved: 1,
  ran: 1,
  failed: 0,
  stopped: false,
  ...over,
});

describe('stopReason', () => {
  it('takes another round while either half is still moving', () => {
    expect(stopReason(round(), 0)).toBe('');
    expect(stopReason(round({ approved: 0 }), 0)).toBe('');
    expect(stopReason(round({ ran: 0 }), 0)).toBe('');
  });

  it('is done when nothing was approved and nothing ran', () => {
    expect(stopReason(round({ approved: 0, ran: 0 }), 0)).toContain('everything is generated');
  });

  it('gives up on a round that approved nothing and failed everything', () => {
    expect(stopReason(round({ approved: 0, ran: 2, failed: 2 }), 0)).toContain('failed');
    // Progress alongside a failure is still progress — an inherited failure would otherwise end
    // the pass on its first round and leave the rest of the art undrawn.
    expect(stopReason(round({ approved: 0, ran: 3, failed: 1 }), 0)).toBe('');
    expect(stopReason(round({ approved: 2, ran: 2, failed: 2 }), 0)).toBe('');
  });

  it('stops on the author, whatever the round managed', () => {
    expect(stopReason(round({ stopped: true }), 0)).toBe('stopped on request');
  });

  it('caps the loop, counting the round it is told about from zero', () => {
    expect(stopReason(round(), MAX_ROUNDS - 2)).toBe('');
    expect(stopReason(round(), MAX_ROUNDS - 1)).toContain(`${MAX_ROUNDS} rounds`);
    expect(stopReason(round(), 1, 2)).toBe('stopped after 2 rounds');
  });
});

const item = (over: Partial<Approvable> = {}): Approvable => ({
  hash: 'h1',
  kind: 'shot',
  label: 'a picture',
  slot: 'shot:greet/s1',
  door: 'accept',
  ...over,
});

describe('toApprove', () => {
  it('leaves out what is blocked on something upstream', () => {
    const rows = [item({ hash: 'a' }), item({ hash: 'b', blocked: 'its sheet is not approved' })];
    expect(toApprove(rows).map((r) => r.hash)).toEqual(['a']);
  });

  // Two portraits of one character are two answers to one question, not two pictures: approving
  // both in a pass would settle her look and then unsettle it.
  it('takes one portrait per character, and the first one offered', () => {
    const rows = [
      item({ hash: 'p1', kind: 'portrait', door: 'gate', characterId: 'aiko' }),
      item({ hash: 'p2', kind: 'portrait', door: 'gate', characterId: 'aiko' }),
      item({ hash: 'p3', kind: 'portrait', door: 'gate', characterId: 'haruki' }),
    ];
    expect(toApprove(rows).map((r) => r.hash)).toEqual(['p1', 'p3']);
  });

  it('skips a portrait of nobody rather than asking for it every round', () => {
    expect(toApprove([item({ kind: 'portrait', door: 'gate' })])).toEqual([]);
  });

  it('keeps every accept-door picture, however many share a slot', () => {
    const rows = [item({ hash: 'a' }), item({ hash: 'b' })];
    expect(toApprove(rows)).toHaveLength(2);
  });
});
