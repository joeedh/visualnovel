import { diagnosticScene } from '../diagnostics.js';
import type { Diagnostic } from '@vn/types';

const diag = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  severity: 'error',
  code    : 'dangling_line_id',
  message : 'names no line',
  ...over,
});

describe('diagnosticScene', () => {
  it('answers the scene a diagnostic points at', () => {
    expect(diagnosticScene(diag({ where: 'arrival' }), ['arrival', 'ending'])).toBe('arrival');
  });

  it('declines one with nowhere to go', () => {
    expect(diagnosticScene(diag(), ['arrival'])).toBeNull();
  });

  it('declines an entity that is not a scene — `where` is any entity id', () => {
    expect(diagnosticScene(diag({ code: 'bad_character', where: 'aiko' }), ['arrival'])).toBeNull();
  });

  it('declines a scene that does not exist, which is what the diagnostic is often about', () => {
    const missing = diag({ code: 'missing_start', where: 'prologue' });
    expect(diagnosticScene(missing, ['arrival', 'ending'])).toBeNull();
    expect(diagnosticScene(missing, [])).toBeNull();
  });
});
