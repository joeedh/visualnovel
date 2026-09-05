/**
 * Dev-only renderer glue: installs the 2D debug surface as `window.__vnDebug`.
 *
 * It is deliberately not exposed through the preload contextBridge: the bridge deep-clones
 * everything it exposes, so functions lose identity and live DOM references (Fragment.raw,
 * fiber attribution) do not survive. CDP `Runtime.evaluate` and the DevTools console both
 * execute in the page's main world, so a renderer-installed global reaches both. This module
 * is only reached via a dev-gated dynamic import in main.ts, and `vite build` drops it
 * (along with @vn/debug2d) from the production bundle.
 */
import { createDebugger, domSource, type DomDocument } from '@vn/debug2d';
import { elementsAt } from '../pathux/interactions/hittest.js';

let teardown: (() => void) | undefined;

/** Installing again (Vite HMR re-executes this module) tears down the previous debugger. */
export function installDebug(): () => void {
  teardown?.();
  // The structural DomDocument seam exists because @vn/debug2d compiles without lib.dom. It is
  // also where the hit test is supplied, so the oracle sees what the snapshot walk sees — the same
  // descent the tour overlay checks a ring against
  const dbg = createDebugger({
    sources: [
      domSource({
        documentElement  : document.documentElement,
        defaultView      : document.defaultView,
        elementsFromPoint: elementsAt,
      } as unknown as DomDocument),
    ],
    spaces : {},
  });
  window.__vnDebug = dbg;
  const dispose = () => {
    if (window.__vnDebug === dbg) delete window.__vnDebug;
    if (teardown === dispose) teardown = undefined;
  };
  teardown = dispose;
  return dispose;
}
