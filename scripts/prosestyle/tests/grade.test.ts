import { spanSupported } from '../grade.js';

const PASSAGE = 'The cache remembers what it has already seen,\nso a second lookup costs nothing.';

describe('spanSupported', () => {
  it('accepts a span the passage carries', () => {
    expect(spanSupported('remembers what it has already seen', PASSAGE)).toBe(true);
  });

  it('matches across a line break, since the judge sees wrapped prose', () => {
    expect(spanSupported('already seen, so a second lookup', PASSAGE)).toBe(true);
  });

  it('strips the quotes a model wraps its answer in', () => {
    expect(spanSupported('"remembers what it has already seen"', PASSAGE)).toBe(true);
  });

  it('rejects NONE', () => {
    expect(spanSupported('NONE', PASSAGE)).toBe(false);
    expect(spanSupported('none.', PASSAGE)).toBe(false);
  });

  it('rejects an empty answer', () => {
    expect(spanSupported('   ', PASSAGE)).toBe(false);
  });

  /** The failure this check exists for: a construction asserted but not shown. */
  it('rejects a span the passage does not carry', () => {
    expect(spanSupported('the scheduler wants a barrier', PASSAGE)).toBe(false);
  });

  it('rejects a span too short to identify anything', () => {
    expect(spanSupported('the', PASSAGE)).toBe(false);
  });
});
