/**
 * The neutral fragment IR (research §1). Queries, explain and invariants are written once
 * against these shapes and do not depend on which source produced a fragment. The IR is
 * sufficient for querying but not lossless: `raw` gives typed access to the live Element or
 * recorded op when the IR is not enough.
 */
import type { Mat3, Rect, Vec2 } from './geom.js';

/** Unique within a frame, e.g. 'dom:14', 'canvas:218'. */
export type FragId = string;

export type SourceId = string;

export type SpaceId = 'device' | 'css' | `world:${string}`;

export type Color = string;

/** Canvas/SVG only; unused by the DOM adapter (caps.paths: false). */
export type PathData = string;

export type Shape =
  | { type: 'rect'; rect: Rect }
  | { type: 'rrect'; rect: Rect; radii: [number, number, number, number] }
  | { type: 'rects'; rects: Rect[] }
  | { type: 'poly'; points: Vec2[] }
  | { type: 'path'; path: PathData };

export type StyleSnapshot = {
  fill?: Color;
  stroke?: Color;
  lineWidth?: number;
  alpha: number;
  composite?: string;
  filter?: string;
  font?: { family: string; size: number; weight: number };
  /** For kind 'text'; truncated at capture (research §12). */
  text?: string;
  /** DOM only: the declared z-index. Resolved paint order lives in `Fragment.z`. */
  zIndex?: number;
};

/**
 * How a fragment is hit-tested, which is separate from how it is painted. `pointer-events`,
 * hit slop, and `opacity: 0` (clickable while invisible) each pull the two apart.
 */
export type PickSnapshot = {
  mode: 'auto' | 'none' | 'bounds' | 'painted';
  /** Extra hit radius, in `space` — wires and handles need it. */
  slop?: number;
  /** When the hit geometry differs from the drawn geometry, this is the pick authority. */
  shape?: Shape;
};

export type OwnerRef = {
  id: string;
  label: string;
  kind: string;
  parent?: string;
};

/** A clip rect together with the fragment that imposed it, so an explanation can name it. */
export type ClipRef = { rect: Rect; by: FragId };

/**
 * The ancestor that established the stacking context scoping this fragment's z-index, and the
 * reason it did. Recorded during the stacking walk because it costs nothing there and cannot be
 * recovered afterwards; explainPick's "z-index 999 ignored" line reports it.
 */
export type ZContextRef = { by: FragId; byLabel: string; reason: string };

export type Fragment = {
  id: FragId;
  /** Resolved paint order within the frame, source-computed. See `SourceCaps.exactZ`. */
  z: number;
  kind: 'fill' | 'stroke' | 'text' | 'image' | 'box' | 'clip' | 'group';
  /** Axis-aligned, in `space`. */
  bounds: Rect;
  space: SpaceId;
  shape?: Shape;
  /** Resolved ancestor clips, in `space`, each attributed. */
  clip?: ClipRef[];
  style: StyleSnapshot;
  pick: PickSnapshot;
  owner: OwnerRef;
  tags: string[];
  source: SourceId;
  zContext?: ZContextRef;
  /** Capture site, when the source and tier support it. */
  stack?: string;
  /** Typed access to the live Element, the recorded op or the fiber. Never crosses CDP. */
  raw?: unknown;
};

/**
 * What a source can do. Each source declares its caps instead of the IR degrading to the
 * weakest backend, and a query a source cannot answer returns `{ unsupported: [SourceId] }`
 * rather than zeros.
 */
export type SourceCaps = {
  exactZ: boolean;
  paths: boolean;
  perFragmentStyle: boolean;
  overdraw: boolean;
  stacks: boolean;
  continuous: boolean;
  /** The source can independently verify its own pick order (DOM: elementsFromPoint). */
  hitOracle: boolean;
};

export type TransformStep = { label: string; matrix: Mat3; by?: FragId };

/** Registry of coordinate spaces; conversion is explicit and labeled, never implicit. */
export interface SpaceRegistry {
  /** Composed matrix, or `null` for an unknown space — never a silent identity. */
  transform(from: SpaceId, to: SpaceId): Mat3 | null;
  /** Throws on an unknown space; use `transform` to probe. */
  convert(r: Rect, from: SpaceId, to: SpaceId): Rect;
  /** The labeled step list — what explainTransform narrates. `null` when unreachable. */
  chain(from: SpaceId, to: SpaceId): TransformStep[] | null;
}

/** The browser's actual hit order at `point`, captured for cross-checking (DOM only). */
export type OracleSample = { point: Vec2; ids: FragId[] };

export type Frame = {
  index: number;
  /** ms, monotonic. */
  t: number;
  /** Globally z-ordered across all sources (descending queries sort themselves). */
  fragments: Fragment[];
  spaces: SpaceRegistry;
  caps: Record<SourceId, SourceCaps>;
  /**
   * Canvas frames are recorded, so their fragments are exactly what was drawn. DOM frames are
   * sampled, so a change that reverted between two captures is invisible. A consumer has to
   * check which kind it holds.
   */
  fidelity: 'recorded' | 'sampled' | 'mixed';
  oracle?: OracleSample;
};

export type CaptureOpts = {
  /** Sample the source's hit oracle at this point during capture (caps.hitOracle only). */
  oracleAt?: Vec2;
};

export interface FrameSource {
  readonly id: SourceId;
  readonly caps: SourceCaps;
  capture(opts?: CaptureOpts): Frame;
  /** Registered into the frame's space registry; `null` when the source has no opinion. */
  spaceTransform(from: SpaceId, to: SpaceId): Mat3 | null;
}
