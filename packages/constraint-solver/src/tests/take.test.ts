/**
 * The take over the toy family: which row a slot holds, the order its rows are listed in, what the
 * log says the take is, and which row a slot holding two current rows keeps. Nothing here names a
 * real family's slots.
 */
import type { AnyTask } from '@vn/types';
import { makeTask } from '@vn/taskgraph';
import { lastRenderedAt, loggedTake, newestFirst, overHeld, pick, solve } from '../index.js';
import { garden, log, planted, row, seedInputs } from './garden.js';

describe('pick', () => {
  it('answers the one current row, declines two, and falls back to an only row', () => {
    expect(pick([row('a', 'seed:rose'), row('b', 'seed:rose', { current: true })])).toBe('b');
    expect(
      pick([row('a', 'seed:rose', { current: true }), row('b', 'seed:rose', { current: true })]),
    ).toBeUndefined();
    expect(pick([row('a', 'seed:rose')])).toBe('a');
    expect(pick([row('a', 'seed:rose'), row('b', 'seed:rose')])).toBeUndefined();
    expect(pick([])).toBeUndefined();
  });

  it('never reads `accepted`', () => {
    const rows = [
      row('a', 'seed:rose', { accepted: true }),
      row('b', 'seed:rose', { current: true }),
    ];
    expect(pick(rows)).toBe('b');
  });

  it('is the take `solve` reports for every slot', () => {
    const assets = [
      row('a', 'seed:rose', { current: true }),
      row('b', 'seed:rose', { current: true }),
      row('c', 'sprout:r1'),
    ];
    const solved = solve(garden, planted({ assets }));
    expect(solved.slots.get('seed:rose')!.pick).toBeUndefined();
    expect(solved.slots.get('sprout:r1')!.pick).toBe('c');
  });
});

describe('newestFirst', () => {
  it('orders by `at` descending, unstamped rows last in hash order', () => {
    const rows = [
      row('c', 'seed:rose'),
      row('a', 'seed:rose', { at: '2026-01-01T00:00:00.000Z' }),
      row('b', 'seed:rose'),
      row('d', 'seed:rose', { at: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(newestFirst(rows).map((r) => r.hash)).toEqual(['d', 'a', 'b', 'c']);
  });
});

describe('loggedTake', () => {
  const task = makeTask('prompt_refine', seedInputs('rose'));

  it("answers a done task's output and a needs_human task's last output", () => {
    expect(loggedTake({ ...task, status: 'done', output: 'x' })).toBe('x');
    const flawed: AnyTask = {
      ...task,
      status  : 'needs_human',
      attempts: [{ output: 'first' }, { output: 'last' }] as AnyTask['attempts'],
    };
    expect(loggedTake(flawed)).toBe('last');
    expect(loggedTake({ ...flawed, output: 'chosen' })).toBe('chosen');
  });

  it('leaves the row authoritative for any other status', () => {
    for (const status of ['pending', 'running', 'failed'] as const)
      expect(loggedTake({ ...task, status, output: 'x' })).toBeUndefined();
    expect(loggedTake(undefined)).toBeUndefined();
  });
});

describe('lastRenderedAt', () => {
  it('answers the latest attempt stamp, or nothing for an unstamped task', () => {
    const tasks = {
      get: (hash: string) =>
        hash === 'stamped'
          ? { attempts: [{ at: '2026-01-02' }, { at: '2026-01-05' }, {}] }
          : hash === 'bare'
            ? { attempts: [{}] }
            : undefined,
    };
    const at = lastRenderedAt(tasks);
    expect(at('stamped')).toBe('2026-01-05');
    expect(at('bare')).toBeUndefined();
    expect(at('missing')).toBeUndefined();
  });
});

describe('overHeld over a toy family', () => {
  const rose = makeTask('prompt_refine', seedInputs('rose'));

  it('lists nothing while every slot holds at most one current row', () => {
    const assets = [row('a', 'seed:rose', { current: true }), row('b', 'seed:rose')];
    expect(overHeld(garden, planted({ assets }))).toEqual([]);
  });

  it('keeps a row the kind names first', () => {
    const assets = [
      row('s1', 'sprout:r1', { current: true, at: '2026-02-01' }),
      row('s2', 'sprout:r1', { current: true }),
    ];
    expect(overHeld(garden, planted({ assets, notebook: ['s2'] }))).toEqual([
      { slot: 'sprout:r1', keep: 's2', drop: ['s1'] },
    ]);
  });

  it("keeps the identity's logged take next, resolved over the identity facts", () => {
    const assets = [
      row('a', 'seed:rose', { current: true, at: '2026-02-01' }),
      row('b', 'seed:rose', { current: true }),
    ];
    const tasks = log({ ...rose, status: 'done', output: 'b' });
    expect(overHeld(garden, planted({ assets, tasks }))).toEqual([
      { slot: 'seed:rose', keep: 'b', drop: ['a'] },
    ]);
    // The rows come from the first facts and the identity from the second
    expect(overHeld(garden, planted({ assets }), planted({ tasks }))).toEqual([
      { slot: 'seed:rose', keep: 'b', drop: ['a'] },
    ]);
  });

  it('keeps the most recently held row next, then the lowest hash', () => {
    const assets = [
      row('a', 'seed:rose', { current: true, at: '2026-01-01' }),
      row('b', 'seed:rose', { current: true }),
      row('z', 'seed:fern', { current: true }),
      row('y', 'seed:fern', { current: true }),
    ];
    expect(overHeld(garden, planted({ assets }))).toEqual([
      { slot: 'seed:rose', keep: 'a', drop: ['b'] },
      { slot: 'seed:fern', keep: 'y', drop: ['z'] },
    ]);
  });

  it('repairs a slot the family does not enumerate', () => {
    const assets = [
      row('a', 'seed:moss', { current: true }),
      row('b', 'seed:moss', { current: true }),
    ];
    expect(overHeld(garden, planted({ assets }))).toEqual([
      { slot: 'seed:moss', keep: 'a', drop: ['b'] },
    ]);
  });
});
