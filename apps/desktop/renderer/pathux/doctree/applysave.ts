/**
 * What a sheet form's Apply answers runs: path.ux's own apply, which writes the answers into the
 * document as one undoable edit, and then the pane's save, the same one Ctrl+S runs. Imports
 * nothing from path.ux, so the order is tested under the node-only jest project.
 */

/** The tooltip on Apply answers, in place of path.ux's, which does not mention the save. */
export const APPLY_TIP =
  'Write the answers typed here into the document as one undoable edit, then save the document and commit it';

/**
 * Runs `apply`, then `save` when no answer is left pending. Answers the schema refused stay on the
 * form, with the reason on its status line, and nothing is saved.
 */
export async function applyAndSave(
  apply: () => Promise<void>,
  pending: () => boolean,
  save: () => Promise<unknown>,
): Promise<void> {
  await apply();
  if (!pending()) await save();
}
