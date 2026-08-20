/**
 * Space registry (research §1-Spaces). `device` is the common root: every space registers
 * a labeled step chain toward it, and conversion composes through it. `chain()` returns
 * the labeled steps rather than the composed matrix so that the labels stay readable: a
 * double-applied DPI scale is invisible in a composed matrix and obvious in a chain.
 */
import type { Mat3, Rect } from './geom.js';
import { IDENTITY, applyToRect, invert, mul } from './geom.js';
import type { SpaceId, SpaceRegistry, TransformStep } from './types.js';

export type SpaceDef = {
  /** The space this step maps into; every chain must eventually reach `device`. */
  parent: SpaceId;
  label: string;
  /** A thunk re-reads live state (pan/zoom) at query time. */
  matrix: Mat3 | (() => Mat3);
};

type Ancestry = {
  /** spaces[0] is the space itself, spaces[n] is 'device'; steps[i] maps [i] → [i+1]. */
  spaces: SpaceId[];
  steps: TransformStep[];
};

export function createSpaceRegistry(defs: Partial<Record<SpaceId, SpaceDef>>): SpaceRegistry {
  function ancestry(space: SpaceId): Ancestry | null {
    const spaces: SpaceId[] = [space];
    const steps: TransformStep[] = [];
    let cur = space;
    while (cur !== 'device') {
      const def = defs[cur];
      if (!def || spaces.includes(def.parent)) return null;
      const matrix = typeof def.matrix === 'function' ? def.matrix() : def.matrix;
      steps.push({ label: def.label, matrix });
      cur = def.parent;
      spaces.push(cur);
    }
    return { spaces, steps };
  }

  function chain(from: SpaceId, to: SpaceId): TransformStep[] | null {
    const a = ancestry(from);
    const b = ancestry(to);
    if (!a || !b) return null;
    // Meet at the lowest common ancestor so css → world:x does not detour past it.
    let ai = 0;
    let bi = -1;
    for (const [i, s] of a.spaces.entries()) {
      const j = b.spaces.indexOf(s);
      if (j >= 0) {
        ai = i;
        bi = j;
        break;
      }
    }
    const steps = a.steps.slice(0, ai);
    for (const step of b.steps.slice(0, bi).reverse()) {
      const m = invert(step.matrix);
      if (!m) return null;
      steps.push({ label: `${step.label}⁻¹`, matrix: m });
    }
    return steps;
  }

  function transform(from: SpaceId, to: SpaceId): Mat3 | null {
    const steps = chain(from, to);
    if (!steps) return null;
    // Steps apply in list order, so the composed product is last·…·first.
    return steps.reduce((acc, s) => mul(s.matrix, acc), IDENTITY);
  }

  return {
    transform,
    chain,
    convert(r: Rect, from: SpaceId, to: SpaceId): Rect {
      const m = transform(from, to);
      if (!m) throw new Error(`no transform from space '${from}' to '${to}'`);
      return applyToRect(m, r);
    },
  };
}
