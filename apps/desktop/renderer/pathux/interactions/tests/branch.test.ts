import { branchState } from '../../../../src/shared/interactions.js';
import {
  GRAB,
  aim,
  cardMenu,
  commitOf,
  grabArrow,
  grabCard,
  grabHandle,
  newChoiceEdge,
  noticeOf,
  type Aim,
  type Drag,
} from '../branch.js';
import type { StoryEdge, StoryGraph, StoryScene } from '../../../../src/shared/ipc';

const scene = (id: string): StoryScene => ({
  id,
  location  : 'roof',
  characters: [],
  lines     : 3,
  reachable : true,
});

/** `a → b`, and `b` forks to `c` and `d`. So `a` has a linear continuation and `b` has choices. */
const EDGES: StoryEdge[] = [
  { id: 'a#next', from: 'a', to: 'b', kind: 'next', dangling: false, inert: false },
  {
    id      : 'b#choice:0',
    from    : 'b',
    to      : 'c',
    kind    : 'choice',
    label   : 'Left',
    index   : 0,
    dangling: false,
    inert   : false,
  },
  {
    id      : 'b#choice:1',
    from    : 'b',
    to      : 'd',
    kind    : 'choice',
    label   : 'Right',
    index   : 1,
    dangling: false,
    inert   : false,
  },
];

const story: StoryGraph = {
  start      : 'a',
  scenes     : ['a', 'b', 'c', 'd'].map(scene),
  edges      : EDGES,
  diagnostics: [],
};

const state = branchState(story);

const at = (x: number, y: number) => ({ x, y });

/** Aiming at nothing, at scale 1 — each test overrides only the part its gesture reads. */
const nowhere: Aim = { at: at(0, 0), node: null, edge: null, away: 0, scale: 1 };

const accepted = (drag: Drag) => {
  const verdict = drag.verdict;
  if (!verdict?.accept)
    throw new Error(`expected an accepted verdict, got ${JSON.stringify(verdict)}`);
  return verdict;
};

describe('what a grab captures', () => {
  test('a handle is judged against every scene, before the wire has moved', () => {
    const drag = grabHandle(state, 'c', at(0, 0));
    expect([...drag.verdicts.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(drag.verdict).toBeNull();
    expect(drag.over).toBeNull();
  });

  test('a card is judged against every wire — as a splice it may never become', () => {
    const drag = grabCard(state, 'c', at(0, 0));
    expect(drag.kind).toBe('press');
    expect([...drag.verdicts.keys()].sort()).toEqual(['a#next', 'b#choice:0', 'b#choice:1']);
  });

  test('an arrowhead has one target, and it is not armed yet', () => {
    const drag = grabArrow(state, 'b#choice:0', at(0, 0));
    expect([...drag.verdicts.keys()]).toEqual(['canvas']);
    expect(drag.armed).toBe(false);
    expect(drag.verdict).toBeNull();
  });
});

describe('wiring one scene to another', () => {
  test('a scene with nothing leaving it continues linearly', () => {
    const drag = aim(grabHandle(state, 'c', at(0, 0)), { ...nowhere, node: 'd' });
    expect(drag.over).toBe('d');
    expect(accepted(drag).invoke).toEqual({
      id   : 'story.setNext',
      props: { scene: 'c', goto: 'd' },
    });
  });

  test('a scene that already leads somewhere gains a choice', () => {
    const drag = aim(grabHandle(state, 'a', at(0, 0)), { ...nowhere, node: 'c' });
    expect(accepted(drag).invoke.id).toBe('story.setChoice');
  });

  test('over empty canvas there is no verdict and nothing to say', () => {
    const drag = aim(grabHandle(state, 'a', at(0, 0)), nowhere);
    expect(drag.over).toBeNull();
    expect(noticeOf(drag)).toBeNull();
    expect(commitOf(drag)).toBeNull();
  });

  test('the appended choice is the one whose label opens', () => {
    expect(newChoiceEdge(state, 'a')).toBe('a#choice:0');
    expect(newChoiceEdge(state, 'b')).toBe('b#choice:2');
    // `c` gains a linear continuation, so there is no new choice to name.
    expect(newChoiceEdge(state, 'c')).toBeNull();
  });
});

describe('a press becomes a splice', () => {
  const press = grabCard(state, 'c', at(0, 0));

  test('travel within the slop is still a click', () => {
    const drag = aim(press, { ...nowhere, at: at(3, 0), edge: 'a#next' });
    expect(drag.kind).toBe('press');
    expect(drag.verdict).toBeNull();
    expect(commitOf(drag)).toBeNull();
  });

  test('the same move that promotes it also aims it', () => {
    const drag = aim(press, { ...nowhere, at: at(40, 0), edge: 'a#next' });
    expect(drag.kind).toBe('splice');
    expect(drag.over).toBe('a#next');
    expect(accepted(drag).invoke).toEqual({
      id   : 'story.spliceScene',
      props: { scene: 'c', from: 'a' },
    });
  });

  test('the slop is screen-pixels, so a zoomed-out canvas needs more world travel', () => {
    const drag = aim(press, { ...nowhere, at: at(30, 0), edge: 'a#next', scale: 0.1 });
    expect(drag.kind).toBe('press');
  });

  test('a wire that will not take the card says so, in the rule’s own words', () => {
    // `b` forks, so its `next` would never be followed — `spliceScene` refuses rather than
    // writing a continuation the runner ignores.
    const drag = aim(grabCard(state, 'b', at(0, 0)), { ...nowhere, at: at(40, 0), edge: 'a#next' });
    expect(drag.verdict?.accept).toBe(false);
    expect(noticeOf(drag)).toEqual({ tone: 'refused', text: expect.any(String) });
    expect(commitOf(drag)).toBeNull();
  });
});

describe('pulling a wire off its target', () => {
  test('nothing is previewed until the pointer has left the arrowhead', () => {
    const drag = aim(grabArrow(state, 'b#choice:0', at(0, 0)), { ...nowhere, away: GRAB - 1 });
    expect(drag.kind === 'unwire' && drag.armed).toBe(false);
    expect(noticeOf(drag)).toBeNull();
  });

  test('a choice pulled off is removed by index', () => {
    const drag = aim(grabArrow(state, 'b#choice:1', at(0, 0)), { ...nowhere, away: GRAB + 1 });
    expect(drag.kind === 'unwire' && drag.armed).toBe(true);
    expect(commitOf(drag)).toEqual({ id: 'story.removeChoice', props: { scene: 'b', index: 1 } });
  });

  test('a linear continuation pulled off is cleared', () => {
    const drag = aim(grabArrow(state, 'a#next', at(0, 0)), { ...nowhere, away: GRAB + 1 });
    expect(commitOf(drag)).toEqual({ id: 'story.setNext', props: { scene: 'a', goto: '' } });
  });

  test('an edge that is no longer there refuses rather than throwing', () => {
    const drag = aim(grabArrow(state, 'gone#next', at(0, 0)), { ...nowhere, away: GRAB + 1 });
    expect(drag.verdict?.accept).toBe(false);
  });
});

describe('right-clicking a card', () => {
  test('offers the script, which a plain click on this canvas does not open', () => {
    expect(cardMenu('a', false)).toEqual([
      { label: 'Go to script', id: 'view.open', props: { editor: 'script', where: 'elsewhere' } },
    ]);
  });

  // A stub names a scene nothing wrote, so the one act it has is writing it — as a form, because a
  // heading is not something a menu row can supply.
  test('offers to write the scene a stub stands for', () => {
    expect(cardMenu('missing', true)).toEqual([
      { label: 'Write missing…', id: 'story.newScene', props: { scene: 'missing' }, form: true },
    ]);
  });
});
