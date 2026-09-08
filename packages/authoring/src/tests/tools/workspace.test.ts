import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { run, tempProject } from './testkit.js';

describe('workspace index', () => {
  it('lists characters, locations, and scenes', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const index = await ctx.workspace.index();
      expect(index.title).toBe('Test Project');
      expect(index.characters.map((c) => c.id)).toEqual(['aiko']);
      expect(index.locations.map((l) => l.id)).toContain('classroom');
      expect(index.scenes.map((s) => s.id).sort()).toEqual([
        'arrival',
        'ending',
        'greet',
        'observe',
      ]);
    } finally {
      await cleanup();
    }
  });

  it('names the chunk each scene lives in, and no screenplay', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const index = await ctx.workspace.index();
      expect(index.screenplay).toBeUndefined();
      expect(index.entry).toBe('arrival');
      expect(index.scenes[0]!.file).toBe(join(ctx.workspace.root, 'scenes', 'arrival.md'));
    } finally {
      await cleanup();
    }
  });

  it('reports a leftover screenplay without reading a scene out of it', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await fs.mkdir(join(dir, 'screenplay'), { recursive: true });
      await fs.writeFile(join(dir, 'screenplay', 'old.fountain'), 'INT. OLD - DAY\n\nStale.\n');

      const index = await ctx.workspace.index();
      expect(index.screenplay).toBe(join(dir, 'screenplay', 'old.fountain'));
      // Scenes still come from the chunks, and the stray screenplay only shows up as a diagnostic.
      expect(index.scenes.map((s) => s.id).sort()).toEqual([
        'arrival',
        'ending',
        'greet',
        'observe',
      ]);
      expect(index.diagnostics.map((d) => d.code)).toEqual(['stray_screenplay']);
    } finally {
      await cleanup();
    }
  });
});

describe('search_bible', () => {
  async function withBible(files: Record<string, string>) {
    const t = await tempProject();
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(t.dir, 'wiki', rel);
      await fs.mkdir(join(abs, '..'), { recursive: true });
      await fs.writeFile(abs, text);
    }
    return t;
  }

  it('reaches a file `search` does not', async () => {
    const { ctx, cleanup } = await withBible({
      'history/founding.md': '# The founding\n\nThe school was raised over a filled canal.\n',
    });
    try {
      expect((await run('search', { query: 'canal' }, ctx)).data).toEqual([]);
      const r = await run('search_bible', { query: 'canal' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('history/founding.md');
    } finally {
      await cleanup();
    }
  });

  it('says so plainly when nothing matches', async () => {
    const { ctx, cleanup } = await withBible({ 'note.md': '# Note\n\nNothing of consequence.\n' });
    try {
      const r = await run('search_bible', { query: 'submarine' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.data).toEqual([]);
      expect(r.output).toContain('Nothing in the bible');
    } finally {
      await cleanup();
    }
  });

  it('is counted — not pasted — by list_workspace', async () => {
    const { ctx, cleanup } = await withBible({
      'a.md'     : '# A\n\nOne.\n',
      'deep/b.md': '# B\n\nA secret nobody asked for.\n',
    });
    try {
      const r = await run('list_workspace', {}, ctx);
      expect(r.output).toContain('Story bible: 2 file(s)');
      expect(r.output).not.toContain('secret nobody asked for');
    } finally {
      await cleanup();
    }
  });
});

describe('read-only tools', () => {
  it('search reaches scene chunks', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('search', { query: 'The end' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('ending.md');
    } finally {
      await cleanup();
    }
  });

  it('list_workspace summarizes the project', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('list_workspace', {}, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('aiko');
    } finally {
      await cleanup();
    }
  });

  it('search finds a string across input files', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('search', { query: 'transfer student' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('character.md');
    } finally {
      await cleanup();
    }
  });

  it('read_file refuses paths outside the workspace', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('read_file', { path: '../../etc/passwd' }, ctx);
      expect(r.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

/**
 * These tools name the scope they searched and cite paths that resolve. Without the scope an empty
 * result reads as "not in the project", and without the prefix a citation reads as a path the
 * caller cannot open.
 */
describe('tools that say what they looked at', () => {
  it('search names its scope when it finds nothing, and points at the two it skipped', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('search', { query: 'submarine' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('characters/, locations/, scenes/');
      expect(r.output).toContain('search_bible');
      expect(r.output).toContain('list_archive');
    } finally {
      await cleanup();
    }
  });

  it('search_bible cites a path read_file can resolve', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await fs.mkdir(join(dir, 'wiki', 'history'), { recursive: true });
      await fs.writeFile(
        join(dir, 'wiki', 'history', 'founding.md'),
        '# The founding\n\nThe school was raised over a filled canal.\n',
      );
      const r = await run('search_bible', { query: 'canal' }, ctx);
      expect(r.output).toContain('wiki/history/founding.md');

      // The prefix exists so the cited path is one the very next call can hand to read_file.
      const cited = r.output.split(':')[0] as string;
      const back = await run('read_file', { path: cited }, ctx);
      expect(back.ok).toBe(true);
      expect(back.output).toContain('filled canal');
    } finally {
      await cleanup();
    }
  });
});
