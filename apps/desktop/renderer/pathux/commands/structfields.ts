/**
 * Closes an editor's nstructjs struct script, declaring its own per-pane fields inside it.
 *
 * `STRUCT.inherit` hands back an open script (the struct name, a brace, and the parent's fields)
 * which every caller in path.ux closes by appending `'\n}'`. An editor that remembers something of
 * its own declares it between the two, and CLAUDE.md forbids writing the struct by hand, so
 * `registerEditor` splices it in here.
 *
 * This module imports nothing from `pathux`, so the splice is testable in node against the real
 * nstructjs rather than only in a browser.
 */

/**
 * One field, in nstructjs's own declaration syntax: `mode : string`, `count : int`, `on : bool`,
 * or a computed form like `saved : string | obj.save()`. The trailing semicolon is optional.
 */
export type StructField = string;

/** Close an open struct script, declaring `fields` inside it. */
export function closeStruct(head: string, fields: readonly StructField[] = []): string {
  const declared = fields
    .map((field) => field.trim().replace(/;+$/, ''))
    .filter((field) => field !== '')
    .map((field) => `  ${field};`);
  return [head.replace(/\s+$/, ''), ...declared, '}'].join('\n');
}
