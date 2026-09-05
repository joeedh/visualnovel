import type { Diagnostic } from '@vn/types';
import { diagnosticDetail, diagnosticSummary, orderDiagnostics } from '../diagnostics.js';

const warn = (message: string, over: Partial<Diagnostic> = {}): Diagnostic => ({
  severity: 'warning',
  code    : 'W1',
  message,
  ...over,
});

describe('orderDiagnostics', () => {
  it('puts errors first and leaves each severity in the order it was found', () => {
    const list = [
      warn('a'),
      warn('b', { severity: 'error', code: 'E1' }),
      warn('c'),
      warn('d', { severity: 'error', code: 'E2' }),
    ];
    expect(orderDiagnostics(list).map((d) => d.message)).toEqual(['b', 'd', 'a', 'c']);
    // Returns a new array rather than sorting in place, because the header holds the fetched one
    expect(list.map((d) => d.message)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('diagnosticSummary', () => {
  it('names both counts, one count, or nothing', () => {
    expect(diagnosticSummary([warn('a'), warn('b', { severity: 'error' }), warn('c')])).toBe(
      '1 error · 2 warnings',
    );
    expect(diagnosticSummary([warn('a')])).toBe('1 warning');
    expect(diagnosticSummary([])).toBe('');
  });
});

describe('diagnosticDetail', () => {
  it('says the code, and the entity where one was named', () => {
    expect(diagnosticDetail(warn('a', { code: 'unreachable-scene', where: 'greet' }))).toBe(
      'warning unreachable-scene · greet',
    );
    expect(diagnosticDetail(warn('a', { code: 'no-start' }))).toBe('warning no-start');
  });
});
