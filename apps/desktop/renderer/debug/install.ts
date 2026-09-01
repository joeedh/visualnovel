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

let teardown: (() => void) | undefined;

/**
 * Answers with every element at a point, descending open shadow roots, innermost first.
 *
 * `document.elementsFromPoint` stops at a shadow host, and every editor surface is mounted inside
 * one, so the plain call ranks a host above the content painting on top of it — while the snapshot
 * walk descends into that content. The oracle is a cross-check on that walk, so it has to go as deep.
 */
function piercedElementsFromPoint(x: number, y: number): Element[] {
  const seen = new Set<Element>();
  // A root answers with its own tree, retargeting anything deeper to the host it hangs off, so
  // `seen` is what keeps an outer tree from being walked again at every level
  const walk = (root: DocumentOrShadowRoot): Element[] => {
    const hits: Element[] = root.elementsFromPoint(x, y).filter((el) => !seen.has(el));
    for (const el of hits) seen.add(el);
    const out: Element[] = [];
    for (const el of hits) {
      // Shadow content paints over the host, so the content is emitted first. Every host at the
      // point is descended into, since the topmost element may be a plain one above a widget
      if (el.shadowRoot) out.push(...walk(el.shadowRoot));
      out.push(el);
    }
    return out;
  };
  return walk(document);
}

/** Installing again (Vite HMR re-executes this module) tears down the previous debugger. */
export function installDebug(): () => void {
  teardown?.();
  // The structural DomDocument seam exists because @vn/debug2d compiles without lib.dom. It is
  // also where the hit test is supplied, so the oracle sees what the snapshot walk sees
  const dbg = createDebugger({
    sources: [
      domSource({
        documentElement: document.documentElement,
        defaultView: document.defaultView,
        elementsFromPoint: piercedElementsFromPoint,
      } as unknown as DomDocument),
    ],
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
