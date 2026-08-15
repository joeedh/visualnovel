import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { ProjectPaths, readShots, writeShots } from '@vn/store';
import { VnError } from '@vn/util';
import type { Shot } from '@vn/types';
import type { ConceptRequest, RedrawRequest } from '@vn/artgen';
import {
  createRegistry,
  describeToolParams,
  isGenerated,
  Workspace,
  GENERATED_CONTEXT_FILE,
  type ArtGen,
  type ConceptListing,
  type Tool,
  type ToolContext,
} from '../index.js';

const CHARACTER = `---
id: aiko
name: Aiko
status: draft
default_outfit: uniform
palette: ['#1a2a44']
traits: [curious]
---

Aiko is a transfer student.
`;

const LOCATION = `---
id: classroom
name: Classroom 2-B
variants: [day, afternoon]
---

A second-floor classroom.
`;

/** One `scenes/<id>.md` per scene — a fork, its two arms, and the rejoin they share. */
const CHUNKS: Record<string, string> = {
  arrival: `---
scene: arrival
---

INT. CLASSROOM - AFTERNOON

[[choice: Greet -> greet]]
[[choice: Observe -> observe]]

AIKO
Hello.
`,
  greet: '---\nscene: greet\n---\n\nINT. CLASSROOM - AFTERNOON\n\n[[next: ending]]\n',
  observe: '---\nscene: observe\n---\n\nINT. CLASSROOM - EVENING\n\n[[next: ending]]\n',
  // Three lines, so it can hold two shots and therefore an order worth changing.
  ending: `---
scene: ending
---

INT. CLASSROOM - EVENING

The end.

AIKO
Goodbye.

She leaves.
`,
};

async function tempProject(): Promise<{
  ctx: ToolContext;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-tools-'));
  await fs.mkdir(join(dir, 'characters', 'aiko'), { recursive: true });
  await fs.mkdir(join(dir, 'locations'), { recursive: true });
  await fs.mkdir(join(dir, 'scenes'), { recursive: true });
  await fs.writeFile(join(dir, 'characters', 'aiko', 'character.md'), CHARACTER);
  await fs.writeFile(join(dir, 'locations', 'classroom.md'), LOCATION);
  for (const [id, text] of Object.entries(CHUNKS)) {
    await fs.writeFile(join(dir, 'scenes', `${id}.md`), text);
  }
  // A directory has no document order, so the entry scene has to be named.
  await fs.writeFile(join(dir, 'project.yaml'), 'title: Test Project\nstart: arrival\n');
  const ctx: ToolContext = { workspace: new Workspace(dir), git: openGit(dir) };
  return { ctx, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const registry = createRegistry();
function tool(name: string): Tool {
  const t = registry.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
const run = (name: string, args: unknown, ctx: ToolContext) =>
  tool(name).run(tool(name).args.parse(args), ctx);

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
      // The chunks still win, and the leftover only shows up as something to clean up.
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
      const r = await run('edit_character', { id: 'ren', status: 'approved' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['wiki/cast/ren.md']);
      const text = await fs.readFile(join(dir, 'wiki', 'cast', 'ren.md'), 'utf8');
      expect(text).toContain('status: approved');
      expect(text).toContain('type: character');
      expect(text).toContain('Ren keeps the roof key.');
      // The conventional path is where a *new* sheet would go; nothing was created there.
      await expect(fs.access(join(dir, 'characters', 'ren'))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it('is reported missing rather than scaffolded when no sheet claims the id', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('edit_character', { id: 'nobody', status: 'approved' }, ctx);
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
      'a.md': '# A\n\nOne.\n',
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

  it('validate_inputs passes on a valid project', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('validate_inputs', {}, ctx);
      expect(r.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('story_graph reports reachability and no dangling edges', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('story_graph', {}, ctx);
      expect(r.output).toContain('Unreachable: none');
      expect(r.output).toContain('Dangling: none');
    } finally {
      await cleanup();
    }
  });

  it('extract_entities reports referenced vs defined', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('extract_entities', {}, ctx);
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

describe('editing tools', () => {
  it('edit_character applies a validated patch and writes the file', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('edit_character', { id: 'aiko', status: 'approved' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['characters/aiko/character.md']);
      const text = await fs.readFile(join(dir, 'characters', 'aiko', 'character.md'), 'utf8');
      expect(text).toContain('status: approved');
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

  // How an author tweaks the look of generated art: the agent has no reach into the pipeline,
  // so it says what the art should look like in the sheet, and the prompt builders pick it up.
  it('edit_location sets art notes at the location and at one variant', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_location',
        {
          id: 'classroom',
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
          id: 'aiko',
          artNotes: 'soft cel shading',
          outfits: { uniform: 'grey blazer', gala: { art_notes: 'satin sheen' } },
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

  it('write_file refuses a scene chunk, which edit_scene owns', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('write_file', { path: 'scenes/arrival.md', content: 'anything' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('edit_scene');
      // The refusal is the point: an unvalidated overwrite is what writes duplicate line ids.
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
    } finally {
      await cleanup();
    }
  });
});

/**
 * `edit_scene`: the agent's only prose write path. What is asserted here is that it is the *same*
 * write path the desktop's `story.*` commands are — the decisions, the refusals and the storyboard
 * accounting all come from `@vn/scriptedit`, which has its own suites for each. So these cases are
 * about the seam: which file changed, what the tool refuses on its own, and what it reports.
 */
describe('edit_scene', () => {
  it('retypes a line, writing only that chunk', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_scene',
        { op: 'setLineText', line: 'arrival:L1', text: 'Good afternoon.' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['scenes/arrival.md']);
      const text = await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8');
      expect(text).toContain('Good afternoon.');
      // The first edit canonicalizes the chunk, line-id marks included — there is no surgical
      // form of a prose edit, so the ids the reader allocated get written down.
      expect(text).toContain('[[line: L1]]');
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).toBe(CHUNKS.greet);
    } finally {
      await cleanup();
    }
  });

  it('creates a scene chunk from a heading', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_scene',
        { op: 'newScene', scene: 'rooftop', heading: 'EXT. ROOFTOP - DUSK' },
        ctx,
      );
      expect(r.ok).toBe(true);
      const text = await fs.readFile(join(dir, 'scenes', 'rooftop.md'), 'utf8');
      expect(text).toContain('scene: rooftop');
      expect(text).toContain('EXT. ROOFTOP - DUSK');
    } finally {
      await cleanup();
    }
  });

  it('names the arguments an op needs instead of guessing them', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('edit_scene', { op: 'splitScene', scene: 'arrival' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toBe('splitScene needs: at, into');
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });

  it('passes a refusal through from the rules, untouched', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('edit_scene', { op: 'deleteScene', scene: 'ending' }, ctx);
      expect(r.ok).toBe(false);
      // The sentence is `lineops`': it names every referrer, which is what makes it actionable.
      expect(r.output).toContain('greet (next)');
      expect(r.output).toContain('observe (next)');
      expect(await fs.readFile(join(dir, 'scenes', 'ending.md'), 'utf8')).toBe(CHUNKS.ending);
    } finally {
      await cleanup();
    }
  });

  it('reports what an edit costs the storyboard, and rewrites it', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const paths = new ProjectPaths(dir);
      const shot: Shot = {
        id: 'arrival__beat1',
        sceneId: 'arrival',
        framing: 'medium',
        location: 'classroom',
        subjects: [{ characterId: 'aiko', outfit: 'uniform' }],
        coversLines: ['arrival:L1'],
        status: 'pending',
      };
      await writeShots(paths, 'arrival', [shot]);

      const r = await run('edit_scene', { op: 'deleteLine', line: 'arrival:L1' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('1 shot(s) lose 1 line(s) of coverage');
      expect(r.output).toContain('1 shot(s) end up covering nothing');
      // The shot is kept, covering nothing: it is real and paid for, and deleting art is the
      // author's call. The storyboard is rewritten to say so, and that file is in `written`.
      const after = await readShots(paths, 'arrival');
      expect(after?.shots.map((s) => s.coversLines)).toEqual([[]]);
      expect(r.written).toContain('vngen/work/shots/arrival.json');
    } finally {
      await cleanup();
    }
  });

  /**
   * The one act whose rule needs the storyboard rather than only costing it something. It moves
   * prose, so it writes the chunk — and it moves whole shots, so the storyboard is untouched.
   */
  it('reorders a shot by moving the lines it covers, and leaves the storyboard alone', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const paths = new ProjectPaths(dir);
      const shot = (id: string, coversLines: string[]): Shot => ({
        id,
        sceneId: 'ending',
        framing: 'medium',
        location: 'classroom',
        subjects: [],
        coversLines,
        status: 'pending',
      });
      const shots = [
        shot('ending__a', ['ending:L1']),
        shot('ending__b', ['ending:L2', 'ending:L3']),
      ];
      await writeShots(paths, 'ending', shots);

      const r = await run(
        'edit_scene',
        { op: 'moveShot', scene: 'ending', shot: 'ending__b' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['scenes/ending.md']);
      expect(r.output).toContain('nothing drifts');

      const text = await fs.readFile(join(dir, 'scenes', 'ending.md'), 'utf8');
      expect(text.indexOf('Goodbye.')).toBeLessThan(text.indexOf('The end.'));
      // The shots file is not in `written` and says exactly what it said before: a reorder moves
      // whole shots, so no coverage changes and no line's own shot changes.
      expect((await readShots(paths, 'ending'))?.shots).toEqual(shots);
    } finally {
      await cleanup();
    }
  });

  it('refuses to reorder shots in a scene nothing has decomposed yet', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_scene',
        { op: 'moveShot', scene: 'arrival', shot: 'arrival__beat1' },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('no decomposition yet');
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });
});

/**
 * `set_outfit`: one sentence, two files. The rules it runs are `@vn/scriptedit`'s and are tested
 * there, so what is asserted here is the seam — which level a `shot` argument picks, which file
 * that level writes, and that a refusal arrives verbatim rather than reworded.
 */
describe('set_outfit', () => {
  /** The wardrobe goes on through `edit_character`, which is how an author would author it. */
  const dressAiko = (ctx: ToolContext) =>
    run(
      'edit_character',
      { id: 'aiko', outfits: { uniform: 'School uniform.', track: 'Tracksuit.' } },
      ctx,
    );

  it('marks a whole scene, splicing the marker into that chunk alone', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      expect((await dressAiko(ctx)).ok).toBe(true);
      const r = await run(
        'set_outfit',
        { scene: 'arrival', character: 'aiko', outfit: 'track' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['scenes/arrival.md']);
      const text = await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8');
      expect(text).toContain('[[outfit: aiko=track]]');
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).toBe(CHUNKS.greet);
    } finally {
      await cleanup();
    }
  });

  it('clears a marker and names the level that answers instead', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await dressAiko(ctx);
      await run('set_outfit', { scene: 'arrival', character: 'aiko', outfit: 'track' }, ctx);
      const r = await run('set_outfit', { scene: 'arrival', character: 'aiko', outfit: '' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('"uniform"');
      const text = await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8');
      expect(text).not.toContain('[[outfit:');
    } finally {
      await cleanup();
    }
  });

  it('overrides one shot, writing the storyboard and not the prose', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await dressAiko(ctx);
      const paths = new ProjectPaths(dir);
      const shot: Shot = {
        id: 'arrival__beat1',
        sceneId: 'arrival',
        framing: 'medium',
        location: 'classroom',
        subjects: [{ characterId: 'aiko' }],
        coversLines: ['arrival:L1'],
        status: 'pending',
      };
      await writeShots(paths, 'arrival', [shot]);

      const r = await run(
        'set_outfit',
        { scene: 'arrival', shot: 'arrival__beat1', character: 'aiko', outfit: 'track' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['vngen/work/shots/arrival.json']);
      const after = await readShots(paths, 'arrival');
      expect(after?.shots[0]!.subjects).toEqual([{ characterId: 'aiko', outfit: 'track' }]);
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });

  it('passes the wardrobe refusal through, listing what the sheet does author', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'set_outfit',
        { scene: 'arrival', character: 'aiko', outfit: 'track' },
        ctx,
      );
      expect(r.ok).toBe(false);
      // Nothing authored a wardrobe yet, so the only outfit is the default the sheet names.
      expect(r.output).toBe('"aiko" has no outfit "track" — they have "uniform".');
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });
});

/** The seam, recorded rather than wired: a tool's job is what it asks for, not the picture. */
function fakeArt(dir: string): {
  art: ArtGen;
  asked: ConceptRequest[];
  redrawn: RedrawRequest[];
  /** The concepts `list_images` and `edit_image`'s prefix resolver see; empty until pushed to. */
  concepts: ConceptListing[];
} {
  const asked: ConceptRequest[] = [];
  const redrawn: RedrawRequest[] = [];
  const concepts: ConceptListing[] = [];
  const objectFile = (hash: string): string => join(dir, 'assets', 'objects', `${hash}.png`);
  const art: ArtGen = {
    preview: (req) => Promise.resolve({ prompt: `PROMPT ${req.sentence}` }),
    generate: (req) => {
      asked.push(req);
      return Promise.resolve({
        ref: { hash: 'f'.repeat(64), ext: 'png' },
        ...(req.subject ? { subject: req.subject } : {}),
        prompt: `PROMPT ${req.sentence}`,
        file: objectFile('f'.repeat(64)),
      });
    },
    list: () => Promise.resolve(concepts),
    redraw: (req) => {
      redrawn.push(req);
      return Promise.resolve({
        ref: { hash: 'a'.repeat(64), ext: 'png' },
        prompt: req.prompt ?? 'THE RECORDED PROMPT',
        file: objectFile('a'.repeat(64)),
        from: req.hash,
        unchanged: false,
      });
    },
  };
  return { art, asked, redrawn, concepts };
}

describe('generate_image', () => {
  it('refuses without a seam rather than assume a key exists to spend', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('generate_image', { sentence: 'an aerial shot of the school' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('not available');
    } finally {
      await cleanup();
    }
  });

  it('draws, names what it bound to, and stages the bytes with the manifest', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, asked } = fakeArt(dir);
      const r = await run(
        'generate_image',
        { sentence: 'the classroom from above', subject: 'location:classroom' },
        { ...ctx, art },
      );
      expect(r.ok).toBe(true);
      expect(asked).toEqual([
        { sentence: 'the classroom from above', subject: { kind: 'location', id: 'classroom' } },
      ]);
      expect(r.output).toContain('location:classroom');
      expect(r.written).toEqual([`assets/objects/${'f'.repeat(64)}.png`, 'assets/manifest.json']);
    } finally {
      await cleanup();
    }
  });

  it('refuses a subject that is not written as kind:id', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, asked } = fakeArt(dir);
      const r = await run(
        'generate_image',
        { sentence: 'the roof at dusk', subject: 'classroom' },
        { ...ctx, art },
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('location:<id>');
      expect(asked).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('passes a refusal from the seam through instead of throwing', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const { art } = fakeArt(ctx.workspace.root);
      art.generate = () =>
        Promise.reject(new VnError('BASE_UNAVAILABLE', 'The base art root is unavailable.'));
      const r = await run('generate_image', { sentence: 'anything' }, { ...ctx, art });
      expect(r.ok).toBe(false);
      expect(r.output).toBe('The base art root is unavailable.');
    } finally {
      await cleanup();
    }
  });

  it('is mutating and always confirmed — it spends money', () => {
    expect(tool('generate_image').mutating).toBe(true);
    expect(tool('generate_image').confirm).toBe(true);
  });
});

describe('list_images', () => {
  it('reads nothing and says so when there is nothing drawn yet', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art } = fakeArt(dir);
      const r = await run('list_images', {}, { ...ctx, art });
      expect(r.ok).toBe(true);
      expect(r.output).toContain('generate_image');
      expect(tool('list_images').mutating).toBe(false);
    } finally {
      await cleanup();
    }
  });

  // The prompt is in the listing because it is the thing `edit_image` starts from: an agent that
  // could not read it would have to invent a whole prompt to change three words of one.
  it('names each sketch, what it is of, and the prompt it was drawn from', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, concepts } = fakeArt(dir);
      concepts.push({
        hash: 'b'.repeat(64),
        file: join(dir, 'assets', 'objects', `${'b'.repeat(64)}.png`),
        title: 'the school from above',
        prompt: 'STYLE. Subject: School. from above',
        subject: { kind: 'location', id: 'classroom' },
      });
      const r = await run('list_images', {}, { ...ctx, art });
      expect(r.ok).toBe(true);
      expect(r.output).toContain('the school from above');
      expect(r.output).toContain('location:classroom');
      expect(r.output).toContain('STYLE. Subject: School. from above');
      expect(r.data).toEqual([
        {
          hash: 'b'.repeat(64),
          title: 'the school from above',
          prompt: 'STYLE. Subject: School. from above',
          subject: 'location:classroom',
        },
      ]);
    } finally {
      await cleanup();
    }
  });
});

describe('edit_image', () => {
  const sketch = (dir: string, hash: string): ConceptListing => ({
    hash,
    file: join(dir, 'assets', 'objects', `${hash}.png`),
    title: 'the school from above',
    prompt: 'STYLE. Subject: School. from above',
  });

  it('draws the edited prompt and says the original is still there', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, redrawn, concepts } = fakeArt(dir);
      concepts.push(sketch(dir, 'b'.repeat(64)));
      const r = await run(
        'edit_image',
        { hash: 'bbbbbbbb', prompt: 'STYLE. Subject: School. from above, at dusk' },
        { ...ctx, art },
      );
      expect(r.ok).toBe(true);
      // The prefix resolved to the whole hash before anything was spent.
      expect(redrawn).toEqual([
        { hash: 'b'.repeat(64), prompt: 'STYLE. Subject: School. from above, at dusk' },
      ]);
      expect(r.output).toContain('is still there');
      expect(r.written).toEqual([`assets/objects/${'a'.repeat(64)}.png`, 'assets/manifest.json']);
    } finally {
      await cleanup();
    }
  });

  // Two sketches under one prefix is a question, and asking costs nothing; guessing costs a
  // generation and produces the wrong picture.
  it('refuses an unknown prefix and an ambiguous one, spending nothing either way', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, redrawn, concepts } = fakeArt(dir);
      concepts.push(sketch(dir, `bbbb${'1'.repeat(60)}`), sketch(dir, `bbbb${'2'.repeat(60)}`));

      const missing = await run('edit_image', { hash: 'cccc' }, { ...ctx, art });
      expect(missing.ok).toBe(false);
      expect(missing.output).toContain('list_images');

      const both = await run('edit_image', { hash: 'bbbb' }, { ...ctx, art });
      expect(both.ok).toBe(false);
      expect(both.output).toContain('names 2 concepts');
      expect(redrawn).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  // A whole hash goes through untouched so the refusal comes from `redrawConcept`, which is the
  // half that knows a portrait's prompt is derived and names the command that re-renders one.
  it('passes a full hash straight to the seam, refusals and all', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art } = fakeArt(dir);
      art.redraw = () =>
        Promise.reject(new VnError('NOT_A_CONCEPT', 'Asset 1234abcd is a portrait: …'));
      const r = await run('edit_image', { hash: '1'.repeat(64) }, { ...ctx, art });
      expect(r.ok).toBe(false);
      expect(r.output).toContain('is a portrait');
    } finally {
      await cleanup();
    }
  });

  it('refuses without a seam, and is mutating and always confirmed', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('edit_image', { hash: 'b'.repeat(64) }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('not available');
      expect(tool('edit_image').mutating).toBe(true);
      expect(tool('edit_image').confirm).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('registry metadata', () => {
  it('marks mutating tools and confirmation-gated tools', () => {
    expect(tool('read_file').mutating).toBe(false);
    expect(tool('edit_character').mutating).toBe(true);
    expect(tool('git_revert').confirm).toBe(true);
    expect(tool('git_restore').confirm).toBe(true);
  });

  it('describes tool arg names and intent so the model need not guess them', () => {
    const sig = describeToolParams(tool('edit_character').args);
    // The prose body field must be named and explained — the gap that caused edit churn.
    expect(sig).toContain('description?: string (full prose body');
    expect(sig).toContain('id: string');
    expect(sig).toContain('palette?: string[]');
    // Enums render their literal options.
    expect(sig).toContain('status?: "draft"|"candidates"|"approved"|"locked"');
  });
});
