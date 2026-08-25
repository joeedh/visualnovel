/**
 * The half of `@vn/gengraph` that reaches the filesystem: where a project keeps its
 * graphs, the journal a run appends to, the blobs a node writes, and the hashes both are
 * keyed by. The executor is here as well: it writes no files itself, but it hashes every
 * node through `@vn/util`, which reaches `node:crypto`.
 * It is a second entry point rather than part of the package's main one
 * because the desktop renderer imports that one and has no `node:` modules, following
 * the split `@vn/scriptedit` and `@vn/scriptedit/write` already make.
 */
export * from './execute.js';
export * from './paths.js';
export * from './document.js';
export * from './hash.js';
export * from './journalfile.js';
export * from './blobs.js';
export * from './drift.js';
export * from './pluginload.js';
export * from './pricestore.js';
// The manifest is re-exported here as well as from the main entry, because a host that
// installs a plugin reads its manifest and never touches the rest of the browser-side API.
export * from './manifest.js';
