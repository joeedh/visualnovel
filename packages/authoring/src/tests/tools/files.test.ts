import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_CONTEXT_FILE, isGenerated, type ToolContext } from '../../index.js';
import { CHUNKS, run, tempProject } from './testkit.js';

describe('the generated project map', () => {
  it('maps a real project, and re-running it writes the same bytes', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const first = await ctx.workspace.writeGeneratedContext();
      expect(first.file).toBe(join(dir, GENERATED_CONTEXT_FILE));
      expect(first.counts).toEqual({ characters: 1, locations: 1, scenes: 4, bible: 0 });

      const text = await fs.readFile(first.file, 'utf8');
      expect(isGenerated(text)).toBe(true);
      // Paths are relative to the project, so the map is the same on anyone's machine.
      expect(text).toContain('characters/aiko/character.md');
      expect(text).toContain('outfits: uniform (default)');
      expect(text).toContain('## Scenes (4) — entry: arrival');
      expect(text).not.toContain(dir);

      await ctx.workspace.writeGeneratedContext();
      expect(await fs.readFile(first.file, 'utf8')).toBe(text);
    } finally {
      await cleanup();
    }
  });

  it("lists the bible's headings without a line of what a note says", async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await fs.mkdir(join(dir, 'wiki', 'history'), { recursive: true });
      await fs.writeFile(
        join(dir, 'wiki', 'history', 'the-war.md'),
        '# The War\n\n## Casualties\n\nEveryone in the third district.\n',
      );
      const { counts } = await ctx.workspace.writeGeneratedContext();
      expect(counts.bible).toBe(1);

      const text = await fs.readFile(join(dir, GENERATED_CONTEXT_FILE), 'utf8');
      expect(text).toContain('- history/the-war.md "The War" — The War, Casualties');
      expect(text).not.toContain('third district');
    } finally {
      await cleanup();
    }
  });

  it('refuses over a file nobody generated, and writes nothing', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const file = join(dir, GENERATED_CONTEXT_FILE);
      await fs.writeFile(file, 'Hand-written notes I would like to keep.\n');
      await expect(ctx.workspace.writeGeneratedContext()).rejects.toThrow(/move or delete it/);
      expect(await fs.readFile(file, 'utf8')).toBe('Hand-written notes I would like to keep.\n');

      const state = await ctx.workspace.generatedContext();
      expect(state).toEqual({ file, exists: true, generated: false });
    } finally {
      await cleanup();
    }
  });

  it('is reachable as the regenerate_context tool', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const res = await run('regenerate_context', {}, ctx);
      expect(res.ok).toBe(true);
      expect(res.written).toEqual([GENERATED_CONTEXT_FILE]);
      expect(await fs.readFile(join(dir, GENERATED_CONTEXT_FILE), 'utf8')).toContain('Project map');
    } finally {
      await cleanup();
    }
  });
});

describe('editing tools', () => {
  it('write_file refuses a scene chunk, which edit_scene owns', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('write_file', { path: 'scenes/arrival.md', content: 'anything' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('edit_scene');
      // The chunk is left untouched, because an unvalidated overwrite writes duplicate line ids.
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });

  it('update_context persists a rule', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('update_context', { rule: 'Aiko is shy.' }, ctx);
      expect(r.ok).toBe(true);
      const text = await fs.readFile(join(dir, 'AICONTEXT.md'), 'utf8');
      expect(text).toContain('Aiko is shy.');
      // The whole file comes back rather than a receipt, because a receipt would make the next
      // call a read_file of the file this one just wrote a rule into.
      expect(r.output).toContain(text);
      expect(r.data).toBe(text);
    } finally {
      await cleanup();
    }
  });
});

/**
 * `edit_file` makes partial writes to the documents no validated writer owns. The read ledger
 * governs it: the tool refuses what it cannot prove the model was looking at, and one refusal in
 * a batch means nothing at all was written.
 */
describe('edit_file', () => {
  const WIKI =
    '# The Third District\n\nThe district burned in spring.\n\nNobody rebuilt the district.\n';

  async function wikiProject(): Promise<{
    ctx: ToolContext;
    dir: string;
    cleanup: () => Promise<void>;
  }> {
    const made = await tempProject();
    await fs.mkdir(join(made.dir, 'wiki'), { recursive: true });
    await fs.writeFile(join(made.dir, 'wiki', 'district.md'), WIKI);
    return { ...made, ctx: { ...made.ctx, seen: new Map() } };
  }

  const read = (ctx: ToolContext, dir: string) =>
    run('read_file', { path: 'wiki/district.md' }, ctx).then(() =>
      fs.readFile(join(dir, 'wiki', 'district.md'), 'utf8'),
    );

  it('replaces a fragment and reports it back as a diff, not as the file', async () => {
    const { ctx, dir, cleanup } = await wikiProject();
    try {
      await read(ctx, dir);
      const r = await run(
        'edit_file',
        {
          path : 'wiki/district.md',
          edits: [{ old: 'in spring', new: 'in the last week of March' }],
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['wiki/district.md']);
      expect(await fs.readFile(join(dir, 'wiki', 'district.md'), 'utf8')).toContain(
        'The district burned in the last week of March.',
      );
      // The diff returns whole lines, three of context on each side, never the whole document.
      expect(r.output).toContain('- The district burned in spring.');
      expect(r.output).toContain('+ The district burned in the last week of March.');
      expect(r.output).toContain('  # The Third District');
      expect(r.output).not.toContain('- Nobody rebuilt the district.');
    } finally {
      await cleanup();
    }
  });

  it('refuses a file this conversation has not read', async () => {
    const { ctx, dir, cleanup } = await wikiProject();
    try {
      const r = await run(
        'edit_file',
        { path: 'wiki/district.md', edits: [{ old: 'burned', new: 'flooded' }] },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('has not been read this conversation');
      expect(await fs.readFile(join(dir, 'wiki', 'district.md'), 'utf8')).toBe(WIKI);
    } finally {
      await cleanup();
    }
  });

  it('refuses a file that changed since it was read, naming both hashes', async () => {
    const { ctx, dir, cleanup } = await wikiProject();
    try {
      await read(ctx, dir);
      await fs.writeFile(join(dir, 'wiki', 'district.md'), `${WIKI}\nSomeone else wrote this.\n`);
      const r = await run(
        'edit_file',
        { path: 'wiki/district.md', edits: [{ old: 'burned', new: 'flooded' }] },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('changed since you read it');
      expect(r.output).toContain('read_file it again');
    } finally {
      await cleanup();
    }
  });

  it('refuses an ambiguous match unless `all` says it meant all of them', async () => {
    const { ctx, dir, cleanup } = await wikiProject();
    try {
      await read(ctx, dir);
      const ambiguous = await run(
        'edit_file',
        { path: 'wiki/district.md', edits: [{ old: 'district', new: 'block' }] },
        ctx,
      );
      expect(ambiguous.ok).toBe(false);
      expect(ambiguous.output).toContain('appears 2 times');
      expect(ambiguous.output).toContain('Nothing was written');
      expect(await fs.readFile(join(dir, 'wiki', 'district.md'), 'utf8')).toBe(WIKI);

      const all = await run(
        'edit_file',
        { path: 'wiki/district.md', edits: [{ old: 'district', new: 'block', all: true }] },
        ctx,
      );
      expect(all.ok).toBe(true);
      expect(all.output).toContain('and 1 more like it');
    } finally {
      await cleanup();
    }
  });

  it('writes nothing when any edit in the batch misses', async () => {
    const { ctx, dir, cleanup } = await wikiProject();
    try {
      await read(ctx, dir);
      const r = await run(
        'edit_file',
        {
          path : 'wiki/district.md',
          edits: [
            { old: 'spring', new: 'autumn' },
            { old: 'a sentence that is not there', new: 'anything' },
          ],
        },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('edit 2');
      expect(r.output).toContain('matching is exact');
      // The first edit applied in memory only, so the file is still what the model last read.
      expect(await fs.readFile(join(dir, 'wiki', 'district.md'), 'utf8')).toBe(WIKI);
    } finally {
      await cleanup();
    }
  });

  it('leaves the ledger current, so a second edit needs no second read', async () => {
    const { ctx, dir, cleanup } = await wikiProject();
    try {
      await read(ctx, dir);
      await run(
        'edit_file',
        { path: 'wiki/district.md', edits: [{ old: 'spring', new: 'autumn' }] },
        ctx,
      );
      const second = await run(
        'edit_file',
        { path: 'wiki/district.md', edits: [{ old: 'autumn', new: 'winter' }] },
        ctx,
      );
      expect(second.ok).toBe(true);
      expect(await fs.readFile(join(dir, 'wiki', 'district.md'), 'utf8')).toContain('in winter');
    } finally {
      await cleanup();
    }
  });

  it('refuses the three directories a validated writer owns, naming it', async () => {
    const { ctx, cleanup } = await wikiProject();
    try {
      for (const [path, owner] of [
        ['scenes/arrival.md', 'edit_scene'],
        ['characters/aiko/character.md', 'edit_character'],
        ['locations/classroom.md', 'edit_location'],
      ] as const) {
        const r = await run('edit_file', { path, edits: [{ old: 'a', new: 'b' }] }, ctx);
        expect(r.ok).toBe(false);
        expect(r.output).toContain(owner);
      }
    } finally {
      await cleanup();
    }
  });
});

describe('write_file and the read ledger', () => {
  it('creates a file it has never read, then refuses to overwrite one it has not', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    const seen: ToolContext = { ...ctx, seen: new Map() };
    try {
      const created = await run(
        'write_file',
        { path: 'wiki/notes.md', content: '# Notes\n\nNothing yet.\n' },
        seen,
      );
      expect(created.ok).toBe(true);
      expect(await fs.readFile(join(dir, 'wiki', 'notes.md'), 'utf8')).toContain('Nothing yet.');

      // A fresh conversation has read nothing, so the same call now collides with what it made.
      const blind = await run(
        'write_file',
        { path: 'wiki/notes.md', content: 'replaced' },
        { ...ctx, seen: new Map() },
      );
      expect(blind.ok).toBe(false);
      expect(blind.output).toContain('already exists');
      expect(await fs.readFile(join(dir, 'wiki', 'notes.md'), 'utf8')).toContain('Nothing yet.');

      // The conversation that wrote the file kept its ledger entry, so it may overwrite its own
      // work.
      const again = await run(
        'write_file',
        { path: 'wiki/notes.md', content: '# Notes\n\nSomething now.\n' },
        seen,
      );
      expect(again.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
