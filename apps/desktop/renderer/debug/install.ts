/**
 * Dev-only renderer glue: installs the 2D debug surface as `window.__vnDebug`.
 *
 * Deliberately NOT exposed through the preload contextBridge — the bridge deep-clones
 * everything it exposes, so functions lose identity and live DOM references (Fragment.raw,
 * fiber attribution) do not survive. CDP `Runtime.evaluate` and the DevTools console both
 * execute in the page's main world, so a renderer-installed global serves them equally.
 * This module is only reached via a dev-gated dynamic import in main.tsx; `vite build`
 * drops it (and @vn/debug2d) from the production bundle.
 */
import { createDebugger, domSource, type DomDocument } from '@vn/debug2d';

let teardown: (() => void) | undefined;

/** Idempotent: re-install (Vite HMR re-executing the module) tears down the previous one. */
export function installDebug(): () => void {
  teardown?.();
  // The structural DomDocument seam exists because @vn/debug2d compiles without lib.dom;
  // the real document satisfies it at runtime.
  const dbg = createDebugger({
    sources: [domSource(document as unknown as DomDocument)],
    spaces: {},
  });
  window.__vnDebug = dbg;
  const dispose = () => {
    if (window.__vnDebug === dbg) delete window.__vnDebug;
    if (teardown === dispose) teardown = undefined;
  };
  teardown = dispose;
  return dispose;
}
