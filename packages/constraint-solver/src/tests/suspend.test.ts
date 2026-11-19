/**
 * Suspension over the toy family: derived on every read from what each row was drawn from, never
 * stored. A graft is the toy's pinned reference: a row records the take it was grafted from and the
 * slot that take came from.
 */
import { solve, suspensions } from '../index.js';
import { garden, planted, row } from './garden.js';

/**
 * `seed:rose` now holds `rose-2`. `bud` was grafted from `rose-1`, and `bloom` was drawn from `bud`,
 * so a graft left on `rose-1` suspends both.
 */
function grafted(pin: string) {
  return planted({
    assets: [
      row('rose-1', 'seed:rose'),
      row('rose-2', 'seed:rose', { current: true }),
      row('bud', 'sprout:r1', { current: true }),
      row('bloom', 'sprout:f1', { current: true, refs: ['bud'] }),
      row('fern', 'seed:fern', { current: true }),
    ],
    grafts: { bud: [{ pin, from: 'seed:rose' }] },
  });
}

describe('suspensions over a toy family', () => {
  it('says nothing while every graft still names its slot’s take', () => {
    expect(suspensions(garden, grafted('rose-2'))).toEqual([]);
  });

  it('carries a moved graft downstream, the moved row first', () => {
    const found = suspensions(garden, grafted('rose-1'));
    expect(found).toEqual([
      { hash: 'bud', reason: 'seed:rose moved from rose-1 to rose-2' },
      { hash: 'bloom', reason: 'it references bud, which is suspended', via: 'bud' },
    ]);
  });

  it('marks the slots whose take is suspended', () => {
    const solved = solve(garden, grafted('rose-1'));
    expect(solved.slots.get('sprout:r1')!.suspended).toBe(true);
    expect(solved.slots.get('sprout:f1')!.suspended).toBe(true);
    expect(solved.slots.get('seed:rose')!.suspended).toBe(false);
    expect(solve(garden, grafted('rose-2')).slots.get('sprout:r1')!.suspended).toBe(false);
  });

  it('does not walk the upstream of a row whose own graft moved', () => {
    const before = grafted('rose-1');
    const facts = {
      ...before,
      assets: before.assets!.map((a) => (a.hash === 'bud' ? { ...a, refs: ['fern'] } : a)),
      grafts: { ...before.grafts, fern: [{ pin: 'rose-1', from: 'seed:rose' }] },
    };
    // `bud` is suspended for its own graft, so the reason names that and no `via`
    const bud = suspensions(garden, facts).find((s) => s.hash === 'bud')!;
    expect(bud.via).toBeUndefined();
  });

  it('steps over a reference cycle already on disk instead of hanging on it', () => {
    const facts = planted({
      assets: [
        row('a', 'sprout:r1', { refs: ['b'] }),
        row('b', 'sprout:f1', { refs: ['a', 'moved'] }),
        row('moved', 'seed:rose'),
        row('now', 'seed:rose', { current: true }),
      ],
      grafts: { moved: [{ pin: 'gone', from: 'seed:rose' }] },
    });
    expect(suspensions(garden, facts).map((s) => s.hash)).toEqual(['moved', 'b', 'a']);
  });

  it('suspends nothing without a manifest', () => {
    expect(suspensions(garden, planted())).toEqual([]);
  });
});
