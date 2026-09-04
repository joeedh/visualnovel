/**
 * What a click at a point would actually reach, descending open shadow roots.
 *
 * `document.elementsFromPoint` stops at a shadow host, and every editor surface is mounted inside
 * one, so the plain call ranks a host above the content painting on top of it. A ring drawn at the
 * right rect over the wrong thing renders exactly like a correct one, which is why the overlay
 * asks this before drawing confidently rather than trusting the rect it recorded.
 *
 * The walk is the one `findArea` and `pickElement` make in path.ux, stopping at a different
 * target: `pickElement` filters its chain down to the innermost `UIBase` and returns only that,
 * while a raw `<button>` in an editor surface is an anchor too and is skipped by that filter.
 */

/** A shadow root as path.ux leaves it: `initUIBase` names the widget the root hangs off. */
type OwnedRoot = ShadowRoot & { parentWidget?: Node };

/**
 * Every element at a point, innermost first, descending into each host at that point.
 *
 * A root answers with its own tree and retargets anything deeper to the host it hangs off, so the
 * seen set is what keeps an outer tree from being walked again at every level. Shadow content
 * paints over its host, so the content is emitted first.
 */
export function elementsAt(x: number, y: number): Element[] {
  const seen = new Set<Element>();
  const walk = (root: DocumentOrShadowRoot): Element[] => {
    const hits: Element[] = root.elementsFromPoint(x, y).filter((el) => !seen.has(el));
    for (const el of hits) seen.add(el);
    const out: Element[] = [];
    for (const el of hits) {
      if (el.shadowRoot) out.push(...walk(el.shadowRoot));
      out.push(el);
    }
    return out;
  };
  return walk(document);
}

/** The topmost thing at a point, as deep as the shadow roots go. */
export const hitAt = (x: number, y: number): Element | undefined => elementsAt(x, y)[0];

/**
 * One step up out of a node, out of a shadow tree as readily as out of an element.
 *
 * `parentWidget` is `host` answering the same question, typed as the widget rather than as an
 * `Element`, which is what lets the ascent stay one loop; a root path.ux did not create still
 * answers through `host`.
 */
function up(node: Node): Node | undefined {
  if (typeof ShadowRoot !== 'undefined' && node instanceof ShadowRoot) {
    return (node as OwnedRoot).parentWidget ?? node.host;
  }
  return node.parentNode ?? undefined;
}

/**
 * Whether a hit is the target or sits inside it. Containment rather than identity: a path.ux
 * `Button` paints into an inner `<canvas>`, which is what the pierced hit test answers with.
 */
export function reaches(hit: Node, target: Node): boolean {
  let node: Node | undefined = hit;
  while (node) {
    if (node === target) return true;
    node = up(node);
  }
  return false;
}

/**
 * What a click in the middle of a node would land on: whether it reaches the node, and the box of
 * the thing it actually hit, which the ring widens to where that box lies outside the node's own.
 */
export function hitFor(node: Node, x: number, y: number): { ok: boolean; hit?: Element } {
  const hit = hitAt(x, y);
  if (!hit) return { ok: false };
  return reaches(hit, node) ? { ok: true, hit } : { ok: false, hit };
}
