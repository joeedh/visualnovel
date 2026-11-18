/**
 * The stills family: slot addresses, the slot graph, the keep set, reference binding, prompt
 * composition, page layout, sheet planning, the storyboard decomposer and the portrait gate.
 *
 * Everything here is derived from the model, the manifest and the task log. Nothing reads or writes
 * the disk, and the two model calls (`decomposeScene`, `condensePrompt`) go through the `@vn/types`
 * interface the host passes in. The pipeline, `@vn/artgen`, `@vn/gengraph`, `vnauthor` and the
 * desktop app all compose prompts and decide approval through this package, so an agent that may
 * not import the pipeline still composes the prompt the planner would.
 */
export * from './gate.js';
export * from './chunks.js';
export * from './coverage.js';
export * from './condense.js';
export * from './resolve.js';
export * from './refs.js';
export * from './slotaddr.js';
export * from './refcycle.js';
export * from './slotgraph.js';
export * from './upstream.js';
export * from './prereq.js';
export * from './layout.js';
export * from './sheet.js';
export * from './prompts.js';
export * from './drift.js';
export * from './subject.js';
export * from './storyboard.js';
export * from './overheld.js';
export * from './shotprice.js';
export * from './takes.js';
export * from './kept.js';
