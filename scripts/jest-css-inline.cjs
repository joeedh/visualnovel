/**
 * Under jest, a `*.css?inline` import resolves to the empty string.
 *
 * vite turns that suffix into the sheet's text, which is how an editor adopts a sheet into its
 * shadow root. Nothing under test looks at the text. The jest desktop project is node-only, and
 * a stylesheet is verified live over CDP instead, so a module that resolves is the whole
 * requirement. Without this stub, a renderer module could not be imported by a test at all, and
 * pure logic would quietly get pushed out of the file it belongs in.
 */
module.exports = '';
