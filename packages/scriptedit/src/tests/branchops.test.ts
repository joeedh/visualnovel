import { removeChoice, setChoice, setNext, spliceScene, type SceneMap } from '../branchops.js';

type Stub = { id: string; choices: { label: string; goto: string }[]; next?: string };

const scenes = (...list: Stub[]): SceneMap =>
  new Map(
    list.map((s) => [
      s.id,
      { id: s.id, choices: s.choices, ...(s.next !== undefined ? { next: s.next } : {}) },
    ]),
  );

/** arrival forks; greet and rooftop both continue linearly to dinner. */
const FORK = scenes(
  {
    id: 'arrival',
    choices: [
      { label: 'Introduce yourself', goto: 'greet' },
      { label: 'Look at the view', goto: 'rooftop' },
    ],
  },
  { id: 'greet', choices: [], next: 'dinner' },
  { id: 'rooftop', choices: [], next: 'dinner' },
  { id: 'dinner', choices: [] },
);

describe('setChoice', () => {
  it('appends a choice when no index is given', () => {
    const op = setChoice(FORK, { scene: 'arrival', goto: 'dinner', label: 'Slip away' });
    expect(op).toMatchObject({
      ok: true,
      edits: [
        {
          sceneId: 'arrival',
          choices: [
            { label: 'Introduce yourself', goto: 'greet' },
            { label: 'Look at the view', goto: 'rooftop' },
            { label: 'Slip away', goto: 'dinner' },
          ],
        },
      ],
    });
  });

  it('replaces the choice at an index, leaving the others alone', () => {
    const op = setChoice(FORK, {
      scene: 'arrival',
      goto: 'dinner',
      label: 'Head inside',
      index: 0,
    });
    expect(op.ok && op.edits[0]?.choices).toEqual([
      { label: 'Head inside', goto: 'dinner' },
      { label: 'Look at the view', goto: 'rooftop' },
    ]);
  });

  // A `goto` with no scene behind it is a diagnostic the editor draws, not an authoring error.
  it('allows a choice pointing at a scene that does not exist yet', () => {
    const op = setChoice(FORK, { scene: 'arrival', goto: 'unwritten', label: 'Leave' });
    expect(op.ok).toBe(true);
  });

  it('refuses an unknown scene and an out-of-range index', () => {
    expect(setChoice(FORK, { scene: 'ghost', goto: 'greet', label: 'x' })).toEqual({
      ok: false,
      error: 'No scene "ghost".',
    });
    expect(setChoice(FORK, { scene: 'arrival', goto: 'greet', label: 'x', index: 7 })).toEqual({
      ok: false,
      error: 'arrival has no choice at index 7.',
    });
  });

  it('does not mutate the scenes it was handed', () => {
    setChoice(FORK, { scene: 'arrival', goto: 'dinner', label: 'Slip away' });
    expect(FORK.get('arrival')?.choices).toHaveLength(2);
  });
});

describe('removeChoice', () => {
  it('drops one choice and names it in the message', () => {
    const op = removeChoice(FORK, { scene: 'arrival', index: 1 });
    expect(op.ok && op.edits[0]?.choices).toEqual([{ label: 'Introduce yourself', goto: 'greet' }]);
    expect(op.ok && op.message).toBe('Removed arrival → rooftop ("Look at the view").');
  });

  it('leaves an empty choice list rather than refusing to remove the last one', () => {
    const one = scenes({ id: 'a', choices: [{ label: 'Only', goto: 'b' }] });
    const op = removeChoice(one, { scene: 'a', index: 0 });
    expect(op.ok && op.edits[0]?.choices).toEqual([]);
  });

  it('refuses an index that is not there', () => {
    expect(removeChoice(FORK, { scene: 'greet', index: 0 })).toEqual({
      ok: false,
      error: 'greet has no choice at index 0.',
    });
  });
});

describe('setNext', () => {
  it('sets a linear continuation', () => {
    expect(setNext(FORK, { scene: 'dinner', goto: 'arrival' })).toMatchObject({
      ok: true,
      edits: [{ sceneId: 'dinner', next: 'arrival' }],
    });
  });

  // `null` is the patcher's "remove the marker"; `undefined` would mean "leave it alone".
  it('clears with an explicit null when goto is omitted or blank', () => {
    expect(setNext(FORK, { scene: 'greet' })).toMatchObject({
      ok: true,
      edits: [{ sceneId: 'greet', next: null }],
    });
    expect(setNext(FORK, { scene: 'greet', goto: '  ' })).toMatchObject({
      ok: true,
      edits: [{ sceneId: 'greet', next: null }],
    });
  });

  it('refuses to clear a next that is not there', () => {
    expect(setNext(FORK, { scene: 'dinner' })).toEqual({
      ok: false,
      error: 'dinner has no next scene to clear.',
    });
  });
});

describe('spliceScene', () => {
  const WITH_SPARE = scenes(
    {
      id: 'arrival',
      choices: [
        { label: 'Introduce yourself', goto: 'greet' },
        { label: 'Look at the view', goto: 'rooftop' },
      ],
    },
    { id: 'greet', choices: [], next: 'dinner' },
    { id: 'rooftop', choices: [], next: 'dinner' },
    { id: 'dinner', choices: [] },
    { id: 'hallway', choices: [] },
    { id: 'crossroads', choices: [{ label: 'Left', goto: 'greet' }] },
  );

  it('rewires a choice edge and continues from the new scene, in one patch', () => {
    const op = spliceScene(WITH_SPARE, { scene: 'hallway', from: 'arrival', edge: 0 });
    expect(op).toMatchObject({
      ok: true,
      edits: [
        {
          sceneId: 'arrival',
          choices: [
            // `spliceScene` rule 4: the label stays with the decision, only its first stop changed
            { label: 'Introduce yourself', goto: 'hallway' },
            { label: 'Look at the view', goto: 'rooftop' },
          ],
        },
        { sceneId: 'hallway', next: 'greet' },
      ],
    });
  });

  it('splices into a next edge when no choice index is given', () => {
    const op = spliceScene(WITH_SPARE, { scene: 'hallway', from: 'greet' });
    expect(op).toMatchObject({
      ok: true,
      edits: [
        { sceneId: 'greet', next: 'hallway' },
        { sceneId: 'hallway', next: 'dinner' },
      ],
    });
  });

  // `spliceScene` rule 1: `next` is only followed when a scene has no choices, so this edge would
  // be dead
  it('refuses a middle scene that already forks', () => {
    const op = spliceScene(WITH_SPARE, { scene: 'crossroads', from: 'greet' });
    expect(op.ok).toBe(false);
    expect(!op.ok && op.error).toContain('already forks');
    expect(!op.ok && op.error).toContain('would never be taken');
  });

  // `spliceScene` rule 2: the middle scene's other inbound edges are untouched; only the source
  // scene's edge moves
  it('leaves the middle scene’s other inbound edges alone', () => {
    const inbound = scenes(
      { id: 'a', choices: [], next: 'b' },
      { id: 'b', choices: [] },
      { id: 'z', choices: [], next: 'c' },
      { id: 'c', choices: [] },
    );
    const op = spliceScene(inbound, { scene: 'c', from: 'a' });
    expect(op.ok && op.edits.map((e) => e.sceneId)).toEqual(['a', 'c']);
  });

  // `spliceScene` rule 3: a loop back to a hub is normal VN structure, so only the degenerate
  // drops refuse
  it('allows a splice that creates a cycle', () => {
    const loop = scenes(
      { id: 'hub', choices: [], next: 'a' },
      { id: 'a', choices: [], next: 'hub' },
      { id: 'b', choices: [] },
    );
    expect(spliceScene(loop, { scene: 'b', from: 'a' }).ok).toBe(true);
  });

  it('refuses the degenerate drops — onto its own edge, or onto the target it already is', () => {
    expect(spliceScene(WITH_SPARE, { scene: 'greet', from: 'greet' })).toEqual({
      ok: false,
      error: 'greet cannot be spliced into its own edge.',
    });
    expect(spliceScene(WITH_SPARE, { scene: 'dinner', from: 'greet' })).toEqual({
      ok: false,
      error: 'dinner is already the target of that edge.',
    });
  });

  it('refuses an edge that is not there', () => {
    expect(spliceScene(WITH_SPARE, { scene: 'hallway', from: 'dinner' })).toEqual({
      ok: false,
      error: 'dinner has no next scene to splice into.',
    });
    expect(spliceScene(WITH_SPARE, { scene: 'hallway', from: 'arrival', edge: 5 })).toEqual({
      ok: false,
      error: 'arrival has no choice at index 5.',
    });
  });

  it('refuses unknown scenes on either end', () => {
    expect(spliceScene(WITH_SPARE, { scene: 'ghost', from: 'greet' })).toEqual({
      ok: false,
      error: 'No scene "ghost".',
    });
    expect(spliceScene(WITH_SPARE, { scene: 'hallway', from: 'ghost' })).toEqual({
      ok: false,
      error: 'No scene "ghost".',
    });
  });

  // Splicing over an existing `next` drops an edge, and the message is where the CommandRecord
  // learns about it, so the exact wording is pinned here
  it('reports the next it replaced', () => {
    const chain = scenes(
      { id: 'a', choices: [], next: 'b' },
      { id: 'b', choices: [] },
      { id: 'c', choices: [], next: 'z' },
      { id: 'z', choices: [] },
    );
    const op = spliceScene(chain, { scene: 'c', from: 'a' });
    expect(op.ok && op.message).toBe('Spliced c into a → b (replacing c → z).');
  });

  it('says nothing about a replacement when the next already pointed at the target', () => {
    const already = scenes(
      { id: 'a', choices: [], next: 'b' },
      { id: 'b', choices: [] },
      { id: 'c', choices: [], next: 'b' },
    );
    const op = spliceScene(already, { scene: 'c', from: 'a' });
    expect(op.ok && op.message).toBe('Spliced c into a → b.');
  });
});
