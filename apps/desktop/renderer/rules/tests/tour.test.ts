import { EMPTY_DIGEST, UNRESOLVED, type Verdict } from '@vn/commands';
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

  /**
   * The gate button in the task graph is drawn enabled because opening a form is not what was
   * refused. `stack.check`, asked separately, is the only thing that knows.
   */
  it('blocks an enabled control the stack refuses, and still says where it is', () => {
    const drawn = anchor({ supplies: ['hash'], form: true });
    const shown = guide(map, live([drawn]), state, undefined, (key) =>
      key === drawn.key ? 'aiko has no portrait yet.' : undefined,
    );
    expect(shown).toEqual({
      show: 'blocked',
      say: 'Press Redraw.',
      reason: 'aiko has no portrait yet.',
      where: { state: 'ready', anchor: drawn },
    });
  });

  it('rings as usual where the stack accepts, or has not answered', () => {
    expect(guide(map, live([anchor()]), state, undefined, () => undefined)).toMatchObject({
      show: 'ring',
    });
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

describe('a step whose control is on another subject', () => {
  const step: Step = {
    kind: 'command',
    id: 'asset.regenerate',
    props: { hash: 'ffff' },
    say: 'Redraw it.',
  };
  const state = start(tour([step]));
  const elsewhere = anchor({ props: { hash: 'a1b2' } });
  const row = (): Anchor => ({
    key: itemKey('asset', 'ffff'),
    props: {},
    enabled: true,
    publishes: { assetHash: 'ffff' },
    editor: 'documents' as EditorId,
    via: { kind: 'dom', node },
  });
  const seen = (anchors: Anchor[]): LiveAnchors =>
    live(anchors, { open: ['asset', 'documents'] as EditorId[] });

  it('rings the row that selects the subject rather than the button on the wrong one', () => {
    expect(guide(map, seen([elsewhere, row()]), state)).toMatchObject({
      show: 'pick',
      say: 'Redraw it.',
      where: { state: 'ready', anchor: row() },
    });
  });

  it('says which subject is missing when nothing on screen selects it', () => {
    expect(guide(map, seen([elsewhere]), state)).toEqual({
      show: 'blocked',
      say: 'Redraw it.',
      reason: 'Nothing on screen selects ffff, which is what this step acts on.',
    });
  });

  it('rings the control as before when the step names a prop the control does not take', () => {
    const extra: Step = { ...step, props: { hash: 'a1b2', mock: true } };
    expect(guide(map, seen([anchor()]), start(tour([extra])))).toMatchObject({ show: 'ring' });
  });

  /** `record` stores no props for a refused offer, so a greyed control lands here with none. */
  it('answers with the control’s own refusal where it is greyed and names no subject', () => {
    const greyed = anchor({ props: {}, enabled: false, reason: 'Nothing is shown here.' });
    expect(guide(map, seen([greyed]), state)).toEqual({
      show: 'blocked',
      say: 'Redraw it.',
      reason: 'Nothing is shown here.',
      where: {
        state: 'wrong-subject',
        anchor: greyed,
        needs: { id: 'asset.regenerate', props: { hash: 'ffff' } },
        holds: [],
      },
    });
  });

  /**
   * The case a search over every unmatched value gets wrong: `speaker` is free text the anchor
   * does not record, and it names the character row, which is not what the step acts on.
   */
  it('does not ring a row named by a prop the anchor never held', () => {
    const line: Step = {
      kind: 'command',
      id: 'story.setLine',
      props: { sceneId: 'greet', lineId: 'l3', speaker: 'aiko', text: 'Hello.' },
      say: 'Set the line.',
    };
    const box = anchor({
      key: commandKey('story.setLine'),
      id: 'story.setLine',
      props: { sceneId: 'greet' },
    });
    const character: Anchor = {
      key: itemKey('character', 'aiko'),
      props: {},
      enabled: true,
      publishes: { characterId: 'aiko' },
      editor: 'documents' as EditorId,
      via: { kind: 'dom', node },
    };
    expect(guide(map, seen([box, character]), start(tour([line])))).toMatchObject({ show: 'ring' });
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

  /** `art.setNotes` takes an empty note as a legitimate value: it removes the note. */
  it('waits for the value an input step asked for, rather than counting a blank field', () => {
    const typed: Step = {
      kind: 'input',
      id: 'art.setNotes',
      props: { target: 'location:cafe/night' },
      supplies: 'notes',
      say: 'Say what you want changed.',
    };
    const ran = { id: 'art.setNotes', props: { target: 'location:cafe/night', notes: '' } };
    expect(satisfies(typed, ran)).toBe(false);
    expect(satisfies(typed, { ...ran, props: { target: 'location:cafe/night' } })).toBe(false);
    expect(satisfies(typed, { ...ran, props: { ...ran.props, notes: 'colder' } })).toBe(true);
  });

  /** What reaches here is the recorded props, so a bulk prop arrives digested either way. */
  it('reads the empty digest of a bulk prop as a blank field', () => {
    const written: Step = {
      kind: 'input',
      id: 'doc.write',
      props: { path: 'wiki/ada.md' },
      supplies: 'text',
      say: 'Write the entry.',
    };
    const ran = { id: 'doc.write', props: { path: 'wiki/ada.md', text: EMPTY_DIGEST } };
    expect(satisfies(written, ran)).toBe(false);
    expect(
      satisfies(written, { ...ran, props: { ...ran.props, text: '<sha256:2cf24dba5fb0+5>' } }),
    ).toBe(true);
  });

  it('never advances on a select step, which runs nothing', () => {
    const pick: Step = { kind: 'select', itemKind: 'scene', key: 'greet', say: 'Pick it.' };
    expect(satisfies(pick, { id: 'view.open', props: {} })).toBe(false);
  });
});
