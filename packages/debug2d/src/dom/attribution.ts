/**
 * Attribution resolver chain (research §3-DOM): `data-dbg-id` → React fiber name →
 * tag/class path. Pure over the snapshot tree; the fragile fiber extraction already
 * happened in snapshot.ts. A resolver may fail or throw, and the chain then degrades to
 * 'unknown' rather than throwing.
 */
import type { OwnerRef } from '../types.js';
import type { SnapNode } from './snapshot.js';

/** Human label for an element: `div#root`, `div.rail.left`, `button`. */
export function nodeLabel(node: SnapNode): string {
  if (node.elemId) return `${node.tag}#${node.elemId}`;
  if (node.classes.length) return `${node.tag}.${node.classes.join('.')}`;
  return node.tag;
}

export type OwnerResolver = (node: SnapNode) => Omit<OwnerRef, 'parent'> | undefined;

export const dbgIdResolver: OwnerResolver = (node) =>
  node.dbgId ? { id: node.dbgId, label: node.dbgId, kind: 'widget' } : undefined;

export const fiberResolver: OwnerResolver = (node) =>
  node.fiberName
    ? {
        id   : `${node.fiberName}/${nodeLabel(node)}`,
        label: `${node.fiberName}/${nodeLabel(node)}`,
        kind : 'component',
      }
    : undefined;

export const pathResolver: OwnerResolver = (node) => {
  const label = nodeLabel(node);
  return label ? { id: label, label, kind: 'element' } : undefined;
};

export const DEFAULT_RESOLVERS: OwnerResolver[] = [dbgIdResolver, fiberResolver, pathResolver];

export function resolveOwner(
  node: SnapNode,
  parent?: OwnerRef,
  resolvers: OwnerResolver[] = DEFAULT_RESOLVERS,
): OwnerRef {
  for (const resolver of resolvers) {
    try {
      const owner = resolver(node);
      if (owner) return parent ? { ...owner, parent: parent.id } : owner;
    } catch {
      // A broken resolver falls through to the next; attribution must never throw.
    }
  }
  return { id: 'unknown', label: 'unknown', kind: 'unknown', parent: parent?.id };
}
