/**
 * Decomposition's prompt-and-parse lives in `@vn/stills`' `storyboard.ts`: it is generative
 * policy with no pipeline dependency, and the authoring agent (which may not import the
 * pipeline) needs the same call for `propose_storyboard`. Re-exported here so the pipeline's
 * surface is unchanged; `decomposeAll` and its persistence rules stay in this package.
 */
export {
  shotId,
  deterministicShots,
  decomposeScene,
  decompSystem,
  storyboardStyle,
  withCoverage,
} from '@vn/stills';
export type { Decomposition, StoryboardStyle } from '@vn/stills';
