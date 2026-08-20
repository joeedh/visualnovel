/**
 * Frame assembly plus `makeTestFrame()`. The synthetic-frame builder is deliberately part
 * of the exported surface: this package's own tests use it, future invariants run over it
 * headlessly, and downstream tests need it too (research §13).
 */
import { IDENTITY, type Rect } from './geom.js';
import { createSpaceRegistry } from './spaces.js';
import type {
  Fragment,
  Frame,
  FrameSource,
  OracleSample,
  SourceCaps,
  SourceId,
  SpaceRegistry,
} from './types.js';

export type AssembleOpts = {
  index?: number;
  t?: number;
  fragments: Fragment[];
  spaces: SpaceRegistry;
  caps: Record<SourceId, SourceCaps>;
  fidelity: Frame['fidelity'];
  oracle?: OracleSample;
};

/** Assemble a frame; fragments are stored in ascending paint order (stable sort). */
export function assembleFrame(opts: AssembleOpts): Frame {
  return {
    index: opts.index ?? 0,
    t: opts.t ?? 0,
    fragments: [...opts.fragments].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id)),
    spaces: opts.spaces,
    caps: opts.caps,
    fidelity: opts.fidelity,
    oracle: opts.oracle,
  };
}

/** Everything but `id` and `bounds` defaults sensibly; `z` defaults to array position. */
export type TestFragment = Partial<Fragment> & { id: string; bounds: Rect };

export const TEST_CAPS: SourceCaps = {
  exactZ: true,
  paths: false,
  perFragmentStyle: true,
  overdraw: false,
  stacks: false,
  continuous: false,
  hitOracle: false,
};

export type TestFrameOpts = {
  spaces?: SpaceRegistry;
  caps?: Record<SourceId, SourceCaps>;
  fidelity?: Frame['fidelity'];
  oracle?: OracleSample;
};

/** Wrap a fixed frame as a FrameSource — how tests feed synthetic frames to the engine. */
export function staticSource(frame: Frame, id: SourceId = 'test'): FrameSource {
  return {
    id,
    caps: frame.caps[id] ?? TEST_CAPS,
    capture: () => frame,
    spaceTransform: () => null,
  };
}

export function makeTestFrame(frags: TestFragment[], opts: TestFrameOpts = {}): Frame {
  const fragments = frags.map<Fragment>((f, i) => ({
    kind: 'box',
    space: 'css',
    style: { alpha: 1 },
    pick: { mode: 'auto' },
    owner: { id: f.id, label: f.id, kind: 'element' },
    tags: [],
    source: 'test',
    z: i,
    ...f,
  }));
  return assembleFrame({
    fragments,
    spaces:
      opts.spaces ??
      createSpaceRegistry({
        css: { parent: 'device', label: 'devicePixelRatio', matrix: IDENTITY },
      }),
    caps: opts.caps ?? { test: TEST_CAPS },
    fidelity: opts.fidelity ?? 'recorded',
    oracle: opts.oracle,
  });
}
