// ── Generation graphs ───────────────────────────────────────────────────────
import { z } from 'zod';
import { decideGenEdit, graphToDSL, validateGenGraph } from '@vn/gengraph';
import type { GenDiagnostic, GenPropValue } from '@vn/gengraph';
import {
  bindGroupLibrary,
  graphSlugs,
  readGraphDoc,
  readGroupLibrary,
  writeGraphDoc,
} from '@vn/gengraph/state';
import { ok, fail, type Tool } from './core.js';

/** One diagnostic as a bullet the model can act on, naming the node it is about. */
const diagLine = (d: GenDiagnostic): string =>
  `  • node ${String(d.nodeId)} [${d.code}]: ${d.message}`;

const readAssetGraphTool: Tool<{ slug?: string }> = {
  name       : 'read_asset_graph',
  description:
    'Read one generation graph — the node network a picture is drawn by — as the same description `edit_asset_graph` takes back: every node with its type and the values written on it, and every link between them. A node of type `GroupNode` is an instance of a group definition, named by its `group` field; what is inside the group is not described here. Where the nodes sit on the canvas is left out on purpose, so writing a graph back never moves what the author arranged there. Anything wrong with the graph is listed after it: a node type no plugin provides, a link whose two ends disagree, a slot string that does not parse. Called with no name it lists the graphs this project holds, which is how you find one to read.',
  mutating   : false,
  args: z.object({
    slug: z.string().optional().describe('which graph, by the name its file carries'),
  }),
  async run(a, ctx) {
    const root = ctx.workspace.root;
    if (a.slug === undefined) {
      const slugs = await graphSlugs(root);
      if (slugs.length === 0) {
        return ok('This project holds no generation graphs.', { data: { slugs } });
      }
      return ok(`${slugs.length} graph(s): ${slugs.join(', ')}`, { data: { slugs } });
    }

    const read = await readGraphDoc(root, a.slug);
    if (!read.ok) return fail(read.reason);

    const dsl = graphToDSL(read.graph);
    const problems = read.diagnostics.map(diagLine);
    const tail = problems.length === 0 ? '' : `\n\nProblems with it:\n${problems.join('\n')}`;
    return ok(`${read.path}:\n${JSON.stringify(dsl, null, 2)}${tail}`, {
      data: { dsl, diagnostics: read.diagnostics },
    });
  },
};

const editAssetGraphTool: Tool<{
  slug: string;
  nodes: {
    id: string | number;
    type: string;
    props?: Record<string, GenPropValue>;
    group?: string;
  }[];
  links: (string | number)[][];
}> = {
  name       : 'edit_asset_graph',
  description:
    'Rewrite one generation graph from a whole description — the form `read_asset_graph` gives back. Read it first: what you pass is the graph in full, so a node you leave out is removed. A node kept under the id it already had keeps its position on the canvas and keeps the record of what it has already run, so re-describing a graph does not by itself spend anything. A `GroupNode` entry is an instance of a group definition the project already holds, named by `group`; keep one under its id and it keeps the values set on it, and name a definition to add an instance of it. What is inside a group is edited in the desktop app rather than here. A description that will not build is refused with every problem in it listed, and the file on disk is left exactly as it was. It writes the document and draws nothing; `run_asset_graph` is what spends.',
  mutating   : true,
  args: z.object({
    slug : z.string().describe('which graph, by the name its file carries'),
    nodes: z
      .array(
        z.object({
          id: z
            .union([z.string(), z.number()])
            .describe('the id it keeps; reuse the one read_asset_graph gave to keep its record'),
          type : z.string().describe('the node type, such as `GenImage`'),
          props: z
            .record(z.union([z.string(), z.number(), z.boolean()]))
            .optional()
            .describe('the authored values on it, by the names its type declares'),
          group: z
            .string()
            .optional()
            .describe('on a `GroupNode` only: the group definition this node is an instance of'),
        }),
      )
      .describe('every node the graph should hold once this is applied'),
    links: z
      .array(z.array(z.union([z.string(), z.number()])))
      .describe('every link, each written as [fromNode, fromSocket, toNode, toSocket]'),
  }),
  async run(a, ctx) {
    const root = ctx.workspace.root;
    const read = await readGraphDoc(root, a.slug);
    if (!read.ok) return fail(read.reason);

    // The whole library, so the description can instance a definition this graph did not hold.
    const groups = await readGroupLibrary(root);

    const description = { nodes: a.nodes, links: a.links };
    const decided = decideGenEdit(read.graph, { op: 'apply', description, groups });
    if (!decided.ok) {
      const listed: string[] = decided.details ?? [];
      const bullets = listed.map((d) => `  • ${d}`).join('\n');
      return fail(
        `Nothing was written and the ${a.slug} graph is unchanged: ${decided.reason}` +
          (bullets === '' ? '' : `\n${bullets}`),
      );
    }

    const applied = decided.apply();
    // Resolved before the write, so the file never holds an instance waiting on its definition.
    bindGroupLibrary(root, applied.graph);
    await applied.graph.resolveGroups();
    const path = await writeGraphDoc(root, a.slug, applied.graph);
    // Reported rather than refused, the way an opened graph reports the same problems: a graph
    // is authored a piece at a time, and a half-built one is a normal thing to save.
    const left = validateGenGraph(applied.graph);
    const tail =
      left.length === 0 ? '' : `\n\nStill wrong with it:\n${left.map(diagLine).join('\n')}`;
    return ok(`${decided.note}${tail}`, { written: [path], data: { diagnostics: left } });
  },
};

const runAssetGraphTool: Tool<{ slug: string; force?: boolean }> = {
  name       : 'run_asset_graph',
  description:
    'Run one generation graph now, up to the output node it is set to terminate on. It spends real image generations, so the author is quoted what the run is expected to cost and confirms it before anything happens. Every node whose inputs still match what it last ran resumes from that record instead of running again, which is why re-running an unchanged graph costs nothing; `force` runs the paid nodes over regardless. Nothing enters the asset store here — a graph fills a slot only where a planned task names it.',
  mutating   : true,
  args: z.object({
    slug : z.string().describe('which graph, by the name its file carries'),
    force: z
      .boolean()
      .optional()
      .describe('run the paid nodes again rather than resuming what they already produced'),
  }),
  async run(a, ctx) {
    if (!ctx.graphs) {
      return fail(
        'running a graph draws pictures through the executor, which vnauthor does not do — open the project in the desktop app.',
      );
    }
    if (!ctx.confirm) {
      return fail('nobody is here to confirm the spend, so no graph may be run.');
    }

    const priced = await ctx.graphs.estimate(a.slug);
    if (!priced.ok) return fail(priced.reason);

    const force = a.force === true;
    const resumed = force
      ? 'It runs every paid node again.'
      : 'It resumes what the journal already holds.';
    if (!(await ctx.confirm(`Run the ${a.slug} graph? ${priced.note} ${resumed}`))) {
      return ok('Nothing run — you said no.');
    }

    const ran = await ctx.graphs.run(a.slug, { force });
    return ran.ok ? ok(ran.message, { written: ran.written }) : fail(ran.message);
  },
};

export { readAssetGraphTool, editAssetGraphTool, runAssetGraphTool };
