import {
  branchConnect,
  branchSplice,
  branchUnwire,
  connect,
  relabel,
  splice,
  unwire,
  CANVAS,
  NEW_CHOICE,
  type BranchState,
} from '../interactions.js';
import type { SceneMap } from '../branchops.js';
import type { StoryEdge } from '../ipc.js';

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

/**
 * The interactions add no rules — they enumerate targets and hand each one to the decision
 * above. So these assert the enumeration and that the verdict is verbatim what the drop
 * would have produced; the rules themselves are `branchops.test.ts`'s business.
 */
describe('the branch interactions', () => {
  const nextEdge: StoryEdge = {
    id: 'rooftop#next',
    from: 'rooftop',
    to: 'ending',
    kind: 'next',
    dangling: false,
  };
  const state: BranchState = {
    scenes,
    edges: [
      edge({ id: 'greet#choice:0' }),
      nextEdge,
      edge({ id: 'forks#choice:0', from: 'forks', to: 'ending', index: 0, label: 'Left' }),
    ],
  };

  it('judges every scene as a connect target', () => {
    const verdicts = branchConnect.targets(state, 'ending');
    expect(verdicts.map((v) => v.target)).toEqual([...scenes.keys()]);
    expect(verdicts.every((v) => v.accept)).toBe(true);
  });

  it('carries the command the drop would run, ready to execute', () => {
    const [greet] = branchConnect.targets(state, 'ending');
    expect(greet?.accept && greet.invoke).toEqual({
      id: 'story.setNext',
      props: { scene: 'ending', goto: 'greet' },
    });
  });

  it('judges every edge as a splice target, refusing with branchops’ own sentence', () => {
    const verdicts = branchSplice.targets(state, 'forks');
    expect(verdicts.map((v) => (v.accept ? 'accept' : v.reason))).toEqual([
      expect.stringContaining('forks already forks into 1 choice(s)'),
      expect.stringContaining('forks already forks into 1 choice(s)'),
      'forks cannot be spliced into its own edge.',
    ]);
  });

  it('accepts a splice only where the carried scene is legal', () => {
    const verdicts = branchSplice.targets(state, 'quiet');
    expect(verdicts.filter((v) => v.accept).map((v) => v.target)).toEqual([
      'greet#choice:0',
      'rooftop#next',
      'forks#choice:0',
    ]);
  });

  it('gives unwire one target, since the arrowhead has nowhere else to land', () => {
    const verdicts = branchUnwire.targets(state, 'greet#choice:0');
    expect(verdicts).toEqual([
      {
        target: CANVAS,
        accept: true,
        note: 'Removed greet → rooftop ("Say hello").',
        invoke: { id: 'story.removeChoice', props: { scene: 'greet', index: 0 } },
      },
    ]);
  });

  it('refuses an edge the graph no longer has rather than answering for a guess', () => {
    const [verdict] = branchUnwire.targets(state, 'gone#next');
    expect(verdict).toEqual({ target: CANVAS, accept: false, reason: 'No edge "gone#next".' });
  });
});
