/**
 * Tests `taskSlot` over the toy family in `garden.ts`. It checks which kind a task's kind names,
 * and what that kind's `fromInputs` reads back out of the task's inputs.
 */
import type { AnyTask } from '@vn/types';
import { makeTask } from '@vn/taskgraph';
import { taskSlot, type Family, type SlotKind } from '../index.js';
import {
  garden,
  planted,
  seedInputs,
  seedKind,
  SEED_TASK,
  sproutInputs,
  sproutKind,
  SPROUT_TASK,
  type Garden,
} from './garden.js';

/** Builds a record of `kind`, retired kinds included, with the inputs given. */
const record = (kind: string, inputs: object): AnyTask =>
  ({
    hash: `h-${kind}`,
    kind,
    deps: [],
    inputs,
    status  : 'done',
    attempts: [],
  }) as unknown as AnyTask;

describe('taskSlot', () => {
  it("answers the kind that fills the task's kind and the binding its inputs name", () => {
    expect(taskSlot(garden, makeTask(SEED_TASK, seedInputs('rose')), planted())).toEqual({
      kind   : seedKind,
      binding: { id: 'rose' },
    });
    const sprout = makeTask(SPROUT_TASK, sproutInputs('petal', 'r1'));
    expect(taskSlot(garden, sprout, planted())).toEqual({
      kind   : sproutKind,
      binding: { id: 'r1' },
    });
  });

  it('answers no slot for a kind no slot kind fills, or inputs that name no binding', () => {
    expect(taskSlot(garden, record('shot_image', { shotId: 's1' }), planted())).toBeUndefined();
    expect(taskSlot(garden, record(SEED_TASK, { prompt: '' }), planted())).toBeUndefined();
  });

  it('reads a record of a kind another kind lists as retired through that kind', () => {
    const keeper = { ...seedKind, retired: ['outfit_sheet'] };
    const kept: Family<Garden> = { ...garden, kinds: [keeper, sproutKind] };
    const old = record('outfit_sheet', { characterId: 'rose' });
    expect(taskSlot(kept, old, planted())).toEqual({ kind: keeper, binding: { id: 'rose' } });
    expect(taskSlot(garden, old, planted())).toBeUndefined();
  });

  it('asks the first kind that claims the task, and carries no unit', () => {
    const shadow: SlotKind<Garden, { id: string }, typeof SEED_TASK> = {
      ...seedKind,
      prefix    : 'shadow',
      fromInputs: () => ({ id: 'shadow' }),
    };
    const both: Family<Garden> = { ...garden, kinds: [seedKind, shadow] };
    const found = taskSlot(both, makeTask(SEED_TASK, seedInputs('fern')), planted());
    expect(found).toEqual({ kind: seedKind, binding: { id: 'fern' } });
    expect(found).not.toHaveProperty('unit');
  });
});
