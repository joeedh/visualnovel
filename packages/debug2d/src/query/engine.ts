/**
 * `createDebugger()` — the query engine over one or more FrameSources (research §5).
 * Capture is pull-only: each top-level query samples a fresh composite frame. All query
 * logic is pure over that frame, so the same engine runs against `makeTestFrame()`
 * frames in jest and the live DOM in the renderer.
 */
import {
  IDENTITY,
  applyToPoint,
  applyToRect,
  containsPoint,
  containsRect,
  intersects,
  invert,
  rectCenter,
  type Mat3,
  type Rect,
} from '../geom.js';
import { assembleFrame } from '../frame.js';
import { createSpaceRegistry, type SpaceDef } from '../spaces.js';
import { explainPickFrame } from '../explain/explainPick.js';
import type {
  CaptureOpts,
  Fragment,
  Frame,
  FrameSource,
  SourceId,
  SpaceId,
  SpaceRegistry,
} from '../types.js';
import { hitsPoint, type Using } from './hit.js';
import { ResultSet } from './resultset.js';

export type DebuggerOpts = {
  sources: FrameSource[];
  /** Extra spaces beyond what sources provide, e.g. a future `world:graph` pan/zoom. */
  spaces?: Partial<Record<SpaceId, SpaceDef>>;
};

export type AtOpts = { space?: SpaceId; using?: Using };
export type AABBMode = 'intersect' | 'contain' | 'center';
export type AABBOpts = { space?: SpaceId; mode?: AABBMode };

// Lazy per-frame index (research §12): nothing is built until the first spatial query
// against a frame, then cached. A by-space grouping is enough at first-slice counts —
// the laziness seam matters more than the structure behind it.
const indexCache = new WeakMap<Frame, Map<SpaceId, Fragment[]>>();

function spatialIndex(frame: Frame): Map<SpaceId, Fragment[]> {
  let index = indexCache.get(frame);
  if (!index) {
    index = new Map();
    for (const f of frame.fragments) {
      const list = index.get(f.space);
      if (list) list.push(f);
      else index.set(f.space, [f]);
    }
    indexCache.set(frame, index);
  }
  return index;
}

/**
 * Run `test` against every fragment, converting the query geometry into each fragment's
 * space. A source whose fragments live in a space the registry cannot reach is reported
 * in `unsupported` — never silently dropped as zero results.
 */
function spatialQuery(
  frame: Frame,
  space: SpaceId,
  desc: string,
  test: (f: Fragment, toFragSpace: Mat3) => boolean,
): ResultSet {
  const hits: Fragment[] = [];
  const unsupported = new Set<SourceId>();
  for (const [fragSpace, frags] of spatialIndex(frame)) {
    const m = frame.spaces.transform(space, fragSpace);
    if (!m) {
      for (const f of frags) unsupported.add(f.source);
      continue;
    }
    for (const f of frags) if (test(f, m)) hits.push(f);
  }
  return new ResultSet(frame, hits, desc, [...unsupported].sort());
}

export interface Debugger2D {
  capture(opts?: CaptureOpts): Frame;
  at(x: number, y: number, opts?: AtOpts): ResultSet;
  inAABB(rect: Rect, opts?: AABBOpts): ResultSet;
  byOwner(id: string): ResultSet;
  byTag(tag: string): ResultSet;
  bySource(id: SourceId): ResultSet;
  where(pred: (f: Fragment) => boolean): ResultSet;
  owners(): ReturnType<ResultSet['owners']>;
  explainPick(x: number, y: number, opts?: { space?: SpaceId }): string;
}

export function createDebugger(opts: DebuggerOpts): Debugger2D {
  let captureIndex = 0;

  function buildRegistry(): SpaceRegistry {
    const defs: Partial<Record<SpaceId, SpaceDef>> = {};
    for (const source of opts.sources) {
      const m = source.spaceTransform('css', 'device');
      if (m && !defs.css) defs.css = { parent: 'device', label: 'devicePixelRatio', matrix: m };
    }
    if (!defs.css) defs.css = { parent: 'device', label: 'devicePixelRatio', matrix: IDENTITY };
    return createSpaceRegistry({ ...defs, ...opts.spaces });
  }

  function capture(copts?: CaptureOpts): Frame {
    const parts = opts.sources.map((s) => s.capture(copts));
    // Pre-splicing (M6), sources stack in registration order: each part's z values are
    // offset past the previous part's so the global order stays total.
    const fragments: Fragment[] = [];
    let zBase = 0;
    for (const part of parts) {
      let max = zBase;
      for (const f of part.fragments) {
        const z = zBase + f.z;
        fragments.push(f.z === z ? f : { ...f, z });
        max = Math.max(max, z + 1);
      }
      zBase = max;
    }
    const fidelities = new Set(parts.map((p) => p.fidelity));
    return assembleFrame({
      index: captureIndex++,
      t: parts.length ? Math.max(...parts.map((p) => p.t)) : 0,
      fragments,
      spaces: buildRegistry(),
      caps: Object.fromEntries(opts.sources.map((s) => [s.id, s.caps])),
      fidelity: fidelities.size === 1 ? [...fidelities][0]! : parts.length ? 'mixed' : 'sampled',
      oracle: parts.find((p) => p.oracle)?.oracle,
    });
  }

  function filtered(desc: string, pred: (f: Fragment) => boolean): ResultSet {
    const frame = capture();
    return new ResultSet(frame, frame.fragments.filter(pred), desc);
  }

  return {
    capture,

    at(x, y, atOpts = {}) {
      const space = atOpts.space ?? 'css';
      const using = atOpts.using ?? 'pick';
      const frame = capture();
      const desc = `at(${x}, ${y}) ${space}${using === 'paint' ? " using 'paint'" : ''}`;
      return spatialQuery(frame, space, desc, (f, m) =>
        hitsPoint(f, applyToPoint(m, { x, y }), using),
      );
    },

    inAABB(rect, aabbOpts = {}) {
      const space = aabbOpts.space ?? 'css';
      const mode = aabbOpts.mode ?? 'intersect';
      const frame = capture();
      const desc = `inAABB(${rect.x},${rect.y} ${rect.w}x${rect.h}, '${mode}') ${space}`;
      return spatialQuery(frame, space, desc, (f, m) => {
        // Convert the fragment's bounds into query space, where the AABB test runs.
        const inv = invert(m);
        if (!inv) return false;
        const inQuery = applyToRect(inv, f.bounds);
        if (mode === 'contain') return containsRect(rect, inQuery);
        if (mode === 'center') return containsPoint(rect, rectCenter(inQuery));
        return intersects(rect, inQuery);
      });
    },

    byOwner: (id) => filtered(`byOwner('${id}')`, (f) => f.owner.id === id),
    byTag: (tag) => filtered(`byTag('${tag}')`, (f) => f.tags.includes(tag)),
    bySource: (id) => filtered(`bySource('${id}')`, (f) => f.source === id),
    where: (pred) => filtered('where(…)', pred),
    owners: () => filtered('owners()', () => true).owners(),

    explainPick(x, y, pOpts = {}) {
      const frame = capture({ oracleAt: { x, y } });
      return explainPickFrame(frame, { x, y }, pOpts.space ?? 'css');
    },
  };
}
