import {
  reloadAction,
  menuAction,
  backAction,
  approveAction,
  badgesOf,
  blockedNote,
  characterOf,
  controls,
  driftNote,
  exportAction,
  failureNote,
  failureTaskAction,
  fixAction,
  locationOf,
  notesAction,
  prereqAction,
  promoteAction,
  promoteBox,
  promptEditable,
  promptShown,
  redrawBox,
  redrawGo,
  regenerateAction,
  replaceAction,
  modelAction,
  seedAction,
  taskAction,
  watchSlot,
} from '../assetview.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import type { AssetFailure, AssetInfo } from '../../../src/shared/ipc.js';

const info = (over: Partial<AssetInfo> = {}): AssetInfo => ({
  hash      : 'a1b2c3d4',
  ext       : 'png',
  kind      : 'location_ref',
  label     : 'Café Mori — night',
  base      : true,
  accepted  : false,
  sourceTask: 't1',
  stale     : false,
  prereqs   : [],
  rungs     : [],
  ...over,
});

const portrait = (over: Partial<AssetInfo> = {}): AssetInfo =>
  info({
    kind : 'portrait',
    label: 'Aiko',
    rungs: [{ target: 'character:aiko', label: 'Aiko' }],
    ...over,
  });

const failed = (over: Partial<AssetFailure> = {}): AssetFailure => ({
  task       : 't1',
  status     : 'failed',
  error      : 'the image model returned 503',
  attempts   : 2,
  maxAttempts: 2,
  later      : false,
  ...over,
});

const concept = (over: Partial<AssetInfo> = {}): AssetInfo =>
  info({
    kind : 'concept',
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
  it('offers the location a concept sketches, with the variant left to the field', () => {
    expect(promoteAction(concept())).toEqual({
      ok        : true,
      id        : 'art.promote',
      props     : { hash: 'a1b2c3d4' },
      label     : 'Promote',
      tooltip   : 'Make this sketch the plate for that variant, so the next run adopts it',
      supplies  : ['variant'],
      locationId: 'cafe',
      variants  : [],
    });
  });

  // The strip offers these beside its field; a name the sheet does not carry yet is still typed.
  it('carries the variants that location already has', () => {
    const offer = promoteAction(concept({ locationVariants: ['day', 'night'] }));
    expect(offer.ok && offer.variants).toEqual(['day', 'night']);
  });

  // A character's look is the gate's business. Only character.md and approved.png actually
  // clear the gate, and promotion writes neither.
  it('refuses a character concept, and a plate that is already what it is', () => {
    const person = promoteAction(concept({ rungs: [{ target: 'character:aiko', label: 'Aiko' }] }));
    expect(person).toMatchObject({
      ok     : false,
      id     : 'art.promote',
      refusal: { reason: expect.stringContaining('approval gate') },
    });
    expect(promoteAction(info())).toMatchObject({
      ok     : false,
      id     : 'art.promote',
      refusal: { reason: expect.stringContaining('only a concept') },
    });
  });

  it('refuses a concept bound to nothing, rather than picking a sheet', () => {
    expect(promoteAction(concept({ rungs: [] }))).toMatchObject({
      ok     : false,
      id     : 'art.promote',
      refusal: { reason: expect.stringContaining('no location') },
    });
  });
});

describe('replaceAction', () => {
  it('offers the slot the asset itself fills', () => {
    expect(replaceAction(info({ slot: 'plate:cafe/night' }))).toEqual({
      ok     : true,
      id     : 'asset.replace',
      props  : { hash: 'a1b2c3d4' },
      label  : 'Replace with a file…',
      tooltip: 'Choose a file and let it stand in for plate:cafe/night from now on',
      slot   : 'plate:cafe/night',
    });
  });

  // A concept and an upload have no slot, and neither does a render something newer superseded —
  // main leaves the field off for all three, so the strip is absent for all three.
  it('is absent for anything that is not the picture in a slot', () => {
    expect(replaceAction(concept())).toMatchObject({
      ok     : false,
      id     : 'asset.replace',
      refusal: { reason: expect.stringContaining('fills no slot') },
    });
  });

  it('refuses a portrait, whose look is the gate’s to bless', () => {
    expect(replaceAction(portrait({ slot: 'portrait:aiko' }))).toMatchObject({
      ok     : false,
      id     : 'asset.replace',
      refusal: { reason: expect.stringContaining('gate.approve') },
    });
  });
});

describe('approveAction', () => {
  it('sends a portrait to the gate, which is the command that also writes character.md', () => {
    expect(approveAction(portrait())).toEqual({
      ok     : true,
      id     : 'gate.approve',
      props  : { characterId: 'aiko', hash: 'a1b2c3d4' },
      label  : 'Approve',
      tooltip: expect.stringContaining('gate'),
    });
  });

  it('accepts anything else generically, across both roots', () => {
    expect(approveAction(info())).toEqual({
      ok     : true,
      id     : 'asset.accept',
      props  : { hash: 'a1b2c3d4' },
      label  : 'Accept',
      tooltip: 'Accept these bytes for use downstream',
    });
  });

  // Approving what is already approved writes what the manifest already says, so the button turns
  // around and offers the only act left on it — through the one command that undoes either door.
  it('offers to take the approval back off one that already stands', () => {
    const both = [portrait({ accepted: true }), info({ accepted: true })];
    for (const one of both) {
      expect(approveAction(one)).toEqual({
        ok     : true,
        id     : 'asset.unapprove',
        props  : { hash: 'a1b2c3d4' },
        label  : 'Un-approve',
        tooltip: expect.stringContaining('Take approval back'),
      });
    }
  });

  it('refuses with nothing on screen, still naming what it would run', () => {
    expect(approveAction(undefined)).toMatchObject({
      ok     : false,
      id     : 'asset.accept',
      label  : 'Approve',
      refusal: { reason: 'No asset is on screen.' },
    });
  });

  // Un-approving reaches downwards, not upwards: what this was drawn from is not at stake in
  // undoing an approval, so the refusal that greys out approving does not grey this out
  it('still offers it while something upstream is unapproved', () => {
    const waiting = 'Approve what this was drawn from first: cafe — night plate is not approved.';
    const action = approveAction(info({ accepted: true, unapproved: waiting }));
    expect(action.ok && action.id).toBe('asset.unapprove');
  });

  // Flipping the flag alone would leave the slot naming the later render, so the click would
  // appear to do nothing at all
  it('puts an older take back in its slot rather than only flagging it', () => {
    expect(approveAction(info({ newerTake: 'e5f6a7b8' }))).toEqual({
      ok     : true,
      id     : 'asset.restore',
      props  : { hash: 'a1b2c3d4' },
      label  : 'Accept',
      tooltip: expect.stringContaining('back in its slot'),
    });
  });

  it('sends an earlier look back through the gate rather than restoring it', () => {
    const action = approveAction(portrait({ newerTake: 'e5f6a7b8' }));
    expect(action.ok && action.id).toBe('gate.approve');
  });

  it('refuses an older take whose upstream is unapproved, like any other', () => {
    const waiting = 'Approve what this was drawn from first: cafe — night plate is not approved.';
    expect(approveAction(info({ newerTake: 'e5f6a7b8', unapproved: waiting }))).toMatchObject({
      ok     : false,
      id     : 'asset.accept',
      refusal: { reason: waiting },
    });
  });

  // `accepted` means a human approved this for use downstream, and nothing downstream consumes a
  // concept — so the button says so instead of offering a state with no meaning.
  it('refuses a concept, which promotion is for', () => {
    expect(approveAction(concept())).toMatchObject({
      ok     : false,
      id     : 'asset.accept',
      refusal: { reason: expect.stringContaining('Promote it to a plate') },
    });
  });

  // A concept has no downstream and an upload has no upstream, so both are refused
  it('refuses an upload, which nothing generated', () => {
    expect(approveAction(info({ kind: 'reference', label: 'moodboard.png' }))).toMatchObject({
      ok     : false,
      id     : 'asset.accept',
      refusal: { reason: expect.stringContaining('pointed at') },
    });
  });

  // The refusal is main's own sentence, shown verbatim: a disabled control's tooltip must carry
  // the same words `asset.accept` gives when the palette or the agent reaches it
  it('refuses while anything it was drawn from is unapproved, in main’s own words', () => {
    const waiting =
      'Approve what this was drawn from first: cafe — night plate is not approved yet.';
    expect(approveAction(info({ unapproved: waiting }))).toMatchObject({
      ok     : false,
      id     : 'asset.accept',
      refusal: { reason: waiting },
    });
    // The unapproved check runs ahead of the portrait split, so the gate button greys out too, and
    // the refusal names the gate rather than the generic accept
    expect(approveAction(portrait({ unapproved: waiting }))).toMatchObject({
      ok     : false,
      id     : 'gate.approve',
      refusal: { reason: waiting },
    });
  });

  it('refuses a portrait whose character the project has lost, rather than guessing one', () => {
    expect(approveAction(portrait({ rungs: [] }))).toMatchObject({
      ok     : false,
      id     : 'gate.approve',
      refusal: { reason: 'This portrait names no character — approve it from the gate.' },
    });
  });
});

describe('promptEditable', () => {
  // The box starts with the whole prompt rather than empty, so the style preamble the generator
  // wrapped it in survives unless the author deletes it
  it('hands back the concept’s recorded prompt and name to start from', () => {
    expect(
      promptEditable(concept({ prompt: 'Subject: Café Mori. from above', title: 'aerial' })),
    ).toEqual({
      ok      : true,
      id      : 'art.redraw',
      props   : { hash: 'a1b2c3d4' },
      label   : 'Redraw',
      tooltip : 'Draw this sketch again from the prompt below, as a new one beside it',
      supplies: ['prompt', 'title'],
      prompt  : 'Subject: Café Mori. from above',
      title   : 'aerial',
    });
  });

  it('starts empty for a concept the manifest recorded nothing for', () => {
    expect(promptEditable(concept())).toMatchObject({
      ok    : true,
      id    : 'art.redraw',
      props : { hash: 'a1b2c3d4' },
      prompt: '',
      title : '',
    });
  });

  it('refuses every derived kind, naming the clauses as the way those move', () => {
    const plate = promptEditable(info());
    expect(plate).toMatchObject({
      ok     : false,
      id     : 'art.redraw',
      refusal: { reason: expect.stringContaining('a clause at a time') },
    });
    expect(plate.ok === false && plate.refusal.reason).toContain('location_ref');
    expect(promptEditable(portrait())).toMatchObject({ ok: false });
  });
});

describe('watchSlot', () => {
  it('follows the slot forward when a run fills it again', () => {
    expect(watchSlot(info(), info({ newerTake: 'b2' }), true)).toEqual({
      holding: true,
      follow : 'b2',
    });
    expect(watchSlot(info(), info(), true)).toEqual({ holding: true, follow: '' });
  });

  it('arrives holding the take that fills the slot, and not one behind it', () => {
    expect(watchSlot(undefined, info(), false).holding).toBe(true);
    expect(watchSlot(info({ hash: 'e5f6' }), info({ newerTake: 'b2' }), true)).toEqual({
      holding: false,
      follow : '',
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

describe('regenerateAction', () => {
  it('requeues the asset’s own task while the project still describes it', () => {
    expect(regenerateAction(info())).toEqual({
      ok     : true,
      act    : 'requeue',
      id     : 'asset.regenerate',
      props  : { hash: 'a1b2c3d4', run: true },
      label  : 'Regenerate',
      tooltip: 'Requeue the task behind these bytes and run the pipeline',
    });
  });

  // Main refuses this one, so a click that ran the command would report the refusal and stop
  it('offers a run for an asset the project has moved past', () => {
    const action = regenerateAction(info({ stale: true }));
    expect(action).toMatchObject({ ok: true, act: 'pipeline', id: 'pipeline.run' });
    if (!action.ok || action.act !== 'pipeline') throw new Error('expected the pipeline offer');
    expect(action.note).toContain('Café Mori — night');
    expect(action.note).toContain('Dry run is unticked');
  });

  // A task that gave up once its budget is spent reaches nothing further, so a run is the wrong
  // offer here. Main makes the same exception ahead of its own stale refusal.
  it('still requeues a stale asset whose slot has since failed', () => {
    expect(regenerateAction(info({ stale: true, failure: failed({ later: true }) }))).toMatchObject(
      {
        act: 'requeue',
      },
    );
  });

  it('says which of the two the click does', () => {
    expect(regenerateAction(info()).tooltip).toContain('Requeue');
    expect(regenerateAction(info({ stale: true })).tooltip).toContain('pipeline run');
  });

  it('refuses with nothing on screen, still naming what it would run', () => {
    expect(regenerateAction(undefined)).toMatchObject({
      ok     : false,
      id     : 'asset.regenerate',
      refusal: { reason: 'No asset is on screen.' },
    });
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
          status  : 'needs_human',
          attempts: 0,
          error   : 'shot still has blocking defects after 4 attempts',
        }),
      }),
    );
    expect(note).toContain('blocking defects');
    expect(note).not.toContain('of 2 attempts');
  });

  // Only regenerating reaches an asset whose identity is spent, so the failure note offers it
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
      text   : 'new',
      derived: true,
    });
  });

  it('falls back to what the bytes recorded when the project no longer describes it', () => {
    expect(promptShown(info({ prompt: 'old' }))).toEqual({ text: 'old', derived: false });
    expect(promptShown(info())).toEqual({ text: '', derived: false });
  });
});

describe('blockedNote', () => {
  it('answers nothing for a picture nothing is holding up', () => {
    expect(blockedNote(info())).toBeNull();
  });

  it('reports the failure first, in the words the band already uses', () => {
    const held = info({ failure: failed(), unapproved: 'Approve the plate first.' });
    expect(blockedNote(held)).toBe(failureNote(held));
  });

  it('reports an unapproved upstream in the refusal asset.accept would give', () => {
    expect(blockedNote(info({ unapproved: 'Approve the plate first.' }))).toBe(
      'Approve the plate first.',
    );
  });

  it('reports a suspension when nothing louder is wrong', () => {
    expect(blockedNote(info({ suspended: 'The plate it was drawn against moved.' }))).toBe(
      'The plate it was drawn against moved.',
    );
  });
});

describe('taskAction', () => {
  // Two acts in a load-bearing order: the inspector reads the selection on its first update(),
  // so the hash is published and only then is the pane opened.
  it('publishes the task before it opens the pane that reads one', () => {
    expect(taskAction('t1')).toEqual({
      ok     : true,
      id     : 'view.open',
      props  : { editor: 'inspector', where: 'elsewhere' },
      label  : 'Task',
      tooltip: 'Show the task that produced this asset in the inspector',
      publish: { taskHash: 't1' },
    });
  });

  it('refuses an asset the manifest records no task for', () => {
    expect(taskAction(undefined)).toMatchObject({
      ok     : false,
      id     : 'view.open',
      refusal: { reason: 'The manifest records no task for this asset.' },
    });
    expect(taskAction('')).toMatchObject({ ok: false });
  });
});

describe('exportAction', () => {
  it('saves a copy of the bytes on screen', () => {
    expect(exportAction(info())).toEqual({
      ok     : true,
      id     : 'asset.export',
      props  : { hash: 'a1b2c3d4' },
      label  : 'Download',
      tooltip: 'Save a copy of this picture wherever you like. The project is not touched',
    });
  });

  it('refuses with nothing on screen', () => {
    expect(exportAction(undefined)).toMatchObject({
      ok     : false,
      id     : 'asset.export',
      refusal: { reason: 'No picture on screen to save' },
    });
  });
});

describe('fixAction', () => {
  it('opens a conversation about the failure on screen', () => {
    expect(fixAction(info())).toEqual({
      ok     : true,
      id     : 'agent.fixAsset',
      props  : { hash: 'a1b2c3d4' },
      label  : 'Fix with agent',
      tooltip:
        'Open a conversation about this failure, with what it said already in the composer. Nothing is sent',
    });
  });
});

describe('failureTaskAction', () => {
  it('opens the task that gave up, told apart from the bar’s Task by that task', () => {
    const shown = info({ failure: failed() });
    expect(failureTaskAction(shown, failed())).toMatchObject({
      ...taskAction('t1'),
      on     : 't1',
      label  : 'Show task',
      tooltip: 'Open this task in the inspector, where its attempts are listed',
    });
    expect(keyOf(failureTaskAction(shown, failed()))).toBe('cmd:view.open#t1');
  });

  it('says when the task that gave up is a re-render rather than this one', () => {
    expect(failureTaskAction(info(), failed({ task: 't9', later: true }))).toMatchObject({
      on     : 't9',
      tooltip:
        'Open the task that gave up in the inspector — a re-render, not the one these bytes came from',
    });
  });
});

describe('notesAction', () => {
  it('writes the rung’s notes from its box, keyed by the rung', () => {
    expect(notesAction({ target: 'character:aiko', label: 'Aiko' })).toEqual({
      ok      : true,
      id      : 'art.setNotes',
      props   : { target: 'character:aiko' },
      label   : 'e.g. sodium streetlight raking across the formwork',
      tooltip:
        'Say how Aiko should look. Appended to the prompt, so saving re-renders what this rung reaches on the next run.',
      on      : 'character:aiko',
      supplies: ['notes'],
    });
  });
});

describe('modelAction', () => {
  const rung = { target: 'character:aiko', label: 'Aiko' };

  it('shows the inherited model in brackets and names it as what inherit takes', () => {
    expect(modelAction(rung, 'mock-image')).toEqual({
      ok      : true,
      id      : 'art.setModel',
      props   : { target: 'character:aiko' },
      label   : '(mock-image)',
      tooltip:
        "Draw Aiko with this image model instead of the project's. Pictures already drawn " +
        'stay; Regenerate draws with it. Inherit takes mock-image.',
      on      : 'character:aiko',
      supplies: ['model'],
    });
  });

  it('shows the rung’s own model when it has one', () => {
    expect(modelAction({ ...rung, imageModel: 'other-image' }, 'mock-image').label).toBe(
      'other-image',
    );
  });
});

describe('seedAction', () => {
  const rung = { target: 'character:aiko', label: 'Aiko' };

  it('shows the inherited seed as the placeholder, and says where it comes from', () => {
    expect(seedAction(rung, 7)).toEqual({
      ok      : true,
      id      : 'art.setSeed',
      props   : { target: 'character:aiko' },
      label   : '7',
      tooltip:
        'Draw Aiko from this seed instead. Saving re-renders what this rung reaches on the next ' +
        'run — same words, different picture. Empty inherits 7.',
      on      : 'character:aiko',
      supplies: ['seed'],
    });
  });

  it('falls back to the wider rung and the model when the project sets none', () => {
    expect(seedAction(rung)).toMatchObject({
      label  : 'seed',
      tooltip: expect.stringContaining('the wider rung, then the model’s own choice.'),
    });
  });
});

describe('the strips’ fields', () => {
  const plate = concept({ locationVariants: ['day'] });

  it('are the strip’s offer told apart by the field', () => {
    expect(promoteBox(plate)).toEqual({
      ...promoteAction(plate),
      on     : 'variant',
      label  : 'variant id, e.g. dawn',
      tooltip: 'Which variant of the location these bytes become the plate for',
    });
    expect(redrawBox(plate)).toEqual({
      ...promptEditable(plate),
      on     : 'prompt',
      tooltip: 'Edit the words this sketch is drawn from. Redraw sends them.',
    });
    expect(redrawGo(plate)).toEqual({
      ...promptEditable(plate),
      on     : 'go',
      tooltip: 'Spend one image call on this prompt and file the result as a new sketch',
    });
  });

  it('are refused when their strip is', () => {
    expect(promoteBox(info())).toMatchObject({ ok: false, on: 'variant' });
    expect(redrawBox(info())).toMatchObject({ ok: false, on: 'prompt' });
  });
});

describe('prereqAction', () => {
  const drawnFrom = {
    hash    : 'b2c3d4e5',
    label   : 'cafe — night plate',
    approved: true,
    note    : 'Approved.',
  };

  it('publishes the picture so this pane retargets to it', () => {
    expect(prereqAction(drawnFrom)).toEqual({
      ok     : true,
      id     : 'ui.publish',
      props  : { assetHash: 'b2c3d4e5' },
      on     : 'asset/b2c3d4e5',
      label  : 'cafe — night plate',
      tooltip: 'Approved. Click to open cafe — night plate in this pane.',
    });
    expect(keyOf(prereqAction(drawnFrom))).toBe('item:asset/b2c3d4e5');
  });

  it('is refused with the note when the manifest has no such bytes', () => {
    const gone = {
      ...drawnFrom,
      approved: false,
      missing : true,
      note    : 'No record of these bytes.',
    };
    expect(prereqAction(gone)).toEqual({
      ok     : false,
      refusal: { reason: 'No record of these bytes.' },
      id     : 'ui.publish',
      on     : 'asset/b2c3d4e5',
      label  : 'cafe — night plate',
      tooltip: 'Open cafe — night plate here',
    });
  });
});

describe('the bar’s menu and reload, and the back chip', () => {
  it('drops the tree’s menu for the shown asset and refuses it with none', () => {
    expect(menuAction(info())).toMatchObject({
      ok   : true,
      id   : 'menu.open',
      props: { menu: 'tree' },
      label: '⋯',
    });
    expect(menuAction(undefined)).toMatchObject({
      ok     : false,
      refusal: { reason: 'No asset is on screen, so there is nothing for the menu to act on.' },
    });
  });

  it('reloads as a view effect and goes back by publishing the hash it came from', () => {
    expect(reloadAction()).toMatchObject({ props: { what: 'reload' }, on: 'reload', label: '⟳' });
    expect(backAction('e5f6a7b8')).toEqual({
      ok     : true,
      id     : 'ui.publish',
      props  : { assetHash: 'e5f6a7b8' },
      on     : 'back',
      label  : '← back',
      tooltip: 'Back to the picture you came here from',
    });
  });
});

describe('controls', () => {
  const shown = [
    undefined,
    info({
      prereqs: [
        { hash: 'b2c3d4e5', label: 'cafe — night plate', approved: true, note: 'Approved.' },
      ],
    }),
    concept({ locationVariants: [], failure: failed({ task: 't9', later: true }) }),
    portrait({ accepted: true, configSeed: 3 }),
  ];

  it('lists every control the functions produce, each key once', () => {
    for (const one of shown) {
      const listed = controls(one);
      const promote = one && promoteAction(one);
      const redraw = one && promptEditable(one);
      const each = [
        approveAction(one),
        regenerateAction(one),
        taskAction(one?.sourceTask),
        exportAction(one),
        menuAction(one),
        reloadAction(),
        ...(one ? [promoteAction(one), replaceAction(one), promptEditable(one)] : []),
        ...(one && promote?.ok ? [promoteBox(one)] : []),
        ...(one && redraw?.ok ? [redrawBox(one), redrawGo(one)] : []),
        ...(one?.failure ? [failureTaskAction(one, one.failure), fixAction(one)] : []),
        ...(one?.rungs ?? []).flatMap((rung) => [
          notesAction(rung),
          seedAction(rung, one?.configSeed),
          modelAction(rung, one?.projectModel),
        ]),
        ...(one?.prereqs ?? []).map(prereqAction),
      ];
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });

  it('is the bar’s five refusals and a live reload while nothing is on screen', () => {
    expect(controls(undefined).map((offer) => offer.ok)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('lists the back chip before the prerequisites only while there is a hop to undo', () => {
    const one = info({
      prereqs: [
        { hash: 'b2c3d4e5', label: 'cafe — night plate', approved: true, note: 'Approved.' },
      ],
    });
    expect(controls(one).map(keyOf)).not.toContain('item:back');
    const keys = controls(one, 'e5f6a7b8').map(keyOf);
    expect(keys.indexOf('item:back')).toBe(keys.indexOf('item:asset/b2c3d4e5') - 1);
  });

  // A strip's field exists only while the strip is drawn, and the strip is drawn only when accepted
  it('lists a strip’s fields only with the strip', () => {
    const keys = controls(info()).map(keyOf);
    expect(keys).not.toContain('cmd:art.promote#variant');
    expect(keys).not.toContain('cmd:art.redraw#prompt');
    const drawn = controls(concept({ locationVariants: [] })).map(keyOf);
    expect(drawn).toContain('cmd:art.promote#variant');
    expect(drawn).toContain('cmd:art.redraw#prompt');
    expect(drawn).toContain('cmd:art.redraw#go');
  });
});
