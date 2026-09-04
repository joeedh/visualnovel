/**
 * A closed pane's leftover state, which `verdictsFor` has to pass over. The registry cannot drop
 * the entry when the pane closes, so the open set is what decides.
 */
import { gestureState, verdictsFor } from '../gestures.js';
import type { BranchState } from '../../../../src/shared/interactions.js';
import type { AnchorHome } from '../../../rules/anchors.js';
import type { EditorId } from '../../../../src/shared/editors.js';

const BRANCHES = 'branches' as EditorId;

const state = (): BranchState => ({
  scenes: new Map([['greet', { id: 'greet', choices: [], next: undefined }]]),
  edges: [],
});

describe('verdictsFor', () => {
  beforeEach(() => gestureState('branch', BRANCHES, state));

  it('judges the gesture against the state the pane left', () => {
    const judged = verdictsFor('branch.connect', 'greet', [BRANCHES]);
    expect(judged?.editor).toBe(BRANCHES);
    expect(judged?.verdicts.map((verdict) => verdict.target)).toEqual(['greet']);
  });

  it('answers nothing for a pane that is not open', () => {
    expect(verdictsFor('branch.connect', 'greet', [])).toBeUndefined();
    expect(verdictsFor('branch.connect', 'greet', ['asset' as AnchorHome])).toBeUndefined();
  });

  it('answers nothing for a gesture the app does not declare', () => {
    expect(verdictsFor('branch.invent', 'greet', [BRANCHES])).toBeUndefined();
  });
});
