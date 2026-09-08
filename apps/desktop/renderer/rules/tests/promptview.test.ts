/**
 * The prompt pane's rules: voice, tags, the `⇱` routing table, the mode strip, and how holding
 * reads as a sentence (`docs/plans/archive/INDEX.md#chunked-prompts` §7-§9).
 */
import type { ChunkOrigin } from '@vn/types';
import type { PromptChunkInfo, PromptView } from '../../../src/shared/prompt.js';
import {
  chunkActs,
  chunkAddress,
  chunkBoxAction,
  chunkDropTarget,
  chunkTag,
  chunkTexture,
  chunkVoice,
  condenseAction,
  condenseNeedsForce,
  controls,
  coverageMark,
  heldNote,
  checkAction,
  customAction,
  customBoxAction,
  dropRefAction,
  modeStrip,
  originAction,
  originOpenAction,
  refOpenAction,
  refStrip,
} from '../promptview.js';
import { duplicateKeys, keyOf } from '../anchors.js';

const chunk = (over: Partial<PromptChunkInfo> = {}): PromptChunkInfo => ({
  key     : 'palette',
  category: 'palette',
  origin  : { kind: 'builder' },
  text    : 'Palette: #112233.',
  derived : 'Palette: #112233.',
  muted   : false,
  ...over,
});

const view = (over: Partial<PromptView> = {}): PromptView => ({
  hash   : 'abc123',
  mode   : 'chunks',
  text   : 'Watercolour. Aiko.',
  chunks : [chunk()],
  held   : false,
  missing: [],
  ...over,
});

describe('chunkVoice', () => {
  it('gives the builders their own hue and everything an author typed the other', () => {
    for (const category of ['subject', 'framing', 'scaffolding'] as const) {
      expect(chunkVoice(chunk({ category }))).toBe('signal');
    }
    for (const category of [
      'style',
      'description',
      'mood',
      'variant',
      'palette',
      'camera',
      'art-notes',
      'request',
    ] as const) {
      expect(chunkVoice(chunk({ category }))).toBe('sodium');
    }
  });
});

describe('chunkTag', () => {
  it('is the category, and says what an override did to it', () => {
    expect(chunkTag(chunk({ category: 'art-notes' }))).toBe('ART NOTES');
    expect(chunkTag(chunk({ category: 'art-notes', edit: 'replace' }))).toBe(
      'ART NOTES · REPLACED',
    );
    expect(chunkTag(chunk({ edit: 'append' }))).toBe('PALETTE · APPENDED');
  });
});

describe('chunkTexture', () => {
  it('groups the categories three ways, and the tag says which one exactly', () => {
    expect(chunkTexture(chunk({ category: 'art-notes' }))).toBe('dash');
    expect(chunkTexture(chunk({ category: 'request' }))).toBe('dash');
    expect(chunkTexture(chunk({ category: 'scaffolding' }))).toBe('dot');
    expect(chunkTexture(chunk({ category: 'framing' }))).toBe('dot');
    expect(chunkTexture(chunk({ category: 'style' }))).toBe('solid');
    expect(chunkTexture(chunk({ category: 'subject' }))).toBe('solid');
  });
});

describe('chunkDropTarget', () => {
  const rows = [
    { key: 'style', top: 0, bottom: 20 },
    { key: 'subject', top: 20, bottom: 40 },
    { key: 'palette', top: 40, bottom: 60 },
  ];

  it('names the top above the first midpoint, then the last midpoint passed', () => {
    expect(chunkDropTarget(rows, 0)).toBe('top');
    expect(chunkDropTarget(rows, 9)).toBe('top');
    expect(chunkDropTarget(rows, 10)).toBe('style');
    expect(chunkDropTarget(rows, 29)).toBe('style');
    expect(chunkDropTarget(rows, 30)).toBe('subject');
    expect(chunkDropTarget(rows, 1000)).toBe('palette');
  });

  it('is the top when there is nothing to sit after', () => {
    expect(chunkDropTarget([], 42)).toBe('top');
  });
});

describe('originAction', () => {
  const cases: [ChunkOrigin, string][] = [
    [{ kind: 'project', field: 'art_style' }, 'project'],
    [{ kind: 'character', id: 'aiko', field: 'description' }, 'wiki'],
    [{ kind: 'outfit', id: 'aiko', outfit: 'gala' }, 'wiki'],
    [{ kind: 'location', id: 'cafe', field: 'mood' }, 'wiki'],
    [{ kind: 'variant', id: 'cafe', variant: 'night' }, 'wiki'],
    [{ kind: 'shot', sceneId: 's1', shotId: 's1__a', field: 'camera' }, 'timeline'],
  ];

  it('opens the editor that owns the words', () => {
    for (const [origin, editor] of cases) {
      const action = originAction(origin);
      expect(action.ok && action.kind === 'open' && action.editor).toBe(editor);
    }
  });

  it('names a character sheet by its conventional path and publishes the selection', () => {
    const action = originAction({ kind: 'outfit', id: 'aiko', outfit: 'gala' });
    expect(action).toMatchObject({
      ok     : true,
      kind   : 'open',
      editor : 'wiki',
      subject: 'characters/aiko/character.md',
      publish: { characterId: 'aiko' },
    });
  });

  // A shot needs two selection fields, so it cannot travel as `view.open`'s single subject — and
  // it must never route to `wiki`, because `doc.write` refuses `scenes/**`.
  it('sends a shot to the timeline by publishing both halves of the selection', () => {
    const action = originAction({ kind: 'shot', sceneId: 's1', shotId: 's1__a', field: 'camera' });
    expect(action).toMatchObject({
      ok     : true,
      kind   : 'open',
      editor : 'timeline',
      subject: '',
      publish: { sceneId: 's1', shotId: 's1__a' },
    });
  });

  it('stays in this pane for the two rungs this pane already edits', () => {
    expect(originAction({ kind: 'art-notes', target: 'character:aiko/gala' })).toMatchObject({
      ok  : true,
      kind: 'scroll',
      to  : 'character:aiko/gala',
    });
    expect(originAction({ kind: 'request' })).toMatchObject({
      ok  : true,
      kind: 'scroll',
      to  : 'request',
    });
  });

  it('offers no button for a sentence the builders wrote', () => {
    expect(originAction({ kind: 'builder' })).toEqual({
      ok    : false,
      reason: 'The builders wrote this sentence — there is no document behind it.',
    });
  });
});

describe('chunkAddress', () => {
  it('speaks the rung vocabulary the art-notes boxes already use', () => {
    expect(chunkAddress({ kind: 'project', field: 'art_style' })).toBe('project#art_style');
    expect(chunkAddress({ kind: 'outfit', id: 'aiko', outfit: 'gala' })).toBe(
      'character:aiko/gala',
    );
    expect(chunkAddress({ kind: 'variant', id: 'cafe', variant: 'night' })).toBe(
      'location:cafe/night',
    );
    expect(chunkAddress({ kind: 'art-notes', target: 'shot:s1/s1__a' })).toBe('shot:s1/s1__a');
    expect(chunkAddress({ kind: 'builder' })).toBe('built in');
  });
});

describe('modeStrip', () => {
  it('marks the mode in force and refuses to re-enter it', () => {
    const strip = modeStrip(view());
    expect(strip.map((s) => s.id)).toEqual(['chunks', 'custom', 'agent']);
    expect(strip[0]!.active).toBe(true);
    expect(strip[0]!.offer).toMatchObject({
      ok     : false,
      id     : 'prompt.clear',
      label  : 'Chunks',
      on     : 'chunks',
      refusal: { reason: 'This prompt is already in chunks mode.' },
    });
  });

  // Nothing sets a mode field: a mode is a consequence of what is written.
  it('reaches chunks mode by clearing whichever whole-prompt text is in force', () => {
    const fromCustom = modeStrip(view({ mode: 'custom', custom: 'Just Aiko.' }))[0]!;
    expect(fromCustom.offer).toEqual({
      ok     : true,
      id     : 'prompt.clear',
      props  : { hash: 'abc123', part: 'custom' },
      label  : 'Chunks',
      tooltip: expect.stringContaining('dropping the whole-prompt text'),
      on     : 'chunks',
    });
    const fromAgent = modeStrip(view({ mode: 'agent' }))[0]!;
    expect(fromAgent.offer).toMatchObject({ props: { part: 'agent' } });
  });

  it('prefills a custom prompt with the composed text whole', () => {
    expect(modeStrip(view())[1]!.offer).toMatchObject({
      ok   : true,
      id   : 'prompt.setCustom',
      props: { hash: 'abc123', text: 'Watercolour. Aiko.' },
      on   : 'custom',
    });
  });

  it('is entirely disabled on a frozen prompt, each segment carrying the reason', () => {
    const frozen = 'A concept’s prompt is the sentence it was asked for.';
    const commands = ['prompt.clear', 'prompt.setCustom', 'prompt.condense'];
    modeStrip(view({ frozen })).forEach((segment, i) => {
      expect(segment.offer).toMatchObject({
        ok     : false,
        id     : commands[i],
        refusal: { reason: frozen },
      });
    });
  });
});

describe('condenseAction', () => {
  it('condenses the chunks as they stand', () => {
    expect(condenseAction(view())).toEqual({
      ok     : true,
      id     : 'prompt.condense',
      props  : { hash: 'abc123' },
      label  : 'Condense…',
      tooltip: 'Rewrite the chunks into one prompt an image model handles well.',
    });
  });

  it('supplies force from custom mode, rather than offering to discard the text', () => {
    const action = condenseAction(view({ mode: 'custom', custom: 'Just Aiko.' }));
    expect(action).toMatchObject({
      ok     : true,
      props  : { hash: 'abc123', force: true },
      tooltip: expect.stringContaining('preserve'),
    });
    // Without the flag, `prompt.condense` refuses in these same words
    expect(condenseNeedsForce('abc123')).toContain("prompt.condense(hash='abc123' force=true)");
  });

  it('offers to redo a held prompt in the button itself', () => {
    expect(condenseAction(view({ mode: 'agent', held: true }))).toMatchObject({
      ok     : true,
      label  : 'Recondense',
      tooltip: expect.stringContaining('replacing the held prompt'),
    });
  });

  it('refuses when there is nothing derived under the prompt', () => {
    expect(condenseAction(view({ frozen: 'Authored, not derived.' }))).toMatchObject({
      ok     : false,
      id     : 'prompt.condense',
      refusal: { reason: 'Authored, not derived.' },
    });
    expect(condenseAction(view({ chunks: [] }))).toMatchObject({
      ok     : false,
      id     : 'prompt.condense',
      refusal: { reason: 'There are no chunks to condense.' },
    });
  });
});

describe('heldNote', () => {
  it('says nothing until the condensation is out of date', () => {
    expect(heldNote(view({ mode: 'agent' }))).toBe('');
  });

  it('explains why the stale text is still what gets sent', () => {
    const note = heldNote(view({ mode: 'agent', held: true }));
    expect(note).toContain('still what gets sent');
    expect(note).toContain('task hash');
  });
});

describe('coverageMark', () => {
  it('has nothing to check in chunks mode — the chunks are the prompt', () => {
    expect(coverageMark(view(), chunk())).toBeUndefined();
  });

  it('marks a chunk found or not found, and never blames the model', () => {
    const v = view({ mode: 'agent', missing: ['palette'] });
    expect(coverageMark(v, chunk())).toMatchObject({ mark: '✗', found: false });
    expect(coverageMark(v, chunk({ key: 'subject' }))).toMatchObject({ mark: '✓', found: true });
    expect(coverageMark(v, chunk())!.title).toContain('Not found');
    expect(coverageMark(v, chunk())!.title).not.toContain('dropped');
  });

  it('says nothing about a chunk that was never going to be sent', () => {
    const v = view({ mode: 'agent', missing: ['palette'] });
    expect(coverageMark(v, chunk({ muted: true }))).toBeUndefined();
  });
});

describe('chunkActs', () => {
  it('offers the same command four times, one op each, told apart by clause and act', () => {
    const acts = chunkActs(view(), chunk());
    expect(acts.map((a) => a.key)).toEqual(['mute', 'replace', 'append', 'attach', 'reset']);
    for (const act of acts) {
      expect(act.offer.id).toBe(act.key === 'attach' ? 'prompt.addRef' : 'prompt.setChunk');
      expect(act.offer.on).toBe(`palette/${act.key}`);
    }
    expect(acts[0]!.offer).toEqual({
      ok     : true,
      id     : 'prompt.setChunk',
      props  : { hash: 'abc123', chunk: 'palette', op: 'mute', text: '' },
      label  : 'Mute',
      tooltip: 'Leave this clause out of the prompt',
      on     : 'palette/mute',
    });
  });

  // The two boxed acts leave `text` out. The author has not typed it yet, so any value an anchor
  // recorded for it would be a guess, and the offer names it as what the box supplies.
  it('leaves the text off the two acts that open a box', () => {
    const acts = chunkActs(view(), chunk());
    expect(acts[1]!.opens).toBe('replace');
    expect(acts[1]!.offer).toEqual({
      ok      : true,
      id      : 'prompt.setChunk',
      props   : { hash: 'abc123', chunk: 'palette', op: 'replace' },
      label   : 'Replace…',
      tooltip : 'Say this clause in your own words',
      on      : 'palette/replace',
      supplies: ['text'],
    });
    expect(acts[2]!.offer).toMatchObject({ props: { op: 'append' }, supplies: ['text'] });
  });

  // Attach carries no `ref` for the same reason: the gallery has not been opened yet, so the
  // anchor records what it will run and names the prop the pick supplies.
  it('leaves the ref off the act that opens the gallery', () => {
    const attach = chunkActs(view(), chunk())[3]!;
    expect(attach.picks).toBe(true);
    expect(attach.offer).toEqual({
      ok      : true,
      id      : 'prompt.addRef',
      props   : { hash: 'abc123', chunk: 'palette' },
      label   : 'Attach…',
      tooltip : 'Send a reference image with this clause',
      on      : 'palette/attach',
      supplies: ['ref'],
    });
  });

  it('refuses muting what is already muted, and resetting what nothing was done to', () => {
    const [mute] = chunkActs(view(), chunk({ muted: true }));
    expect(mute!.offer).toMatchObject({
      ok     : false,
      id     : 'prompt.setChunk',
      on     : 'palette/mute',
      refusal: { reason: 'Already muted.' },
    });
    const acts = chunkActs(view(), chunk());
    expect(acts[4]!.offer).toMatchObject({
      ok     : false,
      id     : 'prompt.setChunk',
      refusal: { reason: 'Nothing has been done to this clause.' },
    });
  });

  it('offers Reset once anything has been done to the clause', () => {
    const edited = chunkActs(view(), chunk({ edit: 'replace', authored: 'Aiko, in green.' }));
    expect(edited[4]!.offer).toMatchObject({
      ok   : true,
      id   : 'prompt.setChunk',
      props: { hash: 'abc123', chunk: 'palette', op: 'clear', text: '' },
      label: 'Reset',
    });
  });
});

describe('the rest of the prompt pane’s invocations', () => {
  it('detaches one reference by its pin, and names the picture it stops sending', () => {
    expect(dropRefAction(view(), chunk(), { pin: 'pin1', label: 'moodboard' })).toEqual({
      ok     : true,
      id     : 'prompt.dropRef',
      props  : { hash: 'abc123', chunk: 'palette', ref: 'pin1' },
      label  : '×',
      tooltip: 'Stop sending moodboard with this clause',
      on     : 'palette/pin1',
    });
  });

  it('leaves the custom prompt’s text to the box, and refuses on a frozen prompt', () => {
    expect(customAction(view())).toEqual({
      ok      : true,
      id      : 'prompt.setCustom',
      props   : { hash: 'abc123' },
      label   : 'Save',
      tooltip : 'Send this prompt instead of the clauses below',
      supplies: ['text'],
    });
    expect(customAction(view({ frozen: 'Authored.' }))).toMatchObject({
      ok     : false,
      id     : 'prompt.setCustom',
      refusal: { reason: 'Authored.' },
    });
  });

  it('checks the prompt in force', () => {
    expect(checkAction(view())).toEqual({
      ok     : true,
      id     : 'prompt.check',
      props  : { hash: 'abc123' },
      label  : 'Check',
      tooltip: 'Which clauses the prompt above no longer appears to say',
    });
  });
});

describe('controls', () => {
  const withRefs = (over: Partial<PromptView> = {}): PromptView =>
    view({
      chunks: [
        chunk({ refs: [{ pin: 'pin1', ext: 'png', label: 'moodboard' }] }),
        chunk({ key: 'subject', category: 'subject', muted: true }),
      ],
      ...over,
    });

  it('lists every control the functions produce, each key once', () => {
    const editing = { palette: 'replace' as const };
    for (const fixture of [view(), withRefs(), withRefs({ mode: 'custom', custom: 'Aiko.' })]) {
      const listed = controls(fixture, editing);
      const each = [
        ...modeStrip(fixture).map((segment) => segment.offer),
        condenseAction(fixture),
        checkAction(fixture),
        customAction(fixture),
        ...(fixture.mode === 'custom' ? [customBoxAction(fixture)] : []),
        ...fixture.chunks.flatMap((one) => {
          const how = editing[one.key as keyof typeof editing];
          const origin = originOpenAction(one);
          return [
            ...chunkActs(fixture, one).map((act) => act.offer),
            ...(how ? [chunkBoxAction(fixture, one, how)] : []),
            ...refStrip(one).map(refOpenAction),
            ...(one.refs ?? []).map((ref) => dropRefAction(fixture, one, ref)),
            ...(origin ? [origin] : []),
          ];
        }),
      ];
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });

  it('lists a clause’s box only while one is open, and never on a frozen prompt', () => {
    const keys = (fixture: PromptView, editing = {}) => controls(fixture, editing).map(keyOf);
    expect(keys(view())).not.toContain('cmd:prompt.setChunk#palette/box');
    expect(keys(view(), { palette: 'append' })).toContain('cmd:prompt.setChunk#palette/box');
    expect(keys(view({ frozen: 'Held.' }), { palette: 'append' })).not.toContain(
      'cmd:prompt.setChunk#palette/box',
    );
  });

  // The strip's segment and the button beneath it run the same command, so the key tells them
  // apart by the segment id
  it('keeps a segment and the button that runs the same command apart', () => {
    const keys = controls(view()).map(keyOf);
    expect(keys).toContain('cmd:prompt.condense#agent');
    expect(keys).toContain('cmd:prompt.condense');
    expect(keys).toContain('cmd:prompt.setCustom#custom');
    expect(keys).toContain('cmd:prompt.setCustom');
  });
});

describe('chunkBoxAction', () => {
  it('commits the act its button opened, told apart by the box’s own key', () => {
    const fixture = view();
    const one = fixture.chunks[0]!;
    const replace = chunkActs(fixture, one).find((act) => act.key === 'replace')!.offer;
    expect(chunkBoxAction(fixture, one, 'replace')).toEqual({
      ...replace,
      on     : 'palette/box',
      tooltip: 'Say this clause in your own words. Ctrl+S or leaving the box saves it.',
    });
    expect(chunkBoxAction(fixture, one, 'append')).toMatchObject({
      id     : 'prompt.setChunk',
      props  : { op: 'append' },
      on     : 'palette/box',
      tooltip: 'Add to what the builders derived. Ctrl+S or leaving the box saves it.',
    });
  });
});

describe('customBoxAction', () => {
  it('is the custom prompt’s Save, told apart as its box', () => {
    expect(customBoxAction(view())).toEqual({
      ...customAction(view()),
      on     : 'box',
      tooltip: 'Say the whole prompt yourself. Ctrl+S or leaving the box saves it.',
    });
    expect(customBoxAction(view({ frozen: 'Held.' }))).toMatchObject({ ok: false });
  });
});

describe('refOpenAction', () => {
  it('opens the reference elsewhere, keyed by its pin', () => {
    const [chip] = refStrip(chunk({ refs: [{ pin: 'pin1', ext: 'png', label: 'moodboard' }] }));
    expect(refOpenAction(chip!)).toEqual({
      ok     : true,
      id     : 'view.open',
      props  : { editor: 'asset', where: 'elsewhere', subject: 'pin1' },
      label  : 'moodboard',
      tooltip: `${chip!.title} · click to open it in another pane`,
      on     : 'pin1',
    });
  });
});

describe('originOpenAction', () => {
  it('opens the editor a clause came from, keyed by the clause', () => {
    const one = chunk({
      key   : 'subject',
      origin: { kind: 'character', id: 'aiko', field: 'appearance' },
    });
    expect(originOpenAction(one)).toEqual({
      ok     : true,
      id     : 'view.open',
      props  : { editor: 'wiki', where: 'elsewhere', subject: 'characters/aiko/character.md' },
      label  : "Open aiko's sheet",
      tooltip: "Open aiko's sheet",
      on     : 'subject',
    });
  });

  it('is nothing for a clause that scrolls, or that came from nowhere', () => {
    expect(originOpenAction(chunk({ origin: { kind: 'builder' } }))).toBeUndefined();
    const scrolls = chunk({ origin: { kind: 'art-notes', target: 'character:aiko' } });
    expect(originAction(scrolls.origin)).toMatchObject({ kind: 'scroll' });
    expect(originOpenAction(scrolls)).toBeUndefined();
  });
});
