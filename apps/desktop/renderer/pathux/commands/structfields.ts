/**
 * Finalizes an editor's `nstructjs` definition by injecting its pane-specific fields.
 *
 * `STRUCT.inherit` returns an open struct definition (header, opening brace, and parent
 * fields) normally closed by appending `'\n}'`. Because project guidelines forbid writing
 * the full struct definition by hand, `registerEditor` splices the editor's custom fields
 * into that gap before sealing the block.
 *
 * Free of `pathux` imports so this splicing logic can be unit tested in Node directly
 * against `nstructjs` without a browser environment.
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
