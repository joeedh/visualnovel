import { UNRESOLVED, type Verdict } from '@vn/commands';
import { advance, finished, guide, satisfies, start, stepOf } from '../tour.js';
import { commandKey, itemKey, type Anchor, type AnchorMap, type LiveAnchors } from '../anchors.js';
import type { Step, Tour } from '../../../src/shared/tours.js';
import type { EditorId } from '../../../src/shared/editors.js';

const node = {
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }),
};

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  key: commandKey('asset.regenerate'),
  id: 'asset.regenerate',
  props: { hash: 'a1b2' },
  enabled: true,
  editor: 'asset' as EditorId,
  via: { kind: 'dom', node },
  ...over,
});

const live = (anchors: Anchor[], over: Partial<LiveAnchors> = {}): LiveAnchors => ({
  anchors,
  open: ['asset' as EditorId],
  ...over,
});

const map: AnchorMap = { editorsFor: { 'asset.regenerate': ['asset' as EditorId] } };

const redraw: Step = { kind: 'command', id: 'asset.regenerate', say: 'Press Redraw.' };

const tour = (steps: Step[]): Tour => ({ id: 't', title: 'T', what: 'nothing', steps });

describe('walking a tour', () => {
  it('starts on the first step and finishes past the last', () => {
    const state = start(tour([redraw]));
    expect(stepOf(state)).toBe(redraw);
    expect(finished(state)).toBe(false);
    expect(finished(advance(state))).toBe(true);
    expect(stepOf(advance(state))).toBeUndefined();
  });
});

describe('guide', () => {
  const state = start(tour([redraw]));

  it('rings the control the app draws for the step', () => {
    const shown = guide(map, live([anchor()]), state);
    expect(shown).toMatchObject({ show: 'ring', say: 'Press Redraw.' });
  });

  it('passes on the app’s own refusal rather than writing one, and rings what refused', () => {
    const greyed = anchor({ enabled: false, reason: 'This take is already approved.' });
    expect(guide(map, live([greyed]), state)).toEqual({
      show: 'blocked',
      say: 'Press Redraw.',
      reason: 'This take is already approved.',
      where: { state: 'disabled', anchor: greyed, reason: 'This take is already approved.' },
    });
  });

  it('names the pane to open when the map knows where the control lives', () => {
    expect(guide(map, live([], { open: [] }), state)).toEqual({
      show: 'open',
      say: 'Press Redraw.',
      editor: 'asset',
    });
  });

  it('routes to the palette for a command no pane draws', () => {
    const unknown = start(tour([{ kind: 'command', id: 'doc.write', say: 'Save it.' }]));
    expect(guide(map, live([]), unknown)).toEqual({
      show: 'route',
      say: 'Save it.',
      action: { id: 'doc.write', props: {} },
    });
  });

  it('rings the row that publishes a subject for a select step', () => {
    // No `id`: a row publishes a subject rather than running a command.
    const { id: _id, ...rest } = anchor({ key: itemKey('scene', 'greet') });
    const row: Anchor = rest;
    const picking = start(
      tour([{ kind: 'select', itemKind: 'scene', key: 'greet', say: 'Pick the arrival scene.' }]),
    );
    expect(guide(map, live([row]), picking)).toMatchObject({ show: 'ring' });
  });

  it('says so when nothing on screen names the subject a select step wants', () => {
    const picking = start(
      tour([{ kind: 'select', itemKind: 'scene', key: 'ending', say: 'Pick the last scene.' }]),
    );
    expect(guide(map, live([]), picking)).toMatchObject({ show: 'blocked' });
  });
});

describe('a gesture step', () => {
  const drag: Step = {
    kind: 'gesture',
    id: 'branch.connect',
    carried: 'arrival',
    target: 'greet',
    say: 'Drag the handle onto the next scene.',
  };
  const state = start(tour([drag]));

  const cards = (): Anchor[] =>
    ['arrival', 'greet', 'ending'].map((id) =>
      anchor({ key: itemKey('scene', id), id: undefined, editor: 'branches' as EditorId }),
    );

  const seen = live(cards(), { open: ['branches' as EditorId] });

  const judged = (verdicts: Verdict[]) => () => ({ editor: 'branches' as EditorId, verdicts });

  const wire: Verdict = {
    target: 'greet',
    accept: true,
    note: 'arrival now leads to greet.',
    invoke: { id: 'story.setNext', props: { scene: 'arrival', next: 'greet' } },
  };

  it('rings what is picked up and outlines what would take it', () => {
    const shown = guide(map, seen, state, judged([wire]));
    expect(shown).toMatchObject({
      show: 'ring',
      say: 'Drag the handle onto the next scene.',
      also: [itemKey('scene', 'greet')],
      awaits: { id: 'story.setNext', props: { scene: 'arrival', next: 'greet' } },
    });
  });

  it('passes on the verdict’s own refusal', () => {
    const refused: Verdict = { target: 'greet', accept: false, reason: 'greet already forks.' };
    expect(guide(map, seen, state, judged([refused]))).toMatchObject({
      show: 'blocked',
      reason: 'greet already forks.',
    });
  });

  it('says so when no open surface can judge the gesture', () => {
    expect(guide(map, seen, state, () => undefined)).toMatchObject({
      show: 'blocked',
      reason: 'Nothing on screen runs branch.connect yet.',
    });
  });

  it('reports a carried token the state does not have', () => {
    const lost: Verdict = { target: UNRESOLVED, accept: false, reason: 'No scene "arrival".' };
    expect(guide(map, seen, state, judged([lost]))).toMatchObject({
      show: 'blocked',
      reason: 'No scene "arrival".',
    });
  });

  it('outlines every target that would take it when the step names none', () => {
    const open = start(tour([{ ...drag, target: undefined }]));
    const both: Verdict[] = [
      wire,
      { ...wire, target: 'ending', invoke: { id: 'story.setNext', props: { next: 'ending' } } },
      { target: 'arrival', accept: false, reason: 'A scene cannot lead to itself.' },
    ];
    expect(guide(map, seen, open, judged(both))).toMatchObject({
      show: 'ring',
      also: [itemKey('scene', 'greet'), itemKey('scene', 'ending')],
    });
  });

  it('advances on the invocation the verdict named, and on nothing else', () => {
    const awaits = { id: 'story.setNext', props: { scene: 'arrival', next: 'greet' } };
    expect(satisfies(drag, awaits, awaits)).toBe(true);
    expect(satisfies(drag, { id: 'story.setNext', props: { scene: 'arrival' } }, awaits)).toBe(
      false,
    );
    expect(satisfies(drag, awaits)).toBe(false);
  });
});

describe('satisfies', () => {
  it('advances on the step’s own invocation', () => {
    expect(satisfies(redraw, { id: 'asset.regenerate', props: { hash: 'a1b2' } })).toBe(true);
  });

  it('does not advance on another command', () => {
    expect(satisfies(redraw, { id: 'asset.accept', props: {} })).toBe(false);
  });

  it('ignores the prop an input step said the author would type', () => {
    const typed: Step = {
      kind: 'input',
      id: 'art.setNotes',
      props: { target: 'location:cafe/night', notes: '' },
      supplies: 'notes',
      say: 'Say what you want changed.',
    };
    const ran = { id: 'art.setNotes', props: { target: 'location:cafe/night', notes: 'colder' } };
    expect(satisfies(typed, ran)).toBe(true);
    expect(
      satisfies(typed, { ...ran, props: { target: 'location:cafe/day', notes: 'colder' } }),
    ).toBe(false);
  });

  it('never advances on a select step, which runs nothing', () => {
    const pick: Step = { kind: 'select', itemKind: 'scene', key: 'greet', say: 'Pick it.' };
    expect(satisfies(pick, { id: 'view.open', props: {} })).toBe(false);
  });
});
