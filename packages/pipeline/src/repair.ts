/**
 * The take repair, the hold rule and the accept rule, re-exported for the scheduler and the CLI,
 * which may import the pipeline and not `@vn/artgen` or `@vn/stills`. They live in those two
 * packages because `vnauthor` runs them too.
 */
export {
  acceptTake,
  acceptableTakes,
  holdPortrait,
  migrateCurrent,
  repairCurrent,
  type Acceptable,
  type Migration,
  type TakeDeps,
} from '@vn/artgen';
export { heldBy } from '@vn/stills';
