import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { ProjectPaths, readShots, writeShots } from '@vn/store';
import type { Shot } from '@vn/types';
import {
  createRegistry,
  describeToolParams,
  Workspace,
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
reference_images: []
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
  ending: '---\nscene: ending\n---\n\nINT. CLASSROOM - EVENING\n\nThe end.\n',
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
