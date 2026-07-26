/**
 * `@vn/testkit` — test-only fixtures. It builds real VN projects on disk, runs them through
 * the real scheduler with mock providers, and hands back the resulting model/store/graph.
 *
 * It is the one package allowed to import across every layer, and **nothing** may import it:
 * the boundaries rule grants no one permission, so a production import is a lint error.
 * Test files are exempt from that rule, which is the only place it belongs.
 */
export * from './assets.js';
export * from './scripts.js';
export * from './inputs.js';
export * from './project.js';
export * from './synth.js';
export * from './factories.js';
