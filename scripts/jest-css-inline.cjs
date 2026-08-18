/**
 * What a `*.css?inline` import is under jest: the empty string.
 *
 * vite turns that suffix into the sheet's text, which is how an editor adopts a sheet into its
 * shadow root. Nothing under test looks at the text — the jest desktop project is node-only, and
 * a stylesheet is verified live over CDP — so a module that resolves is the whole requirement.
 * Without it a renderer module cannot be imported by a test at all, which would quietly push pure
 * logic out of the file it belongs in.
 */
module.exports = '';
