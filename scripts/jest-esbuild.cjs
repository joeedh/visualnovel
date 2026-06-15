/**
 * Thin esbuild transform for jest (plan §5): transpile TS+ESM to CJS per-file so the
 * test transpile matches the bundler. No type-checking happens here — `tsgo` owns
 * types. esbuild ships a CJS entry, so a plain require works.
 */
const { transformSync } = require('esbuild');

module.exports = {
  process(source, filename) {
    const result = transformSync(source, {
      loader: filename.endsWith('.tsx') ? 'tsx' : 'ts',
      format: 'cjs',
      target: 'node20',
      sourcemap: 'inline',
      sourcefile: filename,
    });
    return { code: result.code, map: result.map };
  },
};
