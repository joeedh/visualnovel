import {
  approveAction,
  badgesOf,
  characterOf,
  driftNote,
  locationOf,
  promoteAction,
  promptEditable,
  promptShown,
} from '../assetview.js';
import type { AssetInfo } from '../../../src/shared/ipc.js';

const info = (over: Partial<AssetInfo> = {}): AssetInfo => ({
  hash: 'a1b2c3d4',
  ext: 'png',
  kind: 'location_ref',
  label: 'Café Mori — night',
  base: true,
  accepted: false,
  sourceTask: 't1',
  stale: false,
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

  // The mirror of the concept case: a concept has no downstream, an upload has no upstream.
  it('refuses an upload, which nothing generated', () => {
    expect(approveAction(info({ kind: 'reference', label: 'moodboard.png' }))).toEqual({
      ok: false,
      reason: expect.stringContaining('pointed at'),
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
  // The whole prompt, not an empty box: an author edits the sentence they were given, and the
  // style preamble the generator wrapped it in survives unless they delete it themselves.
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
