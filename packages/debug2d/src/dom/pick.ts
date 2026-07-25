/**
 * Effective `pointer-events` from the snapshot. Real DOM captures arrive with the
 * computed (already-inherited) value; synthetic test trees may omit it, so inheritance
 * is applied here too — same answer either way.
 */
import type { SnapNode } from './snapshot.js';

export function effectivePointerEvents(
  node: SnapNode,
  inherited: 'auto' | 'none' = 'auto',
): 'auto' | 'none' {
  const v = node.style.pointerEvents;
  if (v === undefined || v === '' || v === 'inherit') return inherited;
  return v === 'none' ? 'none' : 'auto';
}
