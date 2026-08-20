/**
 * Decomposition's prompt-and-parse lives in `@vn/artgen`'s `storyboard.ts`: it is generative
 * policy with no pipeline dependency, and the authoring agent (which may not import the
 * pipeline) needs the same call for `propose_storyboard`. Re-exported here so the pipeline's
 * surface is unchanged; `decomposeAll` and its persistence rules stay in this package.
 */
export { shotId, deterministicShots, decomposeScene, withCoverage } from '@vn/artgen';
export type { Decomposition } from '@vn/artgen';
