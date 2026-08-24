import type { Approvable } from '@vn/authoring';
import { reorderApprovals, sameApprovals } from '../approvals.js';

const item = (hash: string): Approvable => ({
  hash,
  kind: 'portrait',
  label: hash.toUpperCase(),
  slot: `portrait:${hash}`,
  door: 'accept',
});

describe('reorderApprovals', () => {
  it('puts what the stored order has not seen on top', () => {
    const { order } = reorderApprovals([item('a'), item('b'), item('c')], ['b']);
    expect(order).toEqual(['a', 'c', 'b']);
  });

  it('keeps the stored order among the hashes it already knows', () => {
    const { order } = reorderApprovals([item('a'), item('b'), item('c')], ['c', 'a', 'b']);
    expect(order).toEqual(['c', 'a', 'b']);
  });

  it('drops a hash that is no longer waiting', () => {
    const { items, order } = reorderApprovals([item('a')], ['b', 'a']);
    expect(order).toEqual(['a']);
    expect(items.map((i) => i.hash)).toEqual(['a']);
  });

  it('answers with the items themselves, in the order it reports', () => {
    const { items, order } = reorderApprovals([item('a'), item('b')], ['b']);
    expect(items.map((i) => i.hash)).toEqual(order);
  });

  it('takes everything as new when nothing is stored', () => {
    const { order } = reorderApprovals([item('a'), item('b')], []);
    expect(order).toEqual(['a', 'b']);
  });
});

describe('sameApprovals', () => {
  it('ignores order', () => {
    expect(sameApprovals(['a', 'b'], ['b', 'a'])).toBe(true);
  });

  it('separates a different set of the same size', () => {
    expect(sameApprovals(['a', 'b'], ['a', 'c'])).toBe(false);
  });

  it('separates lists of different lengths', () => {
    expect(sameApprovals(['a'], ['a', 'b'])).toBe(false);
  });
});
