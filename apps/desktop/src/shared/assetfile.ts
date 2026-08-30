/**
 * What a copy of a generated picture is called once it leaves the app.
 *
 * Its own module because the name is a rule rather than markup: the label an asset carries is
 * written for a pane and may hold anything a person typed, while a filename has characters no
 * filesystem will take.
 */

/** Characters Windows refuses in a filename, plus the control range every filesystem refuses. */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]+/g;

/** Names Windows reserves whatever the extension, which a label could land on by accident. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** How long a name may get before it is cut. Well inside every path limit, with room for a folder. */
const LONGEST = 80;

/**
 * The filename a downloaded asset opens the save dialog with — its label, made safe, plus its
 * extension. Falls back to the short hash for a label that survives none of this, so the dialog is
 * never handed an empty name.
 */
export function downloadName(label: string, hash: string, ext: string): string {
  const safe = label
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    // A trailing dot or space is legal to write and then impossible to open on Windows
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, LONGEST)
    .replace(/[\s.]+$/, '');
  const stem = safe === '' || RESERVED.test(safe) ? hash.slice(0, 8) : safe;
  return `${stem}.${ext}`;
}
