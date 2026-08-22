import {
  approveAction,
  badgesOf,
  characterOf,
  driftNote,
  failureNote,
  locationOf,
  promoteAction,
  promptEditable,
  promptShown,
  replaceAction,
  watchSlot,
} from '../assetview.js';
import type { AssetFailure, AssetInfo } from '../../../src/shared/ipc.js';

const info = (over: Partial<AssetInfo> = {}): AssetInfo => ({
  hash: 'a1b2c3d4',
  ext: 'png',
  kind: 'location_ref',
  label: 'Café Mori — night',
  base: true,
  accepted: false,
  sourceTask: 't1',
  stale: false,
  prereqs: [],
  rungs: [],
  ...over,
});

const portrait = (over: Partial<AssetInfo> = {}): AssetInfo =>
  info({
    kind: 'portrait',
    label: 'Aiko',
    rungs: [{ target: 'character:aiko', label: 'Aiko' }],
    ...over,
  });

const failed = (over: Partial<AssetFailure> = {}): AssetFailure => ({
  task: 't1',
  status: 'failed',
  error: 'the image model returned 503',
  attempts: 2,
  maxAttempts: 2,
  later: false,
  ...over,
});

const concept = (over: Partial<AssetInfo> = {}): AssetInfo =>
  info({
    kind: 'concept',
    label: 'Café Mori — an aerial shot at dawn',
    rungs: [{ target: 'location:cafe', label: 'Café Mori' }],
    ...over,
  });

describe('characterOf', () => {
  it('reads the id out of a rung, sub-rung and all', () => {
    expect(
      characterOf(portrait({ rungs: [{ target: 'character:aiko/gala', label: 'gala' }] })),
    ).toBe('aiko');
  });

  it('is empty when no rung names a character', () => {
    expect(characterOf(info({ rungs: [{ target: 'location:cafe', label: 'Café' }] }))).toBe('');
  });
});

describe('locationOf', () => {
  it('reads the id out of a rung, sub-rung and all', () => {
    expect(locationOf(info({ rungs: [{ target: 'location:cafe/night', label: 'night' }] }))).toBe(
      'cafe',
    );
  });

  it('is empty when no rung names a location', () => {
    expect(locationOf(portrait())).toBe('');
  });
});

describe('promoteAction', () => {
  it('offers the location a concept sketches', () => {
    expect(promoteAction(concept())).toEqual({ ok: true, locationId: 'cafe' });
  });

  // A character's look is the gate's business — `character.md` and `approved.png` are what
  // actually clear one, and promotion writes neither.
  it('refuses a character concept, and a plate that is already what it is', () => {
    const person = promoteAction(concept({ rungs: [{ target: 'character:aiko', label: 'Aiko' }] }));
    expect(person).toEqual({ ok: false, reason: expect.stringContaining('approval gate') });
    expect(promoteAction(info())).toEqual({
      ok: false,
      reason: expect.stringContaining('only a concept'),
    });
  });

  it('refuses a concept bound to nothing, rather than picking a sheet', () => {
    expect(promoteAction(concept({ rungs: [] }))).toEqual({
      ok: false,
      reason: expect.stringContaining('no location'),
    });
  });
});

describe('replaceAction', () => {
  it('offers the slot the asset itself fills', () => {
    expect(replaceAction(info({ slot: 'plate:cafe/night' }))).toEqual({
      ok: true,
      slot: 'plate:cafe/night',
    });
  });

  // A concept and an upload have no slot, and neither does a render something newer superseded —
  // main leaves the field off for all three, so the strip is absent for all three.
  it('is absent for anything that is not the picture in a slot', () => {
    expect(replaceAction(concept())).toEqual({
      ok: false,
      reason: expect.stringContaining('fills no slot'),
    });
  });

  it('refuses a portrait, whose look is the gate’s to bless', () => {
    expect(replaceAction(portrait({ slot: 'portrait:aiko' }))).toEqual({
      ok: false,
      reason: expect.stringContaining('gate.approve'),
    });
  });
});

describe('approveAction', () => {
  it('sends a portrait to the gate, which is the command that also writes character.md', () => {
    expect(approveAction(portrait())).toEqual({
      ok: true,
      id: 'gate.approve',
      props: { characterId: 'aiko', hash: 'a1b2c3d4' },
      label: 'Approve',
    });
  });

  it('accepts anything else generically, across both roots', () => {
    expect(approveAction(info())).toEqual({
      ok: true,
      id: 'asset.accept',
      props: { hash: 'a1b2c3d4' },
      label: 'Accept',
    });
  });

  // Approving a second candidate is how an author changes their mind, so the button stays live
  // and says what it would do rather than going quiet.
  it('says re-approve over one that already stands', () => {
    const again = approveAction(portrait({ accepted: true }));
    const accepted = approveAction(info({ accepted: true }));
    expect(again.ok && again.label).toBe('Re-approve');
    expect(accepted.ok && accepted.label).toBe('Re-accept');
  });

  // `accepted` means a human approved this for use downstream, and nothing downstream consumes a
  // concept — so the button says so instead of offering a state with no meaning.
  it('refuses a concept, which promotion is for', () => {
    expect(approveAction(concept())).toEqual({
      ok: false,
      reason: expect.stringContaining('Promote it to a plate'),
    });
  });

  // A concept has no downstream and an upload has no upstream, so both are refused
  it('refuses an upload, which nothing generated', () => {
    expect(approveAction(info({ kind: 'reference', label: 'moodboard.png' }))).toEqual({
      ok: false,
      reason: expect.stringContaining('pointed at'),
    });
  });

  // The refusal is main's own sentence, shown verbatim: a disabled control's tooltip must carry
  // the same words `asset.accept` gives when the palette or the agent reaches it
  it('refuses while anything it was drawn from is unapproved, in main’s own words', () => {
    const waiting =
      'Approve what this was drawn from first: cafe — night plate is not approved yet.';
    expect(approveAction(info({ unapproved: waiting }))).toEqual({ ok: false, reason: waiting });
    // The unapproved check runs ahead of the portrait split, so the gate button greys out too
    expect(approveAction(portrait({ unapproved: waiting }))).toEqual({
      ok: false,
      reason: waiting,
    });
  });

  it('refuses a portrait whose character the project has lost, rather than guessing one', () => {
    expect(approveAction(portrait({ rungs: [] }))).toEqual({
      ok: false,
      reason: 'This portrait names no character — approve it from the gate.',
    });
  });
});

describe('promptEditable', () => {
  // The box starts with the whole prompt rather than empty, so the style preamble the generator
  // wrapped it in survives unless the author deletes it
  it('hands back the concept’s recorded prompt and name to start from', () => {
    expect(
      promptEditable(concept({ prompt: 'Subject: Café Mori. from above', title: 'aerial' })),
    ).toEqual({ ok: true, prompt: 'Subject: Café Mori. from above', title: 'aerial' });
  });

  it('starts empty for a concept the manifest recorded nothing for', () => {
    expect(promptEditable(concept())).toEqual({ ok: true, prompt: '', title: '' });
  });

  it('refuses every derived kind, naming the clauses as the way those move', () => {
    const plate = promptEditable(info());
    expect(plate).toEqual({ ok: false, reason: expect.stringContaining('a clause at a time') });
    expect(plate.ok === false && plate.reason).toContain('location_ref');
    expect(promptEditable(portrait())).toMatchObject({ ok: false });
  });
});

describe('watchSlot', () => {
  it('follows the slot forward when a run fills it again', () => {
    expect(watchSlot(info(), info({ newerTake: 'b2' }), true)).toEqual({
      holding: true,
      follow: 'b2',
    });
    expect(watchSlot(info(), info(), true)).toEqual({ holding: true, follow: '' });
  });

  it('arrives holding the take that fills the slot, and not one behind it', () => {
    expect(watchSlot(undefined, info(), false).holding).toBe(true);
    expect(watchSlot(info({ hash: 'e5f6' }), info({ newerTake: 'b2' }), true)).toEqual({
      holding: false,
      follow: '',
    });
  });

  // Walking back is a request for the older take, so the pane holds it however far behind it falls
  it('stays on a take it arrived behind, through the empty window an edit opens', () => {
    // An edit re-keys the slot, so the take it superseded reports no newer one until a render lands
    const empty = watchSlot(info({ newerTake: 'b2' }), info(), false);
    expect(empty).toEqual({ holding: false, follow: '' });
    expect(watchSlot(info(), info({ newerTake: 'b3' }), empty.holding).follow).toBe('');
  });
});

describe('badgesOf', () => {
  it('reads what it is, where it lives, and what is true of it', () => {
    expect(badgesOf(info())).toEqual(['location_ref', 'base']);
    expect(badgesOf(info({ base: false, accepted: true, stale: true }))).toEqual([
      'location_ref',
      'project',
      'accepted',
      'stale',
    ]);
  });
});

describe('driftNote', () => {
  it('is silent unless the bytes trail the words', () => {
    expect(driftNote(info())).toBe('');
    expect(driftNote(info({ stale: true }))).toContain('older prompt');
  });

  // The failure sentence already carries both halves of this one, about the newer task
  it('stands down when a later render already tried to catch up and failed', () => {
    expect(driftNote(info({ stale: true, failure: failed({ later: true }) }))).toBe('');
    expect(driftNote(info({ stale: true, failure: failed() }))).toContain('older prompt');
  });

  it('still reports a suspension over a failure, since the words may be fine', () => {
    const note = driftNote(info({ stale: true, suspended: 'a1b2 moved', failure: failed() }));
    expect(note).toContain('Suspended');
  });
});

describe('failureNote', () => {
  it('says nothing about an asset the pipeline has not given up on', () => {
    expect(failureNote(info())).toBe('');
  });

  it('quotes the retry budget and the provider’s own words for a fault', () => {
    expect(failureNote(info({ failure: failed() }))).toBe(
      'Generating this failed after 2 of 2 attempts — the image model returned 503. Regenerate to try again.',
    );
  });

  // A refine pass records no error, so counting attempts here would read as "tried 0 of 2 times"
  it('leaves the budget out of a frame that was drawn and then flagged', () => {
    const note = failureNote(
      info({
        failure: failed({
          status: 'needs_human',
          attempts: 0,
          error: 'shot still has blocking defects after 4 attempts',
        }),
      }),
    );
    expect(note).toContain('blocking defects');
    expect(note).not.toContain('of 2 attempts');
  });

  // Regenerating is the only thing that reaches a spent identity, so the note has to offer it
  it('says which frame is on screen when a re-render is what gave up, and what to do', () => {
    const note = failureNote(info({ failure: failed({ later: true }) }));
    expect(note).toContain('last frame that got through');
    expect(note).toContain('Regenerate');
  });

  it('reports a task that recorded no reason rather than trailing off', () => {
    const note = failureNote(info({ failure: failed({ error: undefined }) }));
    expect(note).toContain('no reason was recorded');
  });
});

describe('promptShown', () => {
  it('prefers today’s derivation, which is what a regenerate would send', () => {
    expect(promptShown(info({ prompt: 'old', derived: 'new' }))).toEqual({
      text: 'new',
      derived: true,
    });
  });

  it('falls back to what the bytes recorded when the project no longer describes it', () => {
    expect(promptShown(info({ prompt: 'old' }))).toEqual({ text: 'old', derived: false });
    expect(promptShown(info())).toEqual({ text: '', derived: false });
  });
});
