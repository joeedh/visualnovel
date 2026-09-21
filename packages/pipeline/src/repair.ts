/**
 * The take repair and the hold rule, re-exported for the scheduler and the CLI, which may import
 * the pipeline and not `@vn/artgen`. They live in `@vn/artgen` because `vnauthor` runs them too.
 */
export { heldBy, migrateCurrent, repairCurrent, type Migration, type TakeDeps } from '@vn/artgen';
