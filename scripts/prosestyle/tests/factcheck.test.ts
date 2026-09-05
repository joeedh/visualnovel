import { locateSpan, readAnswer } from '../factcheck.js';

const REVISED = 'The scheduler retries a failed task twice,\nand then records a failure.';

describe('locateSpan', () => {
  it('locates a quotation the revision carries', () => {
    expect(locateSpan('retries a failed task twice', REVISED)).toEqual({ start: 14, end: 41 });
  });

  it('locates one that spans the line break the model did not see', () => {
    const span = locateSpan('twice, and then records', REVISED);
    expect(REVISED.slice(span?.start, span?.end)).toBe('twice,\nand then records');
  });

  it('refuses a quotation the revision does not carry', () => {
    expect(locateSpan('retries three times', REVISED)).toBeUndefined();
  });

  it('refuses a quotation too short to locate anything', () => {
    expect(locateSpan('the', REVISED)).toBeUndefined();
  });
});

describe('readAnswer', () => {
  it('reads SAME as no drift', () => {
    expect(readAnswer('SAME', REVISED)).toEqual({ verdict: 'equivalent' });
    expect(readAnswer('  same.  ', REVISED)).toEqual({ verdict: 'equivalent' });
  });

  it('reads an empty answer as no drift', () => {
    expect(readAnswer('', REVISED)).toEqual({ verdict: 'equivalent' });
  });

  it('reads a locatable quotation as drift, and keeps only the offsets', () => {
    const finding = readAnswer('"a failed task twice"', REVISED);
    expect(finding.verdict).toBe('drifted');
    expect(Object.keys(finding).sort()).toEqual(['span', 'verdict']);
  });

  /** A claim the checker cannot show is surfaced rather than believed or discarded. */
  it('reads an unlocatable claim as unverifiable', () => {
    expect(readAnswer('the revision says it retries three times', REVISED)).toEqual({
      verdict: 'unverifiable',
    });
  });
});
