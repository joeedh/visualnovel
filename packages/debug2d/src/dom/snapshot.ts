/**
 * The impure shell of the DOM adapter: ALL browser reads happen here, in one batched
 * pass, and the output is a plain serializable snapshot tree. Every decision worth
 * testing (stacking, pick, attribution) lives in pure functions over that tree. jsdom
 * has no layout engine, so CI cannot cover this file and it is kept close to logic-free.
 *
 * Browser objects are typed structurally (`ElementLike` …) because the root tsconfig
 * compiles packages without `lib.dom`; the renderer passes the real `document`.
 */
import type { Rect } from '../geom.js';

export type SnapStyle = {
  position?: string;
  /** Computed value: 'auto' or an integer string. */
  zIndex?: string;
  opacity?: number;
  transform?: string;
  filter?: string;
  willChange?: string;
  isolation?: string;
  contain?: string;
  backdropFilter?: string;
  /** Computed, so DOM captures arrive pre-inherited; pure code still falls back. */
  pointerEvents?: string;
  overflowX?: string;
  overflowY?: string;
  backgroundColor?: string;
};

export type SnapNode = {
  /** Becomes the FragId, 'dom:<n>' in document pre-order. */
  id: string;
  tag: string;
  elemId?: string;
  classes: string[];
  /** data-dbg-id, the first attribution resolver. */
  dbgId?: string;
  /** Border box in css px. */
  bounds: Rect;
  style: SnapStyle;
  /** React component name when the fiber resolver got one (dev-only, fragile). */
  fiberName?: string;
  children: SnapNode[];
  /** The live Element; absent in synthetic trees, never crosses CDP. */
  raw?: unknown;
};

export type ShadowRootLike = {
  children: ArrayLike<ElementLike>;
};

export type ElementLike = {
  tagName: string;
  id: string;
  classList: { value: string };
  children: ArrayLike<ElementLike>;
  /** Open shadow root, e.g. path.ux's `UIBase.shadow`; absent or null elsewhere. */
  shadowRoot?: ShadowRootLike | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
};

export type DocumentLike = {
  documentElement: ElementLike | null;
  defaultView: {
    getComputedStyle(el: ElementLike): Record<string, string | undefined> & {
      getPropertyValue(name: string): string;
    };
  } | null;
};

export type DomSnapshot = {
  root: SnapNode | null;
  /** Live element → FragId, for mapping elementsFromPoint hits back to fragments. */
  idOf: Map<ElementLike, string>;
};

const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'head', 'title', 'noscript']);

/** Nearest React component name via the element's fiber. Degrades to undefined, never throws. */
function fiberComponentName(el: ElementLike): string | undefined {
  try {
    const rec = el as unknown as Record<string, unknown>;
    const key = Object.keys(rec).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return undefined;
    let fiber = rec[key] as { elementType?: unknown; type?: unknown; return?: unknown } | null;
    for (let hops = 0; fiber && hops < 50; hops++) {
      const t = (fiber.elementType ?? fiber.type) as
        | { displayName?: string; name?: string }
        | string
        | null;
      if (typeof t === 'function' || (t && typeof t === 'object')) {
        const name =
          (t as { displayName?: string; name?: string }).displayName ??
          (t as { name?: string }).name;
        if (name) return name;
      }
      fiber = fiber.return as typeof fiber;
    }
  } catch {
    // Version-fragile by design; attribution falls through to the tag/class path.
  }
  return undefined;
}

export function snapshotDom(doc: DocumentLike): DomSnapshot {
  const win = doc.defaultView;
  const rootEl = doc.documentElement;
  if (!win || !rootEl) return { root: null, idOf: new Map() };

  const idOf = new Map<ElementLike, string>();
  let n = 0;

  function visit(el: ElementLike): SnapNode | null {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;
    // The debugger never captures its own overlay (research §3-DOM)
    if (el.hasAttribute('data-dbg-overlay')) return null;

    const cs = win!.getComputedStyle(el);
    if (cs['display'] === 'none') return null;

    const id = `dom:${n++}`;
    idOf.set(el, id);
    const r = el.getBoundingClientRect();
    const node: SnapNode = {
      id,
      tag,
      elemId: el.id || undefined,
      classes: el.classList.value ? el.classList.value.split(/\s+/).filter(Boolean) : [],
      dbgId: el.getAttribute('data-dbg-id') ?? undefined,
      bounds: { x: r.x, y: r.y, w: r.width, h: r.height },
      style: {
        position: cs['position'],
        zIndex: cs['zIndex'],
        opacity: Number(cs['opacity'] ?? '1'),
        transform: cs['transform'],
        filter: cs['filter'],
        willChange: cs['willChange'],
        isolation: cs['isolation'],
        contain: cs['contain'],
        backdropFilter: cs['backdropFilter'] ?? cs.getPropertyValue('backdrop-filter') ?? undefined,
        pointerEvents: cs['pointerEvents'],
        overflowX: cs['overflowX'],
        overflowY: cs['overflowY'],
        backgroundColor: cs['backgroundColor'],
      },
      fiberName: fiberComponentName(el),
      children: [],
      raw: el,
    };
    visitInto(el.children, node.children);
    // Open shadow roots (path.ux widgets) are a separate child list from `el.children`;
    // a closed root is unreachable here and stays structurally invisible, same as to CSS.
    if (el.shadowRoot) visitInto(el.shadowRoot.children, node.children);
    return node;
  }

  function visitInto(elems: ArrayLike<ElementLike>, into: SnapNode[]): void {
    for (let i = 0; i < elems.length; i++) {
      const child = elems[i];
      if (!child) continue;
      const snap = visit(child);
      if (snap) into.push(snap);
    }
  }

  return { root: visit(rootEl), idOf };
}
