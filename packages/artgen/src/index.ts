/**
 * Art generation policy, shared by the pipeline, the desktop app and `vnauthor`.
 *
 * Two halves. **Prompt composition** — the builders every planned image is derived from — lives
 * here rather than in `@vn/pipeline` so the input side can reach it: an agent that cannot import
 * the pipeline still has to compose a prompt that looks like this project's art. **On-demand
 * generation** is the door the planner deliberately does not have: one sentence in, one `concept`
 * asset out, bound to what it sketches but consumed by nothing — plus `redrawConcept`, which draws
 * one again from an edited prompt (the one prompt in the system that is authored rather than
 * derived), and `promoteConcept`, which turns a sketch that turned out to be canon into the plate
 * the planner would have rendered.
 */
export * from './gate.js';
export * from './chunks.js';
export * from './coverage.js';
export * from './condense.js';
export * from './resolve.js';
export * from './refs.js';
export * from './refcycle.js';
export * from './slotgraph.js';
export * from './upstream.js';
export * from './suspend.js';
export * from './prereq.js';
export * from './prompts.js';
export * from './artnotes.js';
export * from './setnotes.js';
export * from './describe.js';
export * from './drift.js';
export * from './base.js';
export * from './subject.js';
export * from './concept.js';
export * from './adopt.js';
export * from './adoptslot.js';
export * from './upload.js';
export * from './promote.js';
