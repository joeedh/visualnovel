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

  // A project whose last tasks are failed or flagged `needs_human` has stopped moving too, so it
  // must not be reported as everything generated — the author would disprove that by opening the
  // art.
  it('does not call a standstill with failures a finished project', () => {
    const why = stopReason(round({ approved: 0, ran: 0, failed: 3 }), 0);
    expect(why).toContain('needs a person');
    expect(why).not.toContain('everything is generated');
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
      item({
        hash: 'p1',
        kind: 'portrait',
        door: 'gate',
        slot: 'portrait:aiko',
        characterId: 'aiko',
      }),
      item({
        hash: 'p2',
        kind: 'portrait',
        door: 'gate',
        slot: 'portrait:aiko',
        characterId: 'aiko',
      }),
      item({
        hash: 'p3',
        kind: 'portrait',
        door: 'gate',
        slot: 'portrait:haruki',
        characterId: 'haruki',
      }),
    ];
    expect(toApprove(rows).map((r) => r.hash)).toEqual(['p1', 'p3']);
  });

  it('skips a portrait of nobody rather than asking for it every round', () => {
    expect(toApprove([item({ kind: 'portrait', door: 'gate' })])).toEqual([]);
  });

  // Two unaccepted drafts for one slot are alternatives as much as two portraits are: accepting
  // both leaves `pick` unable to name what the slot holds, so it reads as empty.
  it('takes one accept-door draft per slot too', () => {
    const rows = [item({ hash: 'a' }), item({ hash: 'b' })];
    expect(toApprove(rows).map((r) => r.hash)).toEqual(['a']);
  });

  it('keeps drafts for different slots apart', () => {
    const rows = [item({ hash: 'a' }), item({ hash: 'b', slot: 'shot:greet/s2' })];
    expect(toApprove(rows)).toHaveLength(2);
  });

  // A finished project still lists the takes that lost. A pass that approved them would change
  // every settled answer, be offered the old one again next round forever, and leave the pipeline
  // it ran between rounds with nothing to do.
  it('leaves a settled slot alone, whichever door it answers to', () => {
    const rows = [
      item({ hash: 'a', settled: true }),
      item({
        hash: 'p1',
        kind: 'portrait',
        door: 'gate',
        slot: 'portrait:aiko',
        characterId: 'aiko',
        settled: true,
      }),
    ];
    expect(toApprove(rows)).toEqual([]);
  });
});
