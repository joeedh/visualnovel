/**
 * Byte-identity between the chunked builders and the flat-string builders they replaced
 * (`docs/plans/archive/chunked-prompts.md` §18).
 *
 * The legacy collapse is spelled out literally in each case rather than imported, so this proves
 * the property in code instead of asserting that two call sites agree.
 */
import { projectConfig, type PromptChunk, type PromptOverride, type Shot } from '@vn/types';
import { outfitText } from '@vn/model';
import { character, location, model, scene } from '@vn/testkit';
import {
  artClause,
  buildLocationChunks,
  buildLocationPrompt,
  buildModelSheetChunks,
  buildModelSheetPrompt,
  buildPortraitChunks,
  buildPortraitPrompt,
  buildShotChunks,
  buildShotPrompt,
  chunk,
  paletteClause,
  renderPrompt,
  stylePreamble,
} from '../index.js';

const config = projectConfig.parse({
  title: 'Test',
  art_style: 'watercolor',
  models: { vision: ['gemini', 'claude'] },
});

/** Exactly what every builder used to end with, before chunks existed. */
function legacy(clauses: string[]): string {
  return clauses.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

const shot: Shot = {
  id: 's1__a',
  sceneId: 's1',
  framing: 'medium',
  location: 'day',
  subjects: [{ characterId: 'aiko' }],
  camera: 'low angle',
  coversLines: [],
  status: 'pending',
};

describe('chunked builders', () => {
  it('renders a portrait exactly as the flat builder did', () => {
    const c = character('aiko');
    c.artNotes = 'ink-wash linework';
    expect(buildPortraitPrompt(c, config)).toBe(
      legacy([
        stylePreamble(config),
        `Character portrait of ${c.name}.`,
        c.description,
        paletteClause(c.palette),
        artClause(c.artNotes),
        'Neutral pose and expression, plain neutral background, head-and-shoulders framing.',
      ]),
    );
  });

  it('renders a location plate exactly as the flat builder did', () => {
    const l = location('cafe');
    l.mood = 'quiet';
    l.artNotes = 'heavy formwork';
    l.palette = ['#445566'];
    l.variants = [{ id: 'night', description: 'after close, chairs up', artNotes: 'sodium light' }];
    expect(buildLocationPrompt(l, 'night', config)).toBe(
      legacy([
        stylePreamble(config),
        `Establishing shot of ${l.name}.`,
        l.description,
        `Mood: ${l.mood}.`,
        'Time of day / condition: night.',
        'after close, chairs up',
        paletteClause(l.palette),
        artClause(l.artNotes, 'sodium light'),
        'No characters, no text.',
      ]),
    );
  });

  it('renders a model sheet exactly as the flat builder did', () => {
    const c = character('aiko');
    c.outfits = [
      { id: 'gala', characterId: 'aiko', description: 'a gala dress', artNotes: 'satin' },
    ];
    expect(buildModelSheetPrompt(c, 'gala', 'front', config)).toBe(
      legacy([
        stylePreamble(config),
        `Full-body front view of ${c.name} wearing ${outfitText(c, 'gala')}.`,
        'Preserve the exact face and look from the reference image.',
        c.description,
        paletteClause(c.palette),
        artClause(c.artNotes, 'satin'),
        'Neutral background, consistent lighting, turnaround model-sheet style.',
      ]),
    );
  });

  it('renders a shot exactly as the flat builder did', () => {
    const c = character('aiko');
    const sc = scene('s1', ['aiko'], 'cafe');
    const s = { ...shot, artNotes: 'rain on the glass' };
    expect(buildShotPrompt(s, sc, model([c], [sc], [location('cafe')]), config)).toBe(
      legacy([
        stylePreamble(config),
        'medium shot in cafe (day).',
        `Subjects: ${c.name}, wearing default.`,
        'Camera: low angle.',
        artClause(s.artNotes),
        'Render as a single illustrated frame, no UI text.',
      ]),
    );
  });
});

describe('the override a builder resolves for itself', () => {
  const MUTE: PromptOverride = { mode: 'chunks', mute: ['palette'] };

  it('reads the portrait rung off the character sheet', () => {
    const c = character('aiko');
    expect(buildPortraitPrompt(c, config)).toContain('Palette:');
    c.promptOverride = { ...MUTE };
    expect(buildPortraitPrompt(c, config)).not.toContain('Palette:');
  });

  it('reads a sheet rung off the outfit, and it covers every angle', () => {
    const c = character('aiko');
    c.outfits = [
      { id: 'gala', characterId: 'aiko', description: 'a gala dress', promptOverride: { ...MUTE } },
    ];
    for (const angle of ['front', 'side', 'back', 'three-quarter']) {
      expect(buildModelSheetPrompt(c, 'gala', angle, config)).not.toContain('Palette:');
    }
    // The character's own override belongs to the portrait and is not consulted here.
    c.promptOverride = { mode: 'custom', custom: 'Something else entirely.' };
    expect(buildModelSheetPrompt(c, 'gala', 'front', config)).toContain('Full-body front view');
  });

  it('reads a plate rung off the variant, and only that variant', () => {
    const l = location('cafe');
    l.variants = [
      { id: 'day', description: '' },
      { id: 'night', description: '', promptOverride: { mode: 'custom', custom: 'Closed up.' } },
    ];
    expect(buildLocationPrompt(l, 'night', config)).toBe('Closed up.');
    expect(buildLocationPrompt(l, 'day', config)).toContain('Establishing shot');
  });

  it('reads a frame rung off the shot', () => {
    const c = character('aiko');
    const sc = scene('s1', ['aiko'], 'cafe');
    const m = model([c], [sc], [location('cafe')]);
    const s: Shot = {
      ...shot,
      camera: 'low angle',
      promptOverride: { mode: 'chunks', mute: ['camera'] },
    };
    expect(buildShotPrompt(s, sc, m, config)).not.toContain('Camera:');
  });

  it('lets a caller preview a candidate without writing it', () => {
    const c = character('aiko');
    c.promptOverride = { ...MUTE };
    // The argument stands in for the stored one entirely, rather than merging with it.
    expect(buildPortraitPrompt(c, config, { mode: 'chunks' })).toContain('Palette:');
    expect(buildPortraitPrompt(c, config, { mode: 'custom', custom: 'Just Aiko.' })).toBe(
      'Just Aiko.',
    );
  });
});

describe('renderPrompt', () => {
  it("re-supplies the space paletteClause's leading one gets trimmed of", () => {
    // `paletteClause` returns ` Palette: …` — the chunk trims it, and the join puts it back. Both
    // spellings collapse to the same string, which is the whole byte-identity argument.
    const c = character('aiko');
    const clause = paletteClause(c.palette);
    expect(clause.startsWith(' ')).toBe(true);
    expect(chunk('palette', 'palette', clause, { kind: 'builder' })!.text).toBe(clause.trim());
    expect(buildPortraitPrompt(c, config)).toContain(' Palette: #112233. ');
  });

  it('drops an all-whitespace clause, as the final collapse always did', () => {
    const chunks: PromptChunk[] = [
      { key: 'a', category: 'style', text: 'One.', origin: { kind: 'builder' } },
      { key: 'b', category: 'style', text: 'Two.', origin: { kind: 'builder' } },
    ];
    expect(chunk('blank', 'style', '   \n ', { kind: 'builder' })).toBeUndefined();
    expect(renderPrompt(chunks)).toBe('One. Two.');
  });

  it('gives every builder chunk a unique key', () => {
    const c = character('aiko');
    const sc = scene('s1', ['aiko'], 'cafe');
    const lists: PromptChunk[][] = [
      buildPortraitChunks(c, config),
      buildLocationChunks(location('cafe'), 'day', config),
      buildModelSheetChunks(c, 'default', 'front', config),
      buildShotChunks(shot, sc, model([c], [sc], [location('cafe')]), config),
    ];
    for (const list of lists) {
      expect(new Set(list.map((c2) => c2.key)).size).toBe(list.length);
    }
  });
});
