/**
 * Backend state for a single workspace, addressed by the IPC handlers in `index.ts`. Split by
 * concern into `session/` — see `session/core.ts` for the composition pattern.
 */
export { WorkspaceSession } from './session/core.js';
export type { SessionDeps } from './session/types/deps.js';
export type { ChunkOp, ClearPart, NewDocKind } from './session/types/results.js';
export { describeKeySource } from './session/rules/keys.js';
