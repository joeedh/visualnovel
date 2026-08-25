/**
 * Reading and writing the graph documents at `vngen/work/graphs/`, and the group definitions
 * beside them. A graph is nstructjs JSON rather than prose, so it never travels through the
 * document surfaces: `doc.*` refuses the directory and every host comes through here instead.
 * The desktop app and the authoring agent both load graphs, so this sits in the package they
 * share rather than in either of them. Nothing here reads git, which is why the desktop app
 * wraps these with its own conflict check.
 */
import { readdir, rm } from 'node:fs/promises';

import { ProjectPaths, workspacePath } from '@vn/store';
import { ensureDir, exists, readText, writeFileAtomic } from '@vn/util';
import type { Graph, GraphId, GroupDef, GroupNode } from 'pathux-graph';

import { readGraphFile, readGroupFile, writeGraphFile, writeGroupFile } from './graphfile.js';
import { graphDocFile, graphGroupFile, graphLibDir, graphsDir } from './paths.js';
import { registerGenNodes } from './nodes/index.js';
import { validateGenGraph, type GenDiagnostic } from './validate.js';

/** A graph's file name without its extension, which is also how its journal is keyed. */
export type GraphSlug = string;

export type GraphRead =
  | { ok: true; graph: Graph; path: string; diagnostics: GenDiagnostic[] }
  | { ok: false; reason: string };

/** True for a name that can be a graph's file name, which is what makes it addressable. */
export function isGraphSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(slug);
}

/**
 * A node id as it was typed, read back as the number or the string the graph keys its nodes by.
 * An id naming no node is passed through, so whoever asked for it refuses it in their own words.
 */
export function nodeIdOf(graph: Graph, said: string): GraphId {
  const trimmed = said.trim();
  if (graph.nodeIdMap.has(trimmed)) return trimmed;
  const num = Number(trimmed);
  return Number.isInteger(num) ? num : trimmed;
}

/** The workspace-relative path a graph's document lives at. */
export function graphPath(root: string, slug: GraphSlug): string {
  return workspacePath(root, graphDocFile(new ProjectPaths(root), slug));
}

/** The slugs on disk, sorted, with `lib/` left out because a group is not a graph. */
export async function graphSlugs(root: string): Promise<GraphSlug[]> {
  try {
    return (await readdir(graphsDir(new ProjectPaths(root))))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * One graph, or a sentence saying why it cannot be had. Semantic diagnostics ride along with a
 * graph that loaded, because a node type a plugin has stopped providing is something to report
 * beside the open document rather than a reason to refuse to open it.
 */
export async function readGraphDoc(root: string, slug: GraphSlug): Promise<GraphRead> {
  if (!isGraphSlug(slug)) return { ok: false, reason: `'${slug}' is not a graph name` };
  // Deserializing names node types, so the built-ins have to be in the registry by now. Every
  // caller would otherwise have to remember this, and a forgotten call reads as a corrupt file.
  registerGenNodes();

  const path = graphPath(root, slug);
  const file = graphDocFile(new ProjectPaths(root), slug);
  if (!(await exists(file))) {
    return { ok: false, reason: `there is no ${slug} graph in this project` };
  }

  let json: unknown;
  try {
    json = JSON.parse(await readText(file));
  } catch (err) {
    return { ok: false, reason: `${path} is not JSON: ${(err as Error).message}` };
  }

  const read = readGraphFile(json);
  if (read.graph === undefined) {
    const said = read.diagnostics.map((d) => d.message).join('; ');
    return { ok: false, reason: `${path} cannot be read: ${said}` };
  }

  const graph = read.graph;
  bindGroupLibrary(root, graph);
  const groups = await graph.resolveGroups();

  return {
    ok: true,
    graph,
    path,
    diagnostics: [...groupDiagnostics(graph, groups.failed), ...validateGenGraph(graph)],
  };
}

/** Write one graph. Returns the workspace-relative path, which is what `written` reports. */
export async function writeGraphDoc(root: string, slug: GraphSlug, graph: Graph): Promise<string> {
  const paths = new ProjectPaths(root);
  await ensureDir(graphsDir(paths));
  await writeFileAtomic(
    graphDocFile(paths, slug),
    `${JSON.stringify(writeGraphFile(graph), null, 2)}\n`,
  );
  return graphPath(root, slug);
}

/** Delete one graph's document. Its journal and blobs are left alone, being a run's record. */
export async function deleteGraphDoc(root: string, slug: GraphSlug): Promise<string> {
  await rm(graphDocFile(new ProjectPaths(root), slug), { force: true });
  return graphPath(root, slug);
}

/**
 * Points a graph's group seams at `work/graphs/lib/`. The library is per project rather than
 * per graph, so a definition edited in one graph reaches every graph referencing it on their
 * next load.
 */
export function bindGroupLibrary(root: string, graph: Graph): void {
  graph.groupLoader = (ref) => readGroupDef(root, ref);
  graph.groupSaver = async (ref, def) => {
    await writeGroupDef(root, ref, def);
  };
}

/** One group definition, or undefined when no file answers to that name or the file is bad. */
export async function readGroupDef(root: string, ref: string): Promise<GroupDef | undefined> {
  if (!isGraphSlug(ref)) return undefined;
  registerGenNodes();

  const file = graphGroupFile(new ProjectPaths(root), ref);
  if (!(await exists(file))) return undefined;

  try {
    return readGroupFile(JSON.parse(await readText(file))).def;
  } catch {
    return undefined;
  }
}

/** Write one group definition. Returns the workspace-relative path, which `written` reports. */
export async function writeGroupDef(root: string, ref: string, def: GroupDef): Promise<string> {
  const paths = new ProjectPaths(root);
  const file = graphGroupFile(paths, ref);
  await ensureDir(graphLibDir(paths));
  await writeFileAtomic(file, `${JSON.stringify(writeGroupFile(def), null, 2)}\n`);
  return workspacePath(root, file);
}

/**
 * Turns each unresolved group into a diagnostic against the instance that references it. A
 * failed load keeps the instance's last subgraph, so the graph still opens and the author is
 * told which definition went missing rather than shown a node that quietly stopped updating.
 */
function groupDiagnostics(
  graph: Graph,
  failed: ReadonlyArray<{ ref: string; reason: string }>,
): GenDiagnostic[] {
  const out: GenDiagnostic[] = [];

  for (const { ref, reason } of failed) {
    for (const node of graph.nodes) {
      if ((node as GroupNode).ref !== ref) continue;
      out.push({
        code: 'unresolved-group',
        message: `group '${ref}' did not load: ${reason}`,
        nodeId: node.id,
      });
    }
  }

  return out;
}
