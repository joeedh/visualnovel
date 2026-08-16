/**
 * Prompt composition moved to `@vn/artgen` so the input side can reach it — `vnauthor` cannot
 * import this package, and a concept image still has to be composed the way a plate is. Re-exported
 * by name (not `*`) so this module keeps meaning exactly what it meant: the prompt builders.
 */
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
  suspendedAssets,
  type Suspension,
} from '@vn/artgen';
