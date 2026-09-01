/**
 * The props the document tree's own two writes read from the author rather than from the pane.
 *
 * There is no offer function here: neither act is ever refused by the pane. `doc.create` is offered
 * whenever a project is open and `doc.rename` only exists on a row that names a renamable document,
 * so main's own check is the only refusal either one has.
 */

/** The kind is chosen in the New row's dropdown, the name typed beside it. */
export const CREATE_SUPPLIES = ['kind', 'name'];

/** The new name, typed into the box that replaces the row's label. */
export const RENAME_SUPPLIES = ['name'];
