/**
 * When a requeue runs the pipeline by itself. The act this decision guards spends a real image
 * call, so the decision is pinned here rather than left to a live run.
 */
import { autoRunReason } from '../asset.js';

const alone = { pending: 1, blockedOnGate: false, keyError: null };

describe('autoRunReason', () => {
  it('runs when the requeue left exactly one plannable task', () => {
    expect(autoRunReason(alone)).toBe('the only task');
  });

  it('leaves anything wider to the author', () => {
    expect(autoRunReason({ ...alone, pending: 2 })).toBe('');
    // Zero pending does not count as the one task, because the requeue is what should have
    // planned that task
    expect(autoRunReason({ ...alone, pending: 0 })).toBe('');
  });

  it('does not start a run that would halt or could not resolve its keys', () => {
    expect(autoRunReason({ ...alone, blockedOnGate: true })).toBe('');
    expect(autoRunReason({ ...alone, keyError: 'No key in GEMINI_API_KEY.' })).toBe('');
  });
});
