/**
 * Art generation outside the planner, shared by the pipeline, the desktop app and `vnauthor`.
 *
 * On-demand generation is what the planner deliberately cannot do: one sentence in, one `concept`
 * asset out, bound to what it sketches but consumed by nothing. Alongside it, `redrawConcept` draws
 * one again from an edited prompt (the one prompt in the system that is authored rather than
 * derived), and `promoteConcept` turns a sketch that turned out to be canon into the plate the
 * planner would have rendered. The rest is adoption, uploads, art notes, suspension, the base-root
 * refusal, the repair of `current`, collection and `validateProject`. Prompt composition and the
 * rules it is derived from are in `@vn/stills`.
 */
export * from './suspend.js';
export * from './artnotes.js';
export * from './setnotes.js';
export * from './describe.js';
export * from './base.js';
export * from './concept.js';
export * from './adoptslot.js';
export * from './upload.js';
export * from './promote.js';
export * from './takes.js';
export * from './validate.js';
export * from './collect.js';
