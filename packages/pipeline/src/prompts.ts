/**
 * Prompt composition moved to `@vn/artgen` so the input side can reach it — `vnauthor` cannot
 * import this package, and a concept image still has to be composed the way a plate is. Re-exported
 * by name (not `*`) so this module keeps meaning exactly what it meant: the prompt builders.
 */
export {
  imageParams,
  stylePreamble,
  buildPortraitPrompt,
  buildLocationPrompt,
  buildModelSheetPrompt,
  buildShotPrompt,
  shotSpec,
} from '@vn/artgen';
