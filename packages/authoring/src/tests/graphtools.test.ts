/**
 * The three generation-graph tools. Reading and editing go straight to the files, so what is
 * checked here is that a graph read back and written unchanged keeps its node ids, that a
 * description which will not build leaves the file exactly as it was and hands the model every
 * problem in it, and that running one refuses without a host and quotes its price with one.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { GenImage, GenOutput, GenTemplate, Graph, registerGenNodes } from '@vn/gengraph';
import { graphPath, writeGraphDoc } from '@vn/gengraph/state';

import {
  createRegistry,
  Workspace,
  type GraphControl,
  type Tool,
  type ToolContext,
} from '../index.js';

const registry = createRegistry();
function tool(name: string): Tool {
  const t = registry.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
const run = (name: string, args: unknown, ctx: ToolContext) =>
  tool(name).run(tool(name).args.parse(args), ctx);

/** A prompt feeding a picture feeding an output, which is the smallest graph that draws. */
function portrait(): Graph {
  registerGenNodes();
  const graph = new Graph();
  const text = new GenTemplate();
  const image = new GenImage();
  const out = new GenOutput();

  text.props.template?.setValue('a portrait of Aiko');
  out.props.slot?.setValue('portrait:aiko');
  graph.add(text);
  graph.add(image);
  graph.add(out);
  graph.connect(text.outputs.text, image.inputs.prompt);
  graph.connect(image.outputs.image, out.inputs.image);
  return graph;
}

async function tempProject(extra: Partial<ToolContext> = {}): Promise<{
  ctx: ToolContext;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-graphtools-'));
  await fs.writeFile(join(dir, 'project.yaml'), 'title: Test Project\n');
  await writeGraphDoc(dir, 'portrait', portrait());
  const ctx: ToolContext = { workspace: new Workspace(dir), git: openGit(dir), ...extra };
  return { ctx, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

describe('read_asset_graph', () => {
  it('names the graphs when asked for none', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const listed = await run('read_asset_graph', {}, ctx);
      expect(listed.ok).toBe(true);
      expect(listed.data).toEqual({ slugs: ['portrait'] });
    } finally {
      await cleanup();
    }
  });

  it('gives back topology and authored values, and no layout', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const read = await run('read_asset_graph', { slug: 'portrait' }, ctx);
      expect(read.ok).toBe(true);
      const { dsl } = read.data as { dsl: { nodes: { type: string }[]; links: unknown[] } };
      expect(dsl.nodes.map((n) => n.type)).toEqual(['GenTemplate', 'GenImage', 'GenOutput']);
      expect(dsl.links).toHaveLength(2);
      expect(read.output).not.toContain('"pos"');
      expect(read.output).toContain('a portrait of Aiko');
    } finally {
      await cleanup();
    }
  });

  it('refuses a graph this project does not hold', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const read = await run('read_asset_graph', { slug: 'missing' }, ctx);
      expect(read.ok).toBe(false);
      expect(read.output).toContain('there is no missing graph');
    } finally {
      await cleanup();
    }
  });
});

describe('edit_asset_graph', () => {
  it('writes back what it read, keeping every node under the id it had', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const read = await run('read_asset_graph', { slug: 'portrait' }, ctx);
      const { dsl } = read.data as { dsl: { nodes: unknown[]; links: unknown[] } };

      const edited = await run('edit_asset_graph', { slug: 'portrait', ...dsl }, ctx);
      expect(edited.ok).toBe(true);
      expect(edited.written).toEqual([graphPath(dir, 'portrait')]);

      const again = await run('read_asset_graph', { slug: 'portrait' }, ctx);
      expect((again.data as { dsl: unknown }).dsl).toEqual(dsl);
    } finally {
      await cleanup();
    }
  });

  it('adds a node and the link that feeds it', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const read = await run('read_asset_graph', { slug: 'portrait' }, ctx);
      const { dsl } = read.data as {
        dsl: {
          nodes: { id: string | number; type: string; props?: Record<string, unknown> }[];
          links: (string | number)[][];
        };
      };
      const image = dsl.nodes.find((n) => n.type === 'GenImage')!;
      const refs = { id: 'refs', type: 'GenRefList' };

      const edited = await run(
        'edit_asset_graph',
        {
          slug: 'portrait',
          nodes: [...dsl.nodes, refs],
          links: [...dsl.links, ['refs', 'refs', image.id, 'refs']],
        },
        ctx,
      );
      expect(edited.ok).toBe(true);

      const again = await run('read_asset_graph', { slug: 'portrait' }, ctx);
      const after = (again.data as { dsl: { nodes: { id: string | number }[] } }).dsl;
      expect(after.nodes.map((n) => n.id)).toContain('refs');
    } finally {
      await cleanup();
    }
  });

  it('hands back every problem in a description it will not build, and writes nothing', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const before = await fs.readFile(join(dir, graphPath(dir, 'portrait')), 'utf8');

      const edited = await run(
        'edit_asset_graph',
        {
          slug: 'portrait',
          nodes: [
            { id: 1, type: 'GenNoSuchThing' },
            { id: 2, type: 'GenAlsoMissing' },
          ],
          links: [],
        },
        ctx,
      );
      expect(edited.ok).toBe(false);
      expect(edited.output).toContain('GenNoSuchThing');
      // The second problem survives the refusal too, so one round trip fixes both.
      expect(edited.output).toContain('GenAlsoMissing');
      expect(edited.written).toBeUndefined();
      expect(await fs.readFile(join(dir, graphPath(dir, 'portrait')), 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('reports a slot that does not parse rather than refusing the whole edit', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const read = await run('read_asset_graph', { slug: 'portrait' }, ctx);
      const { dsl } = read.data as {
        dsl: {
          nodes: { id: string | number; type: string; props?: Record<string, unknown> }[];
          links: (string | number)[][];
        };
      };
      const nodes = dsl.nodes.map((n) =>
        n.type === 'GenOutput' ? { ...n, props: { ...n.props, slot: 'not a slot' } } : n,
      );

      const edited = await run(
        'edit_asset_graph',
        { slug: 'portrait', nodes, links: dsl.links },
        ctx,
      );
      expect(edited.ok).toBe(true);
      expect(edited.output).toContain('slot-unparsed');
      expect((edited.data as { diagnostics: unknown[] }).diagnostics).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

describe('run_asset_graph', () => {
  it('is mutating, so plan mode rejects it before it is reached', () => {
    expect(tool('run_asset_graph').mutating).toBe(true);
    // The estimate goes into the confirmation card, so the generic by-name prompt is not used.
    expect(tool('run_asset_graph').confirm).toBeUndefined();
  });

  it('refuses without a host and names the one that can', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const ran = await run('run_asset_graph', { slug: 'portrait' }, ctx);
      expect(ran.ok).toBe(false);
      expect(ran.output).toContain('desktop app');
    } finally {
      await cleanup();
    }
  });

  it('quotes the estimate in what it asks, and runs nothing when the answer is no', async () => {
    const calls: string[] = [];
    const graphs: GraphControl = {
      estimate: async () => ({ ok: true, note: 'About $0.12.' }),
      run: async () => {
        calls.push('ran');
        return { ok: true, message: 'Ran 3 nodes in portrait.', written: [] };
      },
    };
    const asked: string[] = [];
    const { ctx, cleanup } = await tempProject({
      graphs,
      confirm: async (message) => {
        asked.push(message);
        return false;
      },
    });
    try {
      const ran = await run('run_asset_graph', { slug: 'portrait' }, ctx);
      expect(asked[0]).toContain('About $0.12.');
      expect(asked[0]).toContain('resumes what the journal already holds');
      expect(calls).toEqual([]);
      expect(ran.output).toContain('you said no');
    } finally {
      await cleanup();
    }
  });

  it('runs once confirmed, and says so when the graph cannot be priced', async () => {
    const forced: boolean[] = [];
    const graphs: GraphControl = {
      estimate: async (slug) =>
        slug === 'portrait'
          ? { ok: true, note: 'About $0.12.' }
          : { ok: false, reason: `there is no ${slug} graph in this project` },
      run: async (_slug, opts) => {
        forced.push(opts.force);
        return { ok: true, message: 'Ran 3 nodes in portrait.', written: ['x.json'] };
      },
    };
    const { ctx, cleanup } = await tempProject({ graphs, confirm: async () => true });
    try {
      const ran = await run('run_asset_graph', { slug: 'portrait', force: true }, ctx);
      expect(ran.ok).toBe(true);
      expect(ran.written).toEqual(['x.json']);
      expect(forced).toEqual([true]);

      const missing = await run('run_asset_graph', { slug: 'nope' }, ctx);
      expect(missing.ok).toBe(false);
      expect(missing.output).toContain('there is no nope graph');
      expect(forced).toEqual([true]);
    } finally {
      await cleanup();
    }
  });
});

describe('the layer these tools sit in', () => {
  it('still imports neither the pipeline nor the scheduler', async () => {
    const src = join(__dirname, '..');
    const names = await fs.readdir(src, { recursive: true, withFileTypes: true });
    const files = names
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => join(e.parentPath, e.name));
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      if (/from '@vn\/(pipeline|scheduler)/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
