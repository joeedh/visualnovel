/**
 * What a restored selection is worth once the project has answered for it. A saved id can name a
 * scene the author has since deleted, a character renamed in git, or an asset a re-render has
 * replaced, so restore paints the saved value and then asks.
 *
 * Nothing here calls a command or reads the DOM. The caller runs `asset.info`, fetches the
 * workspace index, and compares the answers against what restore wrote, so a value the author
 * clicked in between is left alone.
 */

/** `asset.info`'s answer, narrowed to the two fields the repair reads. */
export interface AssetAnswer {
  ok: boolean;
  /** `AssetInfo.newerTake`: the asset filling this one's slot now, absent while this one does. */
  newerTake?: string;
}

/**
 * The hash the asset selection should hold. An answer that failed means the manifest no longer
 * has these bytes, so the selection is cleared; a superseded take moves to the one that replaced
 * it, which is what a re-render between two launches produces.
 */
export function repairedAsset(restored: string, answer: AssetAnswer): string {
  if (!answer.ok) return '';
  return answer.newerTake ?? restored;
}

/** The restored ids a prune reads, and the shape it clears fields in. */
export interface SelectedIds {
  sceneId: string;
  shotId: string;
  characterId: string;
}

/** What the workspace index says the project holds, narrowed to the two checkable lists. */
export interface IndexedIds {
  scenes: { id: string }[];
  characters: { id: string }[];
}

/**
 * The fields of `restored` that name something the index does not list, each mapped to the empty
 * string. `docPath` is deliberately absent: the doc tree caps a branch and has a second file-tree
 * mode, so a path missing from a fetched tree is not evidence the file is gone.
 *
 * A shot is cleared with its scene and not otherwise. Shots are per scene and are not fetched at
 * boot, and the coverage editor already draws nothing for one it cannot find.
 */
export function prunedIds(restored: SelectedIds, index: IndexedIds): Partial<SelectedIds> {
  const out: Partial<SelectedIds> = {};
  if (restored.sceneId !== '' && !index.scenes.some((s) => s.id === restored.sceneId)) {
    out.sceneId = '';
    if (restored.shotId !== '') out.shotId = '';
  }
  if (restored.characterId !== '' && !index.characters.some((c) => c.id === restored.characterId)) {
    out.characterId = '';
  }
  return out;
}
