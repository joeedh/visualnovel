/**
 * The take repair, the hold rule and the accept rule, re-exported for the scheduler and the CLI,
 * which may import the pipeline and not `@vn/artgen`. They live in `@vn/artgen` because
 * `vnauthor` runs them too.
 */
export {
  acceptTake,
  acceptableTakes,
  heldBy,
  migrateCurrent,
  repairCurrent,
  type Acceptable,
  type Migration,
  type TakeDeps,
} from '@vn/artgen';
