import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { AssetStore, ProjectPaths, readShots, writeShots } from '@vn/store';
import { exists, VnError } from '@vn/util';
import type { Shot, TextLLM } from '@vn/types';
import type { ConceptRequest, DescribeRequest, RedrawRequest } from '@vn/artgen';
import {
  createRegistry,
  describeToolParams,
  isGenerated,
  jsonSchemaOf,
  Workspace,
  GENERATED_CONTEXT_FILE,
  type ArtGen,
  type ConceptListing,
  type PipelineControl,
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
      // The conventional path is where a new sheet would go; nothing was created there.
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

  // The agent has no reach into the pipeline, so an author tweaks the look of generated art by
  // writing it into the sheet, and the prompt builders pick it up from there.
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
 * `edit_scene` is the agent's only prose write path, and it is the same write path the desktop's
 * `story.*` commands use — the decisions, the refusals and the storyboard accounting all come from
 * `@vn/scriptedit`, which has its own suites for each. These cases cover the seam: which file
 * changed, what the tool refuses on its own, and what it reports.
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

  it('drafts a run of prose in one call, in the order it was given', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_scene',
        {
          op: 'insertLines',
          scene: 'arrival',
          after: 'arrival:L1',
          lines: [
            { speaker: 'REN', text: 'You are in my seat.' },
            { kind: 'narration', text: 'Aiko does not look up.' },
            { speaker: 'AIKO', text: 'I know.' },
          ],
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['scenes/arrival.md']);
      const text = await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8');
      expect(text.indexOf('You are in my seat.')).toBeLessThan(
        text.indexOf('Aiko does not look up.'),
      );
      expect(text.indexOf('Aiko does not look up.')).toBeLessThan(text.indexOf('I know.'));
    } finally {
      await cleanup();
    }
  });

  it('writes none of a run when one line of it is refused', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'edit_scene',
        {
          op: 'insertLines',
          scene: 'arrival',
          after: '',
          lines: [{ kind: 'narration', text: 'Fine.' }, { text: 'Who says this?' }],
        },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('line 2 of 2');
      expect(r.output).toContain('Nothing was inserted.');
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
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
      // `lineops` writes this sentence, and it names every referrer, which is what makes it
      // actionable.
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
      // The shot stays in the storyboard even though it now covers nothing, because its art was
      // already generated and paid for, and only the author may delete it. The storyboard file
      // is rewritten to record that, and it appears in `written`.
      const after = await readShots(paths, 'arrival');
      expect(after?.shots.map((s) => s.coversLines)).toEqual([[]]);
      expect(r.written).toContain('vngen/work/shots/arrival.json');
    } finally {
      await cleanup();
    }
  });

  /**
   * Reordering is the one act whose rule needs the storyboard rather than only costing it
   * something. It moves prose, so it writes the chunk, and it moves whole shots, so the
   * storyboard is untouched.
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
 * `edit_branches` is the agent's only way to say what leads where. The rules are `@vn/scriptedit`'s
 * `branchops` and are tested there, so these cases cover the seam — and the bug the tool exists to
 * fix, which is that a scene the agent created had nothing that could point at it.
 */
describe('edit_branches', () => {
  it('links a scene the agent just created, which is the whole reason it exists', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const made = await run(
        'edit_scene',
        { op: 'newScene', scene: 'rooftop', heading: 'EXT. ROOFTOP - DUSK' },
        ctx,
      );
      expect(made.ok).toBe(true);
      // `newScene` reports that nothing points at the new scene, and before `edit_branches` there
      // was no way to act on that. The reported bug is reproduced here: a scene the agent made
      // that the story cannot get to.
      expect(made.output).toContain('nothing points at it yet');
      expect((await run('story_graph', {}, ctx)).output).toContain('Unreachable: rooftop');

      const wired = await run(
        'edit_branches',
        { op: 'setNext', scene: 'rooftop', goto: 'ending' },
        ctx,
      );
      expect(wired.ok).toBe(true);
      expect(wired.written).toEqual(['scenes/rooftop.md']);
      expect(await fs.readFile(join(dir, 'scenes', 'rooftop.md'), 'utf8')).toContain(
        '[[next: ending]]',
      );

      const inbound = await run(
        'edit_branches',
        { op: 'setChoice', scene: 'arrival', goto: 'rooftop', label: 'Go up' },
        ctx,
      );
      expect(inbound.ok).toBe(true);
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toContain(
        '[[choice: "Go up" -> rooftop]]',
      );

      // With the wiring in place the graph reaches rooftop, and nothing dangles.
      const graph = await run('story_graph', {}, ctx);
      expect(graph.output).toContain('Unreachable: none');
      expect(graph.output).toContain('Dangling: none');
    } finally {
      await cleanup();
    }
  });

  it('splices a scene into an existing edge as one two-scene patch', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      expect(
        (
          await run(
            'edit_scene',
            { op: 'newScene', scene: 'stairs', heading: 'INT. STAIRS - DAY' },
            ctx,
          )
        ).ok,
      ).toBe(true);
      const r = await run(
        'edit_branches',
        { op: 'spliceScene', scene: 'stairs', from: 'greet' },
        ctx,
      );

      expect(r.ok).toBe(true);
      expect(r.output).toContain('Spliced stairs into greet → ending');
      expect((r.written ?? []).sort()).toEqual(['scenes/greet.md', 'scenes/stairs.md']);
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).toContain(
        '[[next: stairs]]',
      );
      expect(await fs.readFile(join(dir, 'scenes', 'stairs.md'), 'utf8')).toContain(
        '[[next: ending]]',
      );
    } finally {
      await cleanup();
    }
  });

  it('names the arguments an op needs instead of guessing them', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('edit_branches', { op: 'setChoice', scene: 'arrival' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toBe('setChoice needs: goto, label');
      expect(await fs.readFile(join(dir, 'scenes', 'arrival.md'), 'utf8')).toBe(CHUNKS.arrival);
    } finally {
      await cleanup();
    }
  });

  it('passes a refusal through from the rules, untouched, and writes nothing', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      // `arrival` forks, and `next` is only followed by a scene with no choices — so the spliced
      // edge would never be taken. `branchops` refuses in exactly those words.
      const r = await run(
        'edit_branches',
        { op: 'spliceScene', scene: 'arrival', from: 'greet' },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('would never be taken');
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).toBe(CHUNKS.greet);
    } finally {
      await cleanup();
    }
  });

  it('writes nothing when the wiring already says what it was asked to say', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('edit_branches', { op: 'setNext', scene: 'greet', goto: 'ending' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('already wired that way');
      expect(r.written).toBeUndefined();
      expect(await fs.readFile(join(dir, 'scenes', 'greet.md'), 'utf8')).toBe(CHUNKS.greet);
    } finally {
      await cleanup();
    }
  });
});

/**
 * `set_outfit` writes one of two files from one sentence. The rules it runs are `@vn/scriptedit`'s
 * and are tested there, so these cases cover the seam — which level a `shot` argument picks, which
 * file that level writes, and that a refusal arrives verbatim rather than reworded.
 */
describe('set_outfit', () => {
  /** Dresses Aiko through `edit_character`, the same path an author would take. */
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

describe('set_variant', () => {
  const boarded = (variant: string, paths: ProjectPaths): Promise<unknown> =>
    writeShots(paths, 'arrival', [
      {
        id: 'arrival__beat1',
        sceneId: 'arrival',
        framing: 'medium',
        location: variant,
        subjects: [{ characterId: 'aiko' }],
        coversLines: ['arrival:L1'],
        status: 'pending',
      },
    ]);

  it('moves one shot to another variant and says the frame is drawn again', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const paths = new ProjectPaths(dir);
      await boarded('day', paths);
      const r = await run(
        'set_variant',
        { scene: 'arrival', shot: 'arrival__beat1', variant: 'afternoon' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['vngen/work/shots/arrival.json']);
      expect(r.output).toContain('drawn again');
      const after = await readShots(paths, 'arrival');
      expect(after?.shots[0]!.location).toBe('afternoon');
    } finally {
      await cleanup();
    }
  });

  it('gives the rule’s refusal, naming the variants the location does have', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const paths = new ProjectPaths(dir);
      await boarded('day', paths);
      const r = await run(
        'set_variant',
        { scene: 'arrival', shot: 'arrival__beat1', variant: 'midnight' },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('"day", "afternoon"');
      expect((await readShots(paths, 'arrival'))?.shots[0]!.location).toBe('day');
    } finally {
      await cleanup();
    }
  });

  it('refuses a scene with no storyboard rather than making one', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run(
        'set_variant',
        { scene: 'arrival', shot: 'arrival__beat1', variant: 'afternoon' },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('no decomposition yet');
    } finally {
      await cleanup();
    }
  });
});

/** Records what each art call asked for rather than drawing a picture. */
function fakeArt(dir: string): {
  art: ArtGen;
  asked: ConceptRequest[];
  redrawn: RedrawRequest[];
  /** The concepts `list_images` and `edit_image`'s prefix resolver see; empty until pushed to. */
  concepts: ConceptListing[];
  /** What `view_image` asked to look at. */
  looked: DescribeRequest[];
} {
  const asked: ConceptRequest[] = [];
  const redrawn: RedrawRequest[] = [];
  const concepts: ConceptListing[] = [];
  const looked: DescribeRequest[] = [];
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
    describe: (req) => {
      looked.push(req);
      return Promise.resolve({
        hash: req.hash,
        label: 'the picture',
        answer: `LOOKED AT ${req.hash.slice(0, 8)}: ${req.question ?? '(the default question)'}`,
      });
    },
  };
  return { art, asked, redrawn, concepts, looked };
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

  // Two sketches under one prefix are ambiguous, and asking costs nothing; guessing costs a
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

/** One rendered plate on disk, so the asset tools have something real to name. */
async function plate(dir: string): Promise<string> {
  const store = await AssetStore.open(new ProjectPaths(dir));
  const ref = await store.write(new TextEncoder().encode('the plate itself'), 'png', {
    kind: 'location_ref',
    sourceTask: 't'.repeat(64),
    modelId: 'fake-image',
    satisfies: { locationId: 'classroom', variant: 'day' },
  });
  return ref.hash;
}

/** Records what a tool asked the pipeline for rather than doing what a scheduler would. */
function fakePipeline(): { pipeline: PipelineControl; queued: string[]; ran: () => number } {
  const queued: string[] = [];
  let runs = 0;
  const pipeline: PipelineControl = {
    regenerate: (hash) => {
      queued.push(hash);
      return Promise.resolve({
        ok: true,
        message: `Queued location_ref ${hash.slice(0, 8)} for re-run.`,
        written: ['vngen/state/tasks.jsonl'],
      });
    },
    run: () => {
      runs += 1;
      return Promise.resolve({ ran: 1, failed: 0, blockedOnGate: false });
    },
  };
  return { pipeline, queued, ran: () => runs };
}

describe('list_assets', () => {
  it('lists what was rendered for a subject, in the project’s own name for it', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const hash = await plate(dir);
      const r = await run('list_assets', { subject: 'location:classroom' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain(hash.slice(0, 12));
      expect(r.output).toContain('classroom — day plate');
      expect(r.output).toContain('[location_ref]');
      expect(r.data).toEqual([
        { hash, kind: 'location_ref', label: 'classroom — day plate', accepted: false },
      ]);
    } finally {
      await cleanup();
    }
  });

  // "Nothing yet" and "that is not a subject" are different answers, and an agent that cannot
  // tell them apart writes a note on a rung it invented.
  it('separates a subject with nothing rendered from a subject it cannot parse', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await plate(dir);
      const empty = await run('list_assets', { subject: 'character:aiko' }, ctx);
      expect(empty.ok).toBe(true);
      expect(empty.output).toContain('No rendered assets for character:aiko');

      const bad = await run('list_assets', { subject: 'classroom' }, ctx);
      expect(bad.ok).toBe(false);
      expect(bad.output).toContain('is not a subject');
    } finally {
      await cleanup();
    }
  });
});

describe('art_notes and set_art_notes', () => {
  it('reports both rungs a plate answers to, and what each says today', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const hash = await plate(dir);
      const before = await run('art_notes', { hash: hash.slice(0, 8) }, ctx);
      expect(before.ok).toBe(true);
      expect(before.data).toEqual([
        { target: 'location:classroom', label: 'Classroom 2-B' },
        { target: 'location:classroom/day', label: 'Classroom 2-B — day' },
      ]);
      expect(before.output).toContain('(nothing authored)');

      const wrote = await run(
        'set_art_notes',
        { target: 'location:classroom/day', notes: 'brutalist concrete' },
        ctx,
      );
      expect(wrote.ok).toBe(true);
      expect(wrote.output).toContain('Appended to art notes on Classroom 2-B — day.');
      expect(wrote.written).toEqual(['locations/classroom.md']);

      const after = await run('art_notes', { hash }, ctx);
      expect(after.output).toContain('brutalist concrete');
      // The other variant is untouched, and the sheet still declares both.
      expect(await fs.readFile(join(dir, 'locations', 'classroom.md'), 'utf8')).toContain(
        'afternoon',
      );
    } finally {
      await cleanup();
    }
  });

  it('appends by default, replaces and clears when told', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await run('set_art_notes', { target: 'location:classroom', notes: 'first' }, ctx);
      await run('set_art_notes', { target: 'location:classroom', notes: 'second' }, ctx);
      const workspace = new Workspace(dir);
      const notesNow = async (): Promise<string | undefined> =>
        (await workspace.load()).model.locations.get('classroom')?.artNotes;
      expect(await notesNow()).toBe('first\nsecond');

      await run(
        'set_art_notes',
        { target: 'location:classroom', notes: 'only this', mode: 'replace' },
        ctx,
      );
      expect(await notesNow()).toBe('only this');

      const cleared = await run(
        'set_art_notes',
        { target: 'location:classroom', mode: 'clear' },
        ctx,
      );
      expect(cleared.output).toContain('Cleared art notes on Classroom 2-B.');
      expect(await notesNow()).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // A note on a variant nobody declared means a typo, and creating the variant would hide it.
  it('refuses a rung that does not exist and a target it cannot parse', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const missing = await run(
        'set_art_notes',
        { target: 'location:classroom/midnight', notes: 'x' },
        ctx,
      );
      expect(missing.ok).toBe(false);
      expect(missing.output).toBe('No such art-notes rung: location:classroom/midnight.');

      const bad = await run('set_art_notes', { target: 'classroom', notes: 'x' }, ctx);
      expect(bad.ok).toBe(false);
      expect(bad.output).toContain('names no art-notes rung');
      expect(await fs.readFile(join(dir, 'locations', 'classroom.md'), 'utf8')).toBe(LOCATION);
    } finally {
      await cleanup();
    }
  });
});

describe('view_image', () => {
  it('resolves a prefix before spending the call, and passes the question through', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const hash = await plate(dir);
      const { art, looked } = fakeArt(dir);
      const r = await run(
        'view_image',
        { hash: hash.slice(0, 10), question: 'is it brutalist yet?' },
        { ...ctx, art },
      );
      expect(r.ok).toBe(true);
      expect(looked).toEqual([{ hash, question: 'is it brutalist yet?' }]);
      expect(r.output).toContain('the picture');
    } finally {
      await cleanup();
    }
  });

  it('refuses an asset the store has never rendered, and refuses without a seam', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, looked } = fakeArt(dir);
      const unknown = await run('view_image', { hash: 'f'.repeat(64) }, { ...ctx, art });
      expect(unknown.ok).toBe(false);
      expect(unknown.output).toContain('list_assets');
      expect(looked).toHaveLength(0);

      await plate(dir);
      const bare = await run('view_image', { hash: 'f'.repeat(8) }, ctx);
      expect(bare.ok).toBe(false);
      expect(bare.output).toContain('not available');
      expect(tool('view_image').mutating).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('regenerate_asset', () => {
  // The boundaries rule stops `@vn/authoring` from running a pipeline, so the tool names the host
  // that can rather than failing with something the author cannot act on.
  it('refuses without the capability and names the host that has it', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await plate(dir);
      const r = await run('regenerate_asset', { hash: 'a'.repeat(8) }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toBe(
        'regenerating a planned asset runs the pipeline, which vnauthor does not do — open the project in the desktop app.',
      );
      expect(tool('regenerate_asset').mutating).toBe(true);
      expect(tool('regenerate_asset').confirm).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('queues alone, and runs only when asked', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const hash = await plate(dir);
      const { pipeline, queued, ran } = fakePipeline();

      const only = await run('regenerate_asset', { hash: hash.slice(0, 10) }, { ...ctx, pipeline });
      expect(only.ok).toBe(true);
      expect(queued).toEqual([hash]);
      expect(ran()).toBe(0);
      expect(only.output).toContain('Nothing is drawn until the pipeline runs.');
      expect(only.written).toEqual(['vngen/state/tasks.jsonl']);

      const now = await run('regenerate_asset', { hash, run: true }, { ...ctx, pipeline });
      expect(ran()).toBe(1);
      expect(now.output).toContain('Ran 1 task(s).');
    } finally {
      await cleanup();
    }
  });
});

describe('skills', () => {
  const NEW_SKILL = {
    name: 'Pace a Scene',
    description: 'How long a beat should run before it is cut.',
    whenToUse: 'When a scene reads flat.',
    body: 'Count the beats, then cut one.',
  };

  it('create_skill writes a skill discover_skills then lists', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const res = await run('create_skill', NEW_SKILL, ctx);
      expect(res.ok).toBe(true);
      // Forward-slashed, like every workspace-relative path on the wire.
      expect(res.written).toEqual(['.aiagent/skills/pace-a-scene/SKILL.md']);

      const listed = await run('discover_skills', {}, ctx);
      expect(listed.output).toContain('pace-a-scene "Pace a Scene"');
      expect(listed.output).toContain('when: When a scene reads flat.');
      expect(listed.output).not.toContain('(!)');
    } finally {
      await cleanup();
    }
  });

  it('create_skill refuses a collision rather than overwriting', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      await run('create_skill', NEW_SKILL, ctx);
      const again = await run('create_skill', NEW_SKILL, ctx);
      expect(again.ok).toBe(false);
      expect(again.output).toBe('skill pace-a-scene already exists');
    } finally {
      await cleanup();
    }
  });

  it('create_skill refuses a name that slugs to nothing', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const res = await run('create_skill', { ...NEW_SKILL, name: '!!!' }, ctx);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('does not name a skill');
    } finally {
      await cleanup();
    }
  });

  it('has no script argument to pass — the schema refuses one before run() is entered', () => {
    expect(tool('create_skill').args.safeParse({ ...NEW_SKILL, script: 'run.mjs' }).success).toBe(
      false,
    );
    expect(tool('edit_skill').args.safeParse({ id: 'x', script: 'run.mjs' }).success).toBe(false);
  });

  it('edit_skill changes one field, reports it in written, and keeps a human script:', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await run('create_skill', NEW_SKILL, ctx);
      // A person adds a script by hand, the way the prose-only rule intends.
      const skillDir = join(dir, '.aiagent', 'skills', 'pace-a-scene');
      const md = await fs.readFile(join(skillDir, 'SKILL.md'), 'utf8');
      await fs.writeFile(
        join(skillDir, 'SKILL.md'),
        md.replace('---\n\n', 'script: run.mjs\n---\n\n'),
      );
      await fs.writeFile(join(skillDir, 'run.mjs'), 'console.log("vetted");');

      const res = await run('edit_skill', { id: 'pace-a-scene', description: 'Tighter.' }, ctx);
      expect(res.ok).toBe(true);
      expect(res.written).toEqual(['.aiagent/skills/pace-a-scene/SKILL.md']);

      const listed = await run('discover_skills', {}, ctx);
      expect(listed.output).toContain('Tighter.');
      // The name it was not asked to change survived, and so did the script.
      expect(listed.output).toContain('"Pace a Scene"');
      expect(listed.output).toContain('[script;');
    } finally {
      await cleanup();
    }
  });

  it('edit_skill refuses an unknown id', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const res = await run('edit_skill', { id: 'nope', body: 'x' }, ctx);
      expect(res.ok).toBe(false);
      expect(res.output).toBe('no such skill: nope');
    } finally {
      await cleanup();
    }
  });

  it('edit_skill refuses a skill that came from ctx.skillDirs', async () => {
    const { ctx, cleanup } = await tempProject();
    const outside = await fs.mkdtemp(join(tmpdir(), 'vn-skilldir-'));
    try {
      await fs.mkdir(join(outside, 'shared'), { recursive: true });
      await fs.writeFile(
        join(outside, 'shared', 'SKILL.md'),
        '---\nname: Shared\ndescription: Not this project.\n---\n\nDo it.\n',
      );
      const res = await run(
        'edit_skill',
        { id: 'shared', description: 'Mine now.' },
        { ...ctx, skillDirs: [outside] },
      );
      expect(res.ok).toBe(false);
      expect(res.output).toContain('outside this project');
      // Refusing also copied no skill into the project.
      expect(await run('discover_skills', {}, ctx)).toMatchObject({ data: [] });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('write_file cannot author anything under .aiagent/skills', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      for (const path of ['.aiagent/skills/x/run.mjs', '.aiagent/skills/x/SKILL.md']) {
        const res = await run('write_file', { path, content: 'whatever' }, ctx);
        expect(res.ok).toBe(false);
        expect(res.output).toContain('create_skill');
        expect(await exists(join(dir, path))).toBe(false);
      }
      // Everything else under .aiagent is still ordinary.
      expect((await run('write_file', { path: '.aiagent/notes.md', content: 'ok' }, ctx)).ok).toBe(
        true,
      );
    } finally {
      await cleanup();
    }
  });

  it('edit_file cannot rewrite a script a person put beside a skill', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      // The gate exists for this case: the script is already there, vetted, and `run_skill` offers
      // to execute it. An edit is the other way to author one.
      const skillDir = join(dir, '.aiagent', 'skills', 'x');
      await fs.mkdir(skillDir, { recursive: true });
      const script = join(skillDir, 'run.mjs');
      const before = 'process.stdout.write(1);';
      await fs.writeFile(script, before);

      const res = await run(
        'edit_file',
        { path: '.aiagent/skills/x/run.mjs', edits: [{ old: 'write(1)', new: 'write(2)' }] },
        ctx,
      );
      expect(res.ok).toBe(false);
      expect(res.output).toContain('create_skill');
      expect(await fs.readFile(script, 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('discover_skills flags what a skill degraded over instead of printing it as fine', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const skillDir = join(dir, '.aiagent', 'skills', 'mute');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(join(skillDir, 'SKILL.md'), '---\nname: Mute\n---\n\nDo the thing.\n');

      const listed = await run('discover_skills', {}, ctx);
      expect(listed.output).toContain('(!)');
      expect(listed.output).toContain('no description');
      expect(listed.data).toMatchObject([{ id: 'mute', issues: [expect.any(String)] }]);
    } finally {
      await cleanup();
    }
  });

  it('both writers are mutating, and neither borrows run_skill confirm card', () => {
    for (const name of ['create_skill', 'edit_skill']) {
      expect(tool(name).mutating).toBe(true);
      expect(tool(name).confirm).toBeUndefined();
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

  it('names the fields inside a nested shape rather than flattening it to object', () => {
    const sig = describeToolParams(tool('write_storyboard').args);
    // `shots[].subjects[]` is the deepest nesting in the registry, and the one the model spent
    // four refused calls guessing at.
    expect(sig).toContain('characterId: string');
    expect(sig).toContain('pose?: string');
    expect(sig).toContain('expression?: string');
    expect(sig).not.toContain('shots: object[]');
    // A record used to render as `any`, which named neither its keys nor its values.
    expect(describeToolParams(tool('edit_character').args)).toContain('record<string, ');
  });

  it('converts tool args to JSON Schema without letting the vendor refuse an unknown key', () => {
    const schema = jsonSchemaOf(tool('write_storyboard').args)!;
    const shots = (schema.properties as Record<string, Record<string, unknown>>).shots!;
    const shot = shots.items as Record<string, unknown>;
    expect(shot.type).toBe('object');
    expect(shot.required).toContain('location');
    const subject = (
      (shot.properties as Record<string, Record<string, unknown>>).subjects!.items as Record<
        string,
        unknown
      >
    ).properties as Record<string, unknown>;
    expect(Object.keys(subject)).toEqual(['characterId', 'pose', 'expression']);
    // `additionalProperties: false` would make a stray key a request error rather than an
    // observation the model can read and correct.
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":false');
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
          path: 'wiki/district.md',
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
          path: 'wiki/district.md',
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
          name: 'Ren Takada',
          description: 'Tall, black hair cut short, a burn scar along the left forearm.',
          status: 'draft',
          defaultOutfit: 'everyday',
          outfits: { everyday: 'grey coat over a work shirt' },
          traits: ['guarded', 'quick'],
          palette: ['#1a2a44', '#a02828'],
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.output).toContain('from the description you gave');
      expect(r.output).toContain('status, defaultOutfit, outfits, traits, palette set');

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

/**
 * The storyboard tools sit at the seam between the agent and `@vn/scriptedit`'s shot rules plus
 * `@vn/artgen`'s realization gauntlet, both tested where they live. These cases cover which file
 * each act writes (and that refusals write nothing), that the `nextShot` mark round-trips so a
 * deleted id stays retired, and that a proposal is read back rather than persisted.
 */
describe('storyboard tools', () => {
  /** A text seam that answers with fixed JSON — or refuses to parse, like the mock echo does. */
  const fakeText = (answer: string): TextLLM => ({
    complete: () => Promise.resolve(answer),
    structured: async (_prompt, parse) => parse(answer),
  });

  it('read_shots on an undecomposed scene names both doors and writes nothing', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('read_shots', { scene: 'ending' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('propose_storyboard');
      expect(r.output).toContain('newShot');
      expect(await exists(join(dir, 'vngen', 'work', 'shots', 'ending.json'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('newShot creates the storyboard, and the mark keeps a deleted id retired', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const first = await run(
        'edit_scene',
        { op: 'newShot', scene: 'ending', lineIds: ['ending:L1'], framing: 'close' },
        ctx,
      );
      expect(first.ok).toBe(true);
      expect(first.written).toEqual(['vngen/work/shots/ending.json']);
      expect(first.output).toContain('ends decomposition');

      const second = await run(
        'edit_scene',
        { op: 'newShot', scene: 'ending', lineIds: ['ending:L2'] },
        ctx,
      );
      expect(second.ok).toBe(true);

      const paths = new ProjectPaths(dir);
      let board = await readShots(paths, 'ending');
      expect(board?.shots.map((s) => s.id)).toEqual(['ending__shot1', 'ending__shot2']);
      // The speaker of the claimed line is the default cast; L1 has none.
      expect(board?.shots[0]!.subjects).toEqual([]);
      expect(board?.shots[0]!.framing).toBe('close');
      expect(board?.shots[1]!.subjects).toEqual([{ characterId: 'aiko' }]);

      const del = await run(
        'edit_scene',
        { op: 'deleteShot', scene: 'ending', shot: 'ending__shot2' },
        ctx,
      );
      expect(del.ok).toBe(true);
      expect(del.output).toContain('become uncovered');

      // The freed lines come back as a new frame, and shot2 stays retired.
      const again = await run(
        'edit_scene',
        { op: 'newShot', scene: 'ending', lineIds: ['ending:L2'] },
        ctx,
      );
      expect(again.ok).toBe(true);
      board = await readShots(paths, 'ending');
      expect(board?.shots.map((s) => s.id)).toEqual(['ending__shot1', 'ending__shot3']);
    } finally {
      await cleanup();
    }
  });

  it('deleting the last shot deletes the file, so the scene is decomposed again', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await run('edit_scene', { op: 'newShot', scene: 'ending', lineIds: ['ending:L1'] }, ctx);
      const r = await run(
        'edit_scene',
        { op: 'deleteShot', scene: 'ending', shot: 'ending__shot1' },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.output).toContain('decomposed again');
      expect(await exists(join(dir, 'vngen', 'work', 'shots', 'ending.json'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('set_coverage restates the whole set, and a released line is reported as a gap', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await run(
        'edit_scene',
        { op: 'newShot', scene: 'ending', lineIds: ['ending:L1', 'ending:L2'] },
        ctx,
      );
      const r = await run(
        'set_coverage',
        { scene: 'ending', shot: 'ending__shot1', lines: ['ending:L2', 'ending:L3'] },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['vngen/work/shots/ending.json']);
      expect(r.output).toContain('uncovered');
      const board = await readShots(new ProjectPaths(dir), 'ending');
      expect(board?.shots[0]!.coversLines).toEqual(['ending:L2', 'ending:L3']);
    } finally {
      await cleanup();
    }
  });

  it('propose_storyboard refuses without a text seam', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('propose_storyboard', { scene: 'ending' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('no text model');
    } finally {
      await cleanup();
    }
  });

  it('propose_storyboard reads a proposal into the conversation and writes nothing', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      ctx.text = fakeText(
        JSON.stringify({
          shots: [
            {
              id: 'opener',
              framing: 'wide',
              location: 'day',
              subjects: [{ characterId: 'aiko' }],
              coversLines: ['ending:L1', 'ending:L2', 'ending:L3'],
            },
          ],
        }),
      );
      const r = await run('propose_storyboard', { scene: 'ending' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('Proposed by the model.');
      expect(r.output).toContain('ending__opener');
      expect(r.output).toContain('Nothing is written.');
      expect(await exists(join(dir, 'vngen', 'work', 'shots', 'ending.json'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  /**
   * The human listing prints framing, variant and cast but never `pose`, `expression` or
   * `camera`, so "restate these shots" was not literally possible from what the model could read.
   */
  it('propose_storyboard prints shots write_storyboard takes verbatim', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      ctx.text = fakeText(
        JSON.stringify({
          shots: [
            {
              id: 'opener',
              framing: 'wide',
              location: 'day',
              camera: 'slow push in',
              subjects: [{ characterId: 'aiko', pose: 'seated', expression: 'wary' }],
              coversLines: ['ending:L1', 'ending:L2', 'ending:L3'],
            },
          ],
        }),
      );
      const proposal = await run('propose_storyboard', { scene: 'ending' }, ctx);
      const marker = 'it takes:\n';
      const shots = JSON.parse(
        proposal.output.slice(proposal.output.indexOf(marker) + marker.length),
      ) as unknown[];
      expect(shots).toEqual([
        {
          id: 'ending__opener',
          framing: 'wide',
          location: 'day',
          camera: 'slow push in',
          subjects: [{ characterId: 'aiko', pose: 'seated', expression: 'wary' }],
          coversLines: ['ending:L1', 'ending:L2', 'ending:L3'],
        },
      ]);

      const w = await run('write_storyboard', { scene: 'ending', shots }, ctx);
      expect(w.ok).toBe(true);
      const board = await readShots(new ProjectPaths(dir), 'ending');
      expect(board?.shots[0]).toMatchObject({ camera: 'slow push in', location: 'day' });
    } finally {
      await cleanup();
    }
  });

  it('propose_storyboard reports the baseline with its reason when no model answer parses', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      ctx.text = fakeText('not json'); // the mock echo's behaviour: nothing a schema accepts
      const r = await run('propose_storyboard', { scene: 'ending' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('deterministic baseline');
    } finally {
      await cleanup();
    }
  });

  it('write_storyboard runs the batch gauntlet: namespaced ids, inventions dropped', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'write_storyboard',
        {
          scene: 'ending',
          shots: [
            {
              id: 'opener',
              framing: 'wide',
              location: 'nowhere', // not a classroom variant — coerced to the first one
              subjects: [{ characterId: 'AIKO' }, { characterId: 'ghost' }],
              coversLines: ['ending:L1', 'ending:L99'],
            },
          ],
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['vngen/work/shots/ending.json']);
      expect(r.output).toContain('ends decomposition');
      // The coercion is silent on disk, so the write has to say which frames it moved
      expect(r.output).toContain('ending__opener: "nowhere" → "day"');
      expect(r.output).toContain('set_variant');
      const board = await readShots(new ProjectPaths(dir), 'ending');
      const shot = board?.shots[0];
      expect(shot?.id).toBe('ending__opener');
      expect(shot?.location).toBe('day');
      expect(shot?.subjects).toEqual([{ characterId: 'aiko' }]); // case fixed, invention dropped
      expect(shot?.coversLines).toEqual(['ending:L1']);
    } finally {
      await cleanup();
    }
  });

  it('write_storyboard rejects a shot key it does not take, rather than dropping it', () => {
    const shape = tool('write_storyboard').args;
    const shot = {
      id: 'opener',
      framing: 'wide',
      location: 'day',
      subjects: [],
      coversLines: ['ending:L1'],
    };
    expect(shape.safeParse({ scene: 'ending', shots: [shot] }).success).toBe(true);
    const stray = shape.safeParse({
      scene: 'ending',
      shots: [{ ...shot, variant: 'night' }],
    });
    expect(stray.success).toBe(false);
    if (stray.success) throw new Error('expected a rejection');
    expect(JSON.stringify(stray.error.issues)).toContain('variant');
  });

  it('write_storyboard refuses where a storyboard exists, and propose_storyboard does too', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await run('edit_scene', { op: 'newShot', scene: 'ending', lineIds: ['ending:L1'] }, ctx);
      const shots = [
        {
          id: 'opener',
          framing: 'wide',
          location: 'day',
          subjects: [],
          coversLines: ['ending:L1'],
        },
      ];
      const w = await run('write_storyboard', { scene: 'ending', shots }, ctx);
      expect(w.ok).toBe(false);
      expect(w.output).toContain('wins forever');

      ctx.text = fakeText('{"shots":[]}');
      const p = await run('propose_storyboard', { scene: 'ending' }, ctx);
      expect(p.ok).toBe(false);
      expect(p.output).toContain('wins forever');

      const board = await readShots(new ProjectPaths(dir), 'ending');
      expect(board?.shots.map((s) => s.id)).toEqual(['ending__shot1']);
    } finally {
      await cleanup();
    }
  });

  it('write_storyboard refuses a list that binds nothing, rather than writing the baseline', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run(
        'write_storyboard',
        {
          scene: 'ending',
          shots: [
            {
              id: 'opener',
              framing: 'wide',
              location: 'day',
              subjects: [],
              coversLines: ['ending:L99'], // no real line — realization would baseline
            },
          ],
        },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('refused:');
      expect(r.output).toContain('nothing was written');
      expect(await exists(join(dir, 'vngen', 'work', 'shots', 'ending.json'))).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
