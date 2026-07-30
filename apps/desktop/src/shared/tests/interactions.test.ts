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
  createDesktopInteractions,
  handleId,
  scriptMoveLine,
  timelineCover,
  TOP,
  type BranchState,
  type CoverState,
} from '../interactions.js';
import { UNRESOLVED } from '@vn/commands';
import { splitScenes } from '@vn/model';
import { parseFountain } from '@vn/parse';
import type { SceneMap } from '../branchops.js';
import type { CoverageShot, StoryEdge } from '../ipc.js';
import type { ScriptState } from '@vn/scriptedit';

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

describe('timeline.cover', () => {
  const shot = (id: string, coversLines: string[]): CoverageShot => ({
    id,
    framing: 'medium',
    subjects: [],
    coversLines,
    status: 'accepted',
  });

  const cover: CoverState = {
    sceneId: 'arrival',
    lines: ['L1', 'L2', 'L3', 'L4'].map((n) => ({
      id: `arrival:${n}`,
      kind: 'narration' as const,
      text: n,
    })),
    shots: [
      shot('arrival__establishing', ['arrival:L1', 'arrival:L4']),
      shot('arrival__aiko', ['arrival:L2']),
      shot('arrival__ren', ['arrival:L3']),
    ],
  };

  it('judges only the rows the drop would change, in screenplay order', () => {
    const verdicts = timelineCover.targets(cover, handleId('arrival__aiko', 'end'));
    // aiko covers L2 alone: dropping its end on L2 is where it already is, and dropping it on L1
    // would retract past the start, which `resolveDrag` refuses to do. Neither is a candidate.
    expect(verdicts.map((v) => v.target)).toEqual(['arrival:L3', 'arrival:L4']);
  });

  it('carries the setCoverage the drop would run, ready to execute', () => {
    // Retracting the establishing shot's start off L1 releases it — a gap, not a hand-over.
    const [l2] = timelineCover.targets(cover, handleId('arrival__establishing', 'start'));
    expect(l2?.target).toBe('arrival:L2');
    expect(l2?.accept && l2.invoke).toEqual({
      id: 'story.setCoverage',
      props: { scene: 'arrival', shot: 'arrival__establishing', lines: 'arrival:L4' },
    });
  });

  it('refuses with the rule’s own sentence where a drop would empty a neighbour', () => {
    // Sweeping ren's start up over L2 claims aiko's only line, leaving it covering nothing.
    const verdicts = timelineCover.targets(cover, handleId('arrival__ren', 'start'));
    expect(verdicts.find((v) => v.target === 'arrival:L2')).toMatchObject({
      accept: false,
      reason: expect.stringContaining('leave arrival__aiko covering nothing'),
    });
  });

  it('refuses the grab, not the targets, when the carried handle names nothing', () => {
    expect(timelineCover.targets(cover, 'arrival__aiko')).toEqual([
      { target: UNRESOLVED, accept: false, reason: expect.stringContaining('Malformed handle') },
    ]);
    expect(timelineCover.targets(cover, handleId('arrival__gone', 'end'))).toEqual([
      { target: UNRESOLVED, accept: false, reason: expect.stringContaining('arrival__gone') },
    ]);
  });
});

describe('script.moveLine', () => {
  /** Real ids from the real allocator, for the reason `lineops.test.ts` gives. */
  const script: ScriptState = (() => {
    const split = splitScenes(
      parseFountain(`INT. CLASSROOM - EVENING

[[scene: arrival]]

Aiko slips into the seat by the window.

AIKO
You're late.

REN
The train stopped.
`),
    );
    expect(split.diagnostics).toEqual([]);
    return { scenes: new Map(split.scenes.map((s) => [s.id, s])), entry: 'arrival' };
  })();

  it('offers every insertion point that would reorder something, in scene order', () => {
    // L2 sits second of three, so `top` and "after L3" move it; "after L1" is where it is.
    const verdicts = scriptMoveLine.targets(script, 'arrival:L2');
    expect(verdicts.map((v) => v.target)).toEqual([TOP, 'arrival:L3']);
    expect(verdicts.every((v) => v.accept)).toBe(true);
  });

  it('drops the no-op at the top for a line already there', () => {
    const verdicts = scriptMoveLine.targets(script, 'arrival:L1');
    expect(verdicts.map((v) => v.target)).toEqual(['arrival:L2', 'arrival:L3']);
  });

  it('carries the moveLine the drop would run, with top as an empty after', () => {
    const [top] = scriptMoveLine.targets(script, 'arrival:L3');
    expect(top?.accept && top.invoke).toEqual({
      id: 'story.moveLine',
      props: { line: 'arrival:L3', after: '' },
    });
    expect(top?.accept && top.note).toBe('Moved arrival:L3 to the top in arrival.');
  });

  it('refuses the grab when the carried line is not in any loaded scene', () => {
    expect(scriptMoveLine.targets(script, 'arrival:L9')).toEqual([
      { target: UNRESOLVED, accept: false, reason: 'Scene "arrival" has no line "arrival:L9".' },
    ]);
    // A line of another scene is not a near-miss target: coverage cannot cross the boundary.
    expect(scriptMoveLine.targets(script, 'rooftop:L1')).toEqual([
      {
        target: UNRESOLVED,
        accept: false,
        reason: '"rooftop:L1" is not a line of any loaded scene.',
      },
    ]);
  });
});

describe('the registry', () => {
  it('holds every declared gesture, and each names only commands the app has', () => {
    const registry = createDesktopInteractions();
    expect(registry.list().map((i) => i.id)).toEqual([
      'branch.connect',
      'branch.splice',
      'branch.unwire',
      'script.moveLine',
      'timeline.cover',
    ]);
  });
});
