/**
 * Prompt composition moved to `@vn/stills` so the input side can reach it — `vnauthor` cannot
 * import this package, and a concept image still has to be composed the way a plate is. The
 * re-export names each symbol rather than using `*`, so this module still exports exactly the
 * prompt builders.
 */
export { suspendedAssets, type Suspension } from '@vn/artgen';
export {
  MODEL_SHEET_ANGLES,
  SHEET_FRONT,
  imageParams,
  stylePreamble,
  buildPortraitPrompt,
  buildLocationPrompt,
  buildModelSheetPrompt,
  buildShotPrompt,
  shotSpec,
  portraitRefs,
  portraitInputs,
  locationRefs,
  locationInputs,
  locationTask,
  modelSheetRefs,
  modelSheetInputs,
  shotRefs,
  shotInputs,
} from '@vn/stills';
