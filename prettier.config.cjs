/**
 * Formatting config. The plan (§5) specifies a `@pathtx/prettier` fork; that package
 * is not published, so this uses upstream `prettier` with the same options. Swap the
 * dependency and this file keeps working — options are fork-compatible.
 */
module.exports = {
  printWidth: 100,
  singleQuote: true,
  trailingComma: 'all',
  semi: true,
};
