/**
 * The documents one Wiki pane has shown, most recent first, which its Ctrl+Tab switcher cycles
 * through. Kept in the pane's memory like the Raw switch, so a restart starts the list empty.
 */
import { remapPath, type FileMove } from '../../../src/shared/fileops.js';

/** How many documents the list keeps; the oldest falls off the end. */
export const RECENT_LIMIT = 12;

export class RecentPages {
  private list: string[] = [];

  constructor(private readonly limit = RECENT_LIMIT) {}

  /** The paths, most recent first. The first is the document on screen once one has been shown. */
  get paths(): readonly string[] {
    return this.list;
  }

  /** Moves `path` to the front of the list, adding a path the list lacks; ignores the empty path. */
  visit(path: string): void {
    if (path === '' || this.list[0] === path) return;
    this.list = [path, ...this.list.filter((p) => p !== path)].slice(0, this.limit);
  }

  /** Follows renames and folder moves, keeping each document's place in the order. */
  moved(moves: readonly FileMove[]): void {
    const seen = new Set<string>();
    this.list = this.list
      .map((path) => remapPath(path, moves))
      .filter((path) => !seen.has(path) && seen.add(path));
  }

  /** Drops a document that could not be opened again. */
  forget(path: string): void {
    this.list = this.list.filter((p) => p !== path);
  }
}

/** The row `by` steps from `index` lands on, wrapping at either end of `count` rows. */
export function stepRow(index: number, by: number, count: number): number {
  if (count === 0) return 0;
  return (((index + by) % count) + count) % count;
}
