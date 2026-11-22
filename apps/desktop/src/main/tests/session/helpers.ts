/**
 * `WorkspaceSession` is the main-process join point every `story.*` / `gate.*` / `pipeline.*`
 * command routes through. It is Electron-free by construction, so it can be driven directly
 * over a real generated project — testkit runs the pipeline, the session reads it back.
 */
import { WorkspaceSession, type SessionDeps } from '../../session.js';

// The three permission doors answer as an abandoned window would: no plan, no answers, no consent
export const deps: SessionDeps = {
  emitEvent     : () => {},
  emitReport    : () => {},
  requestPlan   : () => Promise.resolve({ approved: false }),
  requestAnswer : () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy      : () => {},
};

export const sessionFor = (p: { dir: string }) => new WorkspaceSession(p.dir, true, deps);

/**
 * Bytes that ingest reads as a PNG rather than as mock art. Ingest checks the magic number and
 * the placeholder marker and nothing else, so these bytes do not have to decode.
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const realPng = (): Uint8Array =>
  new Uint8Array([...PNG_SIGNATURE, ...new Array<number>(64).fill(7)]);
