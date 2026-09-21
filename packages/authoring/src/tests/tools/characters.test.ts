import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { run, tempProject } from './testkit.js';

// An author who files a character in the bible has still written a character. Every surface
// here — the index, the search, the editor — has to find it where it actually is.
describe('an entity discovered in the wiki', () => {
  const REN = `---
id: ren
type: character
name: Ren
status: draft
default_outfit: uniform
palette: ['#2a441a']
traits: [wry]
---

Ren keeps the roof key.
`;

  async function withWikiRen() {
    const t = await tempProject();
    await fs.mkdir(join(t.dir, 'wiki', 'cast'), { recursive: true });
    await fs.writeFile(join(t.dir, 'wiki', 'cast', 'ren.md'), REN);
    return t;
  }

  it('is indexed at the file it lives in, not at a conventional path', async () => {
    const { ctx, dir, cleanup } = await withWikiRen();
    try {
      const index = await ctx.workspace.index();
      expect(index.characters.map((c) => c.id).sort()).toEqual(['aiko', 'ren']);
      const ren = index.characters.find((c) => c.id === 'ren')!;
      expect(ren.file).toBe(join(dir, 'wiki', 'cast', 'ren.md'));
    } finally {
      await cleanup();
    }
  });

  it('is patched in place by edit_character', async () => {
    const { ctx, dir, cleanup } = await withWikiRen();
    try {
      const r = await run('edit_character', { id: 'ren', traits: ['guarded'] }, ctx);
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['wiki/cast/ren.md']);
      const text = await fs.readFile(join(dir, 'wiki', 'cast', 'ren.md'), 'utf8');
      expect(text).toContain('- guarded');
      expect(text).toContain('type: character');
      expect(text).toContain('Ren keeps the roof key.');
      // The conventional path is where a new sheet would go; nothing was created there.
      await expect(fs.access(join(dir, 'characters', 'ren'))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it('is reported missing rather than scaffolded when no sheet claims the id', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('edit_character', { id: 'nobody', traits: ['guarded'] }, ctx);
      expect(r.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('is visible to discovery and to retrieval, and neither changes the other answer', async () => {
    const { ctx, cleanup } = await withWikiRen();
    try {
      const before = await ctx.workspace.index();
      const found = await run('search_bible', { query: 'roof key' }, ctx);
      expect(found.ok).toBe(true);
      expect(found.output).toContain('cast/ren.md');

      const after = await ctx.workspace.index();
      expect(after.characters).toEqual(before.characters);
      expect(after.diagnostics).toEqual(before.diagnostics);
    } finally {
      await cleanup();
    }
  });
});

describe('editing tools', () => {
  it('edit_character applies a validated patch and writes the file', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('edit_character', { id: 'aiko', traits: ['patient'] }, ctx);
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['characters/aiko/character.md']);
      const text = await fs.readFile(join(dir, 'characters', 'aiko', 'character.md'), 'utf8');
      expect(text).toContain('- patient');
      expect(text).toContain('Aiko is a transfer student.');
    } finally {
      await cleanup();
    }
  });

  it('edit_character rewrites the prose body via description', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_character',
        { id: 'aiko', description: 'Aiko has red hair and green eyes.' },
        ctx,
      );
      expect(r.ok).toBe(true);
      const text = await fs.readFile(join(dir, 'characters', 'aiko', 'character.md'), 'utf8');
      expect(text).toContain('Aiko has red hair and green eyes.');
      expect(text).not.toContain('Aiko is a transfer student.');
    } finally {
      await cleanup();
    }
  });

  it('edit_character rejects an invalid patch without writing', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('edit_character', { id: 'aiko', palette: ['nope'] }, ctx);
      expect(r.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  // The agent has no reach into the pipeline, so an author tweaks the look of generated art by
  // writing it into the sheet, and the prompt builders pick it up from there.
  it('edit_location sets art notes at the location and at one variant', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_location',
        {
          id      : 'classroom',
          artNotes: 'heavy formwork, ink-wash linework',
          variants: ['day', { id: 'afternoon', art_notes: 'low sun raking across the desks' }],
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      const text = await fs.readFile(join(dir, 'locations', 'classroom.md'), 'utf8');
      expect(text).toContain('art_notes: heavy formwork, ink-wash linework');
      expect(text).toContain('low sun raking across the desks');
    } finally {
      await cleanup();
    }
  });

  it('edit_character sets art notes on the character and on one outfit', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_character',
        {
          id      : 'aiko',
          artNotes: 'soft cel shading',
          outfits : { uniform: 'grey blazer', gala: { art_notes: 'satin sheen' } },
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      const text = await fs.readFile(join(dir, 'characters', 'aiko', 'character.md'), 'utf8');
      expect(text).toContain('art_notes: soft cel shading');
      expect(text).toContain('art_notes: satin sheen');
      expect(text).toContain('uniform: grey blazer');
    } finally {
      await cleanup();
    }
  });

  it('create_location scaffolds a new file', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('create_location', { name: 'Rooftop', description: 'Windy.' }, ctx);
      expect(r.ok).toBe(true);
      const text = await fs.readFile(join(dir, 'locations', 'rooftop.md'), 'utf8');
      expect(text).toContain('id: rooftop');
    } finally {
      await cleanup();
    }
  });

  it('list_workspace sees a location sheet created in the same session, and names the file', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const before = await run('list_workspace', {}, ctx);
      expect(before.output).not.toContain('rooftop');
      expect(await run('create_location', { name: 'Rooftop' }, ctx)).toMatchObject({ ok: true });
      const after = await run('list_workspace', {}, ctx);
      expect(after.output).toContain('locations/rooftop.md');
    } finally {
      await cleanup();
    }
  });

  it('list_workspace tells a mined location from an authored one, so writing the sheet shows', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      // `INT. CLASSROOM` mines the same id the sheet carries, so authoring one converts a row
      // rather than adding one. Without the file the two states render identically.
      await fs.rm(join(dir, 'locations', 'classroom.md'));
      const mined = await run('list_workspace', {}, ctx);
      expect(mined.output).toContain('no sheet yet');
      expect(mined.output).not.toContain('locations/classroom.md');

      expect(await run('create_location', { name: 'Classroom' }, ctx)).toMatchObject({ ok: true });
      const authored = await run('list_workspace', {}, ctx);
      expect(authored.output).toContain('locations/classroom.md');
      expect(authored.output).not.toContain('no sheet yet');
    } finally {
      await cleanup();
    }
  });

  it('create_location refuses a name that slugs to nothing rather than writing locations/.md', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('create_location', { name: '???' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('does not name a location');
    } finally {
      await cleanup();
    }
  });
});

/**
 * The create tools take what their `edit_*` siblings take. Before they did, the way to write a
 * sheet with a palette on it was `write_file` and raw YAML — which is what the agent chose, and
 * which the guard now refuses.
 */
describe('create tools with the full field set', () => {
  it('writes a character sheet in one call, validated the way an edit is', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'create_character',
        {
          name         : 'Ren Takada',
          description  : 'Tall, black hair cut short, a burn scar along the left forearm.',
          defaultOutfit: 'everyday',
          outfits      : { everyday: 'grey coat over a work shirt' },
          traits       : ['guarded', 'quick'],
          palette      : ['#1a2a44', '#a02828'],
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.output).toContain('from the description you gave');
      expect(r.output).toContain('defaultOutfit, outfits, traits, palette set');

      const text = await fs.readFile(join(dir, 'characters', 'ren_takada', 'character.md'), 'utf8');
      expect(text).toContain('#a02828');
      expect(text).toContain('grey coat over a work shirt');
      expect(text).toContain('burn scar');
      // The sheet a create wrote reads back as a character, which is the whole point of routing
      // it through the same validator rather than through raw YAML.
      const back = await run('edit_character', { id: 'ren_takada', name: 'Ren' }, ctx);
      expect(back.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('refuses a bad field instead of writing a sheet nothing can read', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('create_character', { name: 'Ren', palette: ['crimson'] }, ctx);
      expect(r.ok).toBe(false);
      await expect(fs.access(join(dir, 'characters', 'ren'))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it('writes a location sheet in one call, and says the body is still empty', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'create_location',
        { name: 'The Workshop', mood: 'close', lighting: 'one lamp', variants: ['day', 'night'] },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.output).toContain('mood, lighting, variants set');
      expect(r.output).toContain('no description');

      const text = await fs.readFile(join(dir, 'locations', 'the_workshop.md'), 'utf8');
      expect(text).toContain('lighting: one lamp');
      expect(text).toContain('night');
    } finally {
      await cleanup();
    }
  });
});

describe('tools that say what they looked at', () => {
  it('the create tools say which of their two behaviours they took', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const described = await run(
        'create_character',
        { name: 'Ren', description: 'A rooftop regular.' },
        ctx,
      );
      expect(described.output).toContain('from the description you gave');

      const blank = await run('create_location', { name: 'Rooftop' }, ctx);
      expect(blank.output).toContain('as an empty template');
      expect(blank.output).toContain('no description was given');
    } finally {
      await cleanup();
    }
  });
});
