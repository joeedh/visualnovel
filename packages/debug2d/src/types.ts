/**
 * The neutral fragment IR (research §1). Everything above it — queries, explain,
 * invariants — is written once against these shapes and never learns which source
 * produced a fragment. The IR is *sufficient* for querying, not lossless: `raw` is the
 * typed escape hatch to the live Element / recorded op when the IR is not enough.
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
  /** DOM only: the *declared* z-index. Resolved paint order lives in `Fragment.z`. */
  zIndex?: number;
};

/**
 * Hit-testability, first-class — paint is not pick. `pointer-events`, hit slop, and
 * `opacity: 0` (clickable while invisible) all pull the two apart.
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

/** `by` matters: "clipped away **by `.rail`**" is the answer, not just the rect. */
export type ClipRef = { rect: Rect; by: FragId };

/**
 * The ancestor that established the stacking context scoping this fragment's z-index,
 * and why. Retained during the stacking walk (free there, unrecoverable later) — it is
 * the fact behind explainPick's "z-index 999 ignored" line.
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
  /** Escape hatch: the Element, the recorded op, the fiber. Never crosses CDP. */
  raw?: unknown;
};

/**
 * What a source can actually do — the abstraction stays honest by declaring caps rather
 * than degrading the IR to the weakest backend. A query a source cannot answer returns
 * `{ unsupported: [SourceId] }`, never zeros.
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
   * Load-bearing: canvas frames are *recorded* (fragments are exactly what was drawn);
   * DOM frames are *sampled* (anything that changed and reverted between captures is
   * invisible). Never let a consumer forget which one they hold.
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
