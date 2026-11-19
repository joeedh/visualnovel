/**
 * Drift over the toy family: a kind's own reasons, and a bound graph's from its fact. Neither
 * moves a task hash; both are reported on the slot.
 */
import { pins } from '@vn/contracts';
import { boundDrift, graphsEditInvalidates, solve, type BoundGraphFact } from '../index.js';
import { garden, planted } from './garden.js';

describe(pins(graphsEditInvalidates), () => {
  describe('boundDrift', () => {
    const drawn = (authored?: string, recorded?: string): BoundGraphFact => ({
      node : 'out',
      drawn: true,
      ...(authored === undefined ? {} : { authored }),
      ...(recorded === undefined ? {} : { recorded }),
    });

    it('reports a drawn node whose authored hash moved since its last run', () => {
      expect(boundDrift(drawn('b', 'a'))?.source).toBe('graph');
      expect(boundDrift(drawn('a', 'a'))).toBeUndefined();
    });

    it('reports nothing for a run whose record predates authored hashes', () => {
      expect(boundDrift(drawn('a'))).toBeUndefined();
      expect(boundDrift(drawn(undefined, 'a'))).toBeUndefined();
    });

    it('reports a node that never ran only when the graph is not the default one', () => {
      expect(boundDrift({ node: 'out', drawn: false, isDefault: false })?.source).toBe('graph');
      expect(boundDrift({ node: 'out', drawn: false, isDefault: true })).toBeUndefined();
      expect(boundDrift({ node: 'out', drawn: false })).toBeUndefined();
    });
  });

  describe('drift on solved slots', () => {
    const edited: BoundGraphFact = { node: 'out', drawn: true, authored: 'b', recorded: 'a' };

    it("reports the kind's own reasons, then the bound graph's", () => {
      const solved = solve(
        garden,
        planted({ wilted: ['r1'], graphs: new Map([['sprout:r1', edited]]) }),
      );
      expect(solved.slots.get('sprout:r1')!.drift.map((d) => d.source)).toEqual(['wilt', 'graph']);
      expect(solved.slots.get('sprout:f1')!.drift).toEqual([]);
    });

    it('reads no graph drift from facts that carry no graphs', () => {
      const solved = solve(garden, planted());
      expect([...solved.slots.values()].every((s) => s.drift.length === 0)).toBe(true);
    });

    it('moves no task hash', () => {
      const before = solve(garden, planted()).slots.get('seed:rose')!.taskHash;
      const after = solve(garden, planted({ graphs: new Map([['seed:rose', edited]]) })).slots.get(
        'seed:rose',
      )!;
      expect(after.taskHash).toBe(before);
      expect(after.drift).toHaveLength(1);
    });
  });
});
