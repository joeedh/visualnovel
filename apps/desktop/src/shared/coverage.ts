/**
 * Superseded: the coverage rules and geometry live in `@vn/scriptedit` (`coverage.ts`), where
 * both hosts — this app and the authoring agent — run the same decisions. This file re-exports
 * them, plus this app's specializations of the generic geometry over its own rich projections
 * (`CoverageLine`/`CoverageShot` from `ipc.ts`), so existing annotations keep compiling. It goes
 * away when the importers switch to the package directly.
 */
import type {
  Coverage as PkgCoverage,
  CoverageRow as PkgCoverageRow,
  ShotSpan as PkgShotSpan,
} from '@vn/scriptedit';
import type { CoverageLine, CoverageShot } from './ipc.js';

export {
  range,
  resolveDrag,
  runsOf,
  setCoverage,
  spansFor,
  type CoverLine,
  type CoverShot,
  type CoverageOp,
  type Edge,
  type Segment,
} from '@vn/scriptedit';

export type Coverage = PkgCoverage<CoverageLine, CoverageShot>;
export type CoverageRow = PkgCoverageRow<CoverageLine>;
export type ShotSpan = PkgShotSpan<CoverageShot>;
