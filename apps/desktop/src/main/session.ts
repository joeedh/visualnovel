/**
 * Backend state for a single workspace, addressed by the IPC handlers in `index.ts`. Split by
 * concern into `session/` — see `session/core.ts` for the composition pattern.
 */
export {
  WorkspaceSession,
  type SessionDeps,
  type ChunkOp,
  type ClearPart,
  type NewDocKind,
  describeKeySource,
} from './session/core.js';
