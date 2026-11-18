/** One scene's storyboard as a unit: its shots and the staging-sheet groups they name. */
import type { Shot } from './shots.js';

/** The most cells one staging sheet carries; a longer group is the author's to split. */
export const MAX_SHEET_CELLS = 8;

/** One staging-sheet group's own settings: the seed the whole sheet is drawn with, and notes. */
export interface SheetGroup {
  /** Rerolling the sheet is bumping this, which re-keys every member shot at once. */
  seed?: number;
  /** Words about the group for the sheet prompt, such as what stays fixed across it. */
  notes?: string;
}

/** One scene's storyboard, as `work/shots/<sceneId>.json` holds it. */
export interface ProductionData {
  shots: Shot[];
  /**
   * The staging-sheet groups by id. A shot's {@link Shot.sheet} names one; a group a shot names
   * but this map lacks takes the defaults. Absent until a shot names one.
   */
  sheets?: Record<string, SheetGroup>;
}
