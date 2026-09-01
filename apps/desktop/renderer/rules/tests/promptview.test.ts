/**
 * The prompt pane's rules: voice, tags, the `⇱` routing table, the mode strip, and how holding
 * reads as a sentence (`docs/plans/archive/INDEX.md#chunked-prompts` §7-§9).
 */
import type { ChunkOrigin } from '@vn/types';
import type { PromptChunkInfo, PromptView } from '../../../src/shared/prompt.js';
import {
  CHUNK_SUPPLIES,
  chunkActs,
  chunkAddress,
  chunkDropTarget,
  chunkTag,
  chunkTexture,
  chunkVoice,
  condenseAction,
  condenseNeedsForce,
  coverageMark,
  heldNote,
  checkAction,
  customAction,
  dropRefAction,
  modeStrip,
  originAction,
} from '../promptview.js';

const chunk = (over: Partial<PromptChunkInfo> = {}): PromptChunkInfo => ({
  key: 'palette',
  category: 'palette',
  origin: { kind: 'builder' },
  text: 'Palette: #112233.',
  derived: 'Palette: #112233.',
  muted: false,
  ...over,
});

const view = (over: Partial<PromptView> = {}): PromptView => ({
  hash: 'abc123',
  mode: 'chunks',
  text: 'Watercolour. Aiko.',
  chunks: [chunk()],
  held: false,
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
      ok: true,
      kind: 'open',
      editor: 'wiki',
      subject: 'characters/aiko/character.md',
      publish: { characterId: 'aiko' },
    });
  });

  // A shot needs two selection fields, so it cannot travel as `view.open`'s single subject — and
  // it must never route to `wiki`, because `doc.write` refuses `scenes/**`.
  it('sends a shot to the timeline by publishing both halves of the selection', () => {
    const action = originAction({ kind: 'shot', sceneId: 's1', shotId: 's1__a', field: 'camera' });
    expect(action).toMatchObject({
      ok: true,
      kind: 'open',
      editor: 'timeline',
      subject: '',
      publish: { sceneId: 's1', shotId: 's1__a' },
    });
  });

  it('stays in this pane for the two rungs this pane already edits', () => {
    expect(originAction({ kind: 'art-notes', target: 'character:aiko/gala' })).toMatchObject({
      ok: true,
      kind: 'scroll',
      to: 'character:aiko/gala',
    });
    expect(originAction({ kind: 'request' })).toMatchObject({
      ok: true,
      kind: 'scroll',
      to: 'request',
    });
  });

  it('offers no button for a sentence the builders wrote', () => {
    expect(originAction({ kind: 'builder' })).toEqual({
      ok: false,
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
    expect(strip[0]!.action).toEqual({
      ok: false,
      id: 'prompt.clear',
      reason: 'This prompt is already in chunks mode.',
    });
  });

  // Nothing sets a mode field: a mode is a consequence of what is written.
  it('reaches chunks mode by clearing whichever whole-prompt text is in force', () => {
    const fromCustom = modeStrip(view({ mode: 'custom', custom: 'Just Aiko.' }))[0]!;
    expect(fromCustom.action).toEqual({
      ok: true,
      id: 'prompt.clear',
      props: { hash: 'abc123', part: 'custom' },
    });
    const fromAgent = modeStrip(view({ mode: 'agent' }))[0]!;
    expect(fromAgent.action).toMatchObject({ props: { part: 'agent' } });
  });

  it('prefills a custom prompt with the composed text whole', () => {
    expect(modeStrip(view())[1]!.action).toEqual({
      ok: true,
      id: 'prompt.setCustom',
      props: { hash: 'abc123', text: 'Watercolour. Aiko.' },
    });
  });

  it('is entirely disabled on a frozen prompt, each segment carrying the reason', () => {
    const frozen = 'A concept’s prompt is the sentence it was asked for.';
    const commands = ['prompt.clear', 'prompt.setCustom', 'prompt.condense'];
    modeStrip(view({ frozen })).forEach((segment, i) => {
      expect(segment.action).toEqual({ ok: false, id: commands[i], reason: frozen });
    });
  });
});

describe('condenseAction', () => {
  it('condenses the chunks as they stand', () => {
    expect(condenseAction(view())).toMatchObject({
      ok: true,
      id: 'prompt.condense',
      props: { hash: 'abc123' },
      label: 'Condense…',
    });
  });

  it('supplies force from custom mode, rather than offering to discard the text', () => {
    const action = condenseAction(view({ mode: 'custom', custom: 'Just Aiko.' }));
    expect(action).toMatchObject({ ok: true, props: { hash: 'abc123', force: true } });
    // Without the flag, `prompt.condense` refuses in these same words
    expect(condenseNeedsForce('abc123')).toContain("prompt.condense(hash='abc123' force=true)");
  });

  it('offers to redo a held prompt in the button itself', () => {
    expect(condenseAction(view({ mode: 'agent', held: true }))).toMatchObject({
      ok: true,
      label: 'Recondense',
    });
  });

  it('refuses when there is nothing derived under the prompt', () => {
    expect(condenseAction(view({ frozen: 'Authored, not derived.' }))).toEqual({
      ok: false,
      id: 'prompt.condense',
      reason: 'Authored, not derived.',
    });
    expect(condenseAction(view({ chunks: [] }))).toEqual({
      ok: false,
      id: 'prompt.condense',
      reason: 'There are no chunks to condense.',
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
  it('offers the same command four times, one op each', () => {
    const acts = chunkActs(view(), chunk());
    expect(acts.map((a) => a.key)).toEqual(['mute', 'replace', 'append', 'reset']);
    for (const act of acts) expect(act.offer.id).toBe('prompt.setChunk');
    expect(acts[0]!.offer).toEqual({
      ok: true,
      id: 'prompt.setChunk',
      props: { hash: 'abc123', chunk: 'palette', op: 'mute', text: '' },
    });
  });

  // The two boxed acts leave `text` out. The author has not typed it yet, so any value an anchor
  // recorded for it would be a guess.
  it('leaves the text off the two acts that open a box', () => {
    const acts = chunkActs(view(), chunk());
    expect(acts[1]!.opens).toBe('replace');
    expect(acts[1]!.offer).toEqual({
      ok: true,
      id: 'prompt.setChunk',
      props: { hash: 'abc123', chunk: 'palette', op: 'replace' },
    });
    expect(CHUNK_SUPPLIES).toEqual(['text']);
  });

  it('refuses muting what is already muted, and resetting what nothing was done to', () => {
    const [mute] = chunkActs(view(), chunk({ muted: true }));
    expect(mute!.offer).toEqual({
      ok: false,
      id: 'prompt.setChunk',
      reason: 'Already muted.',
    });
    const acts = chunkActs(view(), chunk());
    expect(acts[3]!.offer).toMatchObject({ ok: false, id: 'prompt.setChunk' });
  });

  it('offers Reset once anything has been done to the clause', () => {
    const edited = chunkActs(view(), chunk({ edit: 'replace', authored: 'Aiko, in green.' }));
    expect(edited[3]!.offer).toEqual({
      ok: true,
      id: 'prompt.setChunk',
      props: { hash: 'abc123', chunk: 'palette', op: 'clear', text: '' },
    });
  });
});

describe('the rest of the prompt pane’s invocations', () => {
  it('detaches one reference by its pin', () => {
    expect(dropRefAction(view(), chunk(), 'pin1')).toEqual({
      ok: true,
      id: 'prompt.dropRef',
      props: { hash: 'abc123', chunk: 'palette', ref: 'pin1' },
    });
  });

  it('leaves the custom prompt’s text to the box, and refuses on a frozen prompt', () => {
    expect(customAction(view())).toEqual({
      ok: true,
      id: 'prompt.setCustom',
      props: { hash: 'abc123' },
      label: 'Save',
    });
    expect(customAction(view({ frozen: 'Authored.' }))).toEqual({
      ok: false,
      id: 'prompt.setCustom',
      reason: 'Authored.',
    });
  });

  it('checks the prompt in force', () => {
    expect(checkAction(view())).toEqual({
      ok: true,
      id: 'prompt.check',
      props: { hash: 'abc123' },
      label: 'Check',
    });
  });
});
