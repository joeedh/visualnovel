import { connect, relabel, splice, unwire, NEW_CHOICE } from '../intent.js';
import type { SceneMap } from '../../../../../src/shared/branchops';
import type { StoryEdge } from '../../../../../src/shared/ipc';

const scenes: SceneMap = new Map([
  ['greet', { id: 'greet', choices: [{ label: 'Say hello', goto: 'rooftop' }] }],
  ['rooftop', { id: 'rooftop', choices: [], next: 'ending' }],
  ['ending', { id: 'ending', choices: [] }],
  ['forks', { id: 'forks', choices: [{ label: 'Left', goto: 'ending' }] }],
  ['quiet', { id: 'quiet', choices: [] }],
]);

const edge = (over: Partial<StoryEdge>): StoryEdge => ({
  id: 'e',
  from: 'greet',
  to: 'rooftop',
  kind: 'choice',
  index: 0,
  label: 'Say hello',
  dangling: false,
  ...over,
});

describe('connect', () => {
  it('continues a scene that has nothing leaving it', () => {
    const decision = connect(scenes, 'ending', 'greet');
    expect(decision).toEqual({
      ok: true,
      intent: {
        id: 'story.setNext',
        props: { scene: 'ending', goto: 'greet' },
        note: 'ending continues to greet.',
      },
    });
  });

  it('adds a choice to a scene that already forks', () => {
    const decision = connect(scenes, 'greet', 'ending');
    expect(decision.ok && decision.intent.id).toBe('story.setChoice');
    expect(decision.ok && decision.intent.props).toEqual({
      scene: 'greet',
      goto: 'ending',
      label: NEW_CHOICE,
    });
  });

  it('adds a choice to a scene that has a bare next rather than replacing it', () => {
    const decision = connect(scenes, 'rooftop', 'greet');
    expect(decision.ok && decision.intent.id).toBe('story.setChoice');
  });

  it('refuses a scene that is not in the graph', () => {
    expect(connect(scenes, 'nowhere', 'greet')).toEqual({
      ok: false,
      reason: 'No scene "nowhere".',
    });
  });
});

describe('splice', () => {
  it('rewires a choice through the dropped scene', () => {
    const decision = splice(scenes, 'ending', edge({ index: 0 }));
    expect(decision).toEqual({
      ok: true,
      intent: {
        id: 'story.spliceScene',
        props: { scene: 'ending', from: 'greet', edge: 0 },
        note: 'Spliced ending into greet → rooftop.',
      },
    });
  });

  it('addresses a next edge without an index', () => {
    const decision = splice(scenes, 'quiet', edge({ from: 'rooftop', to: 'ending', kind: 'next' }));
    expect(decision.ok && decision.intent.props).toEqual({ scene: 'quiet', from: 'rooftop' });
  });

  it('carries branchops’ own refusal, so the drag preview cannot disagree with the drop', () => {
    const decision = splice(scenes, 'forks', edge({ index: 0 }));
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.reason).toContain('already forks');
    expect(!decision.ok && decision.reason).toContain('would never be taken');
  });

  it('refuses dropping a scene onto an edge it is already the target of', () => {
    const decision = splice(scenes, 'rooftop', edge({ index: 0 }));
    expect(!decision.ok && decision.reason).toBe('rooftop is already the target of that edge.');
  });
});

describe('unwire', () => {
  it('removes the choice the edge came from', () => {
    expect(unwire(scenes, edge({ index: 0 }))).toEqual({
      ok: true,
      intent: {
        id: 'story.removeChoice',
        props: { scene: 'greet', index: 0 },
        note: 'Removed greet → rooftop ("Say hello").',
      },
    });
  });

  it('clears a next by sending an empty goto', () => {
    const decision = unwire(scenes, edge({ from: 'rooftop', to: 'ending', kind: 'next' }));
    expect(decision.ok && decision.intent.props).toEqual({ scene: 'rooftop', goto: '' });
    expect(decision.ok && decision.intent.note).toBe('Cleared rooftop → ending.');
  });

  it('refuses to clear a next that is not there', () => {
    const decision = unwire(scenes, edge({ from: 'ending', kind: 'next' }));
    expect(!decision.ok && decision.reason).toBe('ending has no next scene to clear.');
  });
});

describe('relabel', () => {
  it('replaces the choice in place, keeping its index', () => {
    const decision = relabel(scenes, edge({ index: 0 }), 'Greet her');
    expect(decision.ok && decision.intent.props).toEqual({
      scene: 'greet',
      goto: 'rooftop',
      label: 'Greet her',
      index: 0,
    });
  });

  it('refuses a next, which carries no label', () => {
    const decision = relabel(scenes, edge({ kind: 'next' }), 'anything');
    expect(decision).toEqual({ ok: false, reason: 'Only a choice carries a label.' });
  });
});
