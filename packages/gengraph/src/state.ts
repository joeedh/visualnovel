/**
 * The half of `@vn/gengraph` that reaches the filesystem: where a project keeps its
 * graphs, the journal a run appends to, the blobs a node writes, and the hashes both are
 * keyed by. It is a second entry point rather than part of the package's main one
 * because the desktop renderer imports that one and has no `node:` modules, following
 * the split `@vn/scriptedit` and `@vn/scriptedit/write` already make.
 */
export * from './paths.js';
export * from './hash.js';
export * from './journalfile.js';
export * from './blobs.js';
export * from './drift.js';
