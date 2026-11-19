/**
 * The keep set over the toy family, whose `kept` adds dormant seeds to the slots it enumerates.
 */
import { makeTask } from '@vn/taskgraph';
import { keepSet, solve } from '../index.js';
import { garden, log, planted, seedInputs } from './garden.js';

describe('keepSet over a toy family', () => {
  const rose = makeTask('prompt_refine', seedInputs('rose'));
  const moss = makeTask('prompt_refine', seedInputs('moss'));

  it('lists every slot the family keeps, wider than the ones it enumerates', () => {
    const facts = planted({ dormant: ['moss'] });
    expect([...keepSet(garden, facts).slots]).toEqual([
      'seed:rose',
      'seed:fern',
      'sprout:r1',
      'sprout:f1',
      'seed:moss',
    ]);
    expect(solve(garden, facts).slots.has('seed:moss')).toBe(false);
  });

  it('carries the task hash of every kept slot that states one, and only those', () => {
    // A dormant seed is not planted, so its kind states no identity for it
    const kept = keepSet(garden, planted({ dormant: ['moss'] }));
    expect(kept.tasks.has(rose.hash)).toBe(true);
    expect(kept.tasks.has(moss.hash)).toBe(false);
    // The sprouts' seeds have not grown, so the sprouts state none either
    expect(kept.tasks.size).toBe(2);
  });

  it("keeps every output the log records for a kept slot's task, attempts included", () => {
    const tasks = log({
      ...rose,
      status  : 'done',
      output  : 'petal',
      attempts: [{ output: 'bud' }, { output: 'petal' }] as typeof rose.attempts,
    });
    expect([...keepSet(garden, planted({ tasks })).outputs].sort()).toEqual(['bud', 'petal']);
  });

  it('lists a slot the family keeps twice once', () => {
    const facts = planted({ dormant: ['rose'] });
    expect([...keepSet(garden, facts).slots].filter((k) => k === 'seed:rose')).toHaveLength(1);
  });
});
