import { driftTag, staleCount } from '../drift.js';
import type { CoverageShot } from '../../../../src/shared/ipc';
import type { Drift } from '@vn/types';

const shot = (id: string, drift: Drift): CoverageShot => ({
  id,
  framing: 'medium',
  subjects: [],
  outfits: {},
  coversLines: [],
  status: 'accepted',
  drift,
});

describe('driftTag', () => {
  it('marks a drifted shot, and says the art will not replace itself', () => {
    const tag = driftTag('drifted')!;
    expect(tag.state).toBe('drifted');
    expect(tag.label).toBe('OLD PROSE');
    expect(tag.title).toMatch(/retyped/);
    // The mark exists to say that no run will fix this on the author's behalf
    expect(tag.title).toMatch(/nothing re-renders on its own/i);
  });

  it('marks an unrendered-hash shot as a question, never as a fault', () => {
    const tag = driftTag('unknown')!;
    expect(tag.state).toBe('unknown');
    expect(tag.title).not.toMatch(/retyped/);
  });

  it('says nothing about a frame that matches, and nothing about one that does not exist', () => {
    expect(driftTag('current')).toBeNull();
    expect(driftTag('unrendered')).toBeNull();
  });
});

describe('staleCount', () => {
  it('counts the drifted shots only', () => {
    const shots = [
      shot('a', 'drifted'),
      shot('b', 'current'),
      shot('c', 'drifted'),
      shot('d', 'unrendered'),
    ];
    expect(staleCount(shots)).toBe(2);
  });

  it('does not count unknown, which the author cannot act on', () => {
    expect(staleCount([shot('a', 'unknown'), shot('b', 'unknown')])).toBe(0);
  });
});
