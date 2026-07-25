/**
 * Pure stacking-context walk over a snapshot tree → z-ordered fragments with culprit
 * retention (research §3-DOM). Identifies stacking contexts, applies CSS 2.1 paint order
 * within each, and — crucially — when an element's z-index is scoped by an ancestor that
 * established a context, records that ancestor on the fragment (`zContext`): it is the
 * fact explainPick prints, it is free here, and it is unrecoverable afterwards.
 *
 * Honest approximations (`exactZ: false`, always): positioned `z-index: auto` elements
 * and zero/auto-z contexts paint atomically in one document-order bucket; floats are not
 * distinguished from blocks; overflow clips apply by DOM ancestry even where an
 * absolutely-positioned element would escape them.
 */
import type { ClipRef, Fragment, OwnerRef, ZContextRef } from '../types.js';
import { nodeLabel, resolveOwner } from './attribution.js';
import { effectivePointerEvents } from './pick.js';
import type { SnapNode } from './snapshot.js';

/** Declared z-index as a number, or null for 'auto' (and anything unparsable). */
function zIndexOf(node: SnapNode): number | null {
  const raw = node.style.zIndex;
  if (raw === undefined || raw === 'auto') return null;
  const z = parseInt(raw, 10);
  return Number.isNaN(z) ? null : z;
}

function isPositioned(node: SnapNode): boolean {
  const p = node.style.position;
  return p !== undefined && p !== '' && p !== 'static';
}

/** Why this element establishes a stacking context, or null if it does not. */
export function contextReason(node: SnapNode): string | null {
  const s = node.style;
  if (isPositioned(node) && zIndexOf(node) !== null) return 'z-index on positioned element';
  if (s.position === 'fixed') return 'position: fixed';
  if (s.opacity !== undefined && s.opacity < 1) return `opacity: ${s.opacity}`;
  if (s.transform && s.transform !== 'none') return 'transform';
  if (s.filter && s.filter !== 'none') return 'filter';
  if (s.backdropFilter && s.backdropFilter !== 'none') return 'backdrop-filter';
  if (s.isolation === 'isolate') return 'isolation: isolate';
  if (s.willChange && /transform|opacity|filter/.test(s.willChange)) return 'will-change';
  if (s.contain && /layout|paint|strict|content/.test(s.contain)) return 'contain';
  return null;
}

function clipsFor(node: SnapNode, inherited: ClipRef[]): ClipRef[] {
  const clips =
    (node.style.overflowX !== undefined && node.style.overflowX !== 'visible') ||
    (node.style.overflowY !== undefined && node.style.overflowY !== 'visible')
      ? [...inherited, { rect: node.bounds, by: node.id }]
      : inherited;
  return clips;
}

type Item = {
  node: SnapNode;
  clips: ClipRef[];
  owner: OwnerRef;
  pe: 'auto' | 'none';
  /** Effective z within the parent context: declared value, or 0 for auto. */
  z: number;
  /** Non-null when the item roots a nested stacking context. */
  reason: string | null;
  /** Document-order tiebreak. */
  seq: number;
};

export function fragmentsFromSnapshot(root: SnapNode): Fragment[] {
  const out: Fragment[] = [];
  let paintZ = 0;
  let seq = 0;

  function emit(
    node: SnapNode,
    clips: ClipRef[],
    owner: OwnerRef,
    pe: 'auto' | 'none',
    scope?: ZContextRef,
  ): void {
    const declared = zIndexOf(node);
    out.push({
      id: node.id,
      z: paintZ++,
      kind: 'box',
      bounds: node.bounds,
      space: 'css',
      clip: clips.length ? clips : undefined,
      style: {
        alpha: node.style.opacity ?? 1,
        fill: node.style.backgroundColor,
        zIndex: declared ?? undefined,
      },
      pick: { mode: pe },
      owner,
      tags: [],
      source: 'dom',
      // The scoping note only matters where a declared z-index is being reinterpreted.
      zContext: declared !== null && scope ? scope : undefined,
      raw: node.raw,
    });
  }

  // Gather this context's paint items: descend through in-flow content (emitting it in
  // document order via `inFlow`), floating positioned/context-rooting elements up here.
  function collect(
    parent: SnapNode,
    clips: ClipRef[],
    owner: OwnerRef,
    pe: 'auto' | 'none',
    scope: ZContextRef | undefined,
    inFlow: Item[],
    bucketed: Item[],
  ): void {
    const childClips = clipsFor(parent, clips);
    for (const child of parent.children) {
      const childPe = effectivePointerEvents(child, pe);
      const childOwner = resolveOwner(child, owner);
      const reason = contextReason(child);
      const item: Item = {
        node: child,
        clips: childClips,
        owner: childOwner,
        pe: childPe,
        z: zIndexOf(child) ?? 0,
        reason,
        seq: seq++,
      };
      if (reason !== null || isPositioned(child)) {
        bucketed.push(item);
      } else {
        inFlow.push(item);
        collect(child, childClips, childOwner, childPe, scope, inFlow, bucketed);
      }
    }
  }

  // Paint one atomic unit: the element itself, then its subtree in CSS 2.1 order.
  // `scope` is the context root whose presence scopes descendants' z-index values —
  // undefined only while inside the real root context, where z-index means what it says.
  function paint(item: Item, scope: ZContextRef | undefined): void {
    emit(item.node, item.clips, item.owner, item.pe, scope);

    const childScope: ZContextRef | undefined =
      item.reason !== null && item.reason !== 'root'
        ? { by: item.node.id, byLabel: nodeLabel(item.node), reason: item.reason }
        : item.reason === 'root'
          ? undefined
          : scope;

    const inFlow: Item[] = [];
    const bucketed: Item[] = [];
    collect(item.node, item.clips, item.owner, item.pe, childScope, inFlow, bucketed);

    const byZ = (a: Item, b: Item) => a.z - b.z || a.seq - b.seq;
    for (const it of bucketed.filter((i) => i.z < 0).sort(byZ)) paint(it, childScope);
    for (const it of inFlow) emit(it.node, it.clips, it.owner, it.pe, childScope);
    for (const it of bucketed.filter((i) => i.z === 0).sort((a, b) => a.seq - b.seq))
      paint(it, childScope);
    for (const it of bucketed.filter((i) => i.z > 0).sort(byZ)) paint(it, childScope);
  }

  paint(
    {
      node: root,
      clips: [],
      owner: resolveOwner(root),
      pe: effectivePointerEvents(root),
      z: 0,
      reason: 'root',
      seq: seq++,
    },
    undefined,
  );
  return out;
}
