/**
 * The half of project validation that reads graph documents and group definitions, and
 * `validateProject`, which runs it beside `@vn/artgen`'s `validateAssets`. Both halves only read:
 * neither repairs a manifest, rewrites a graph or touches a journal.
 */
import { unparsedFinding, validateAssets, type ProjectFinding } from '@vn/artgen';
import { AssetStore, ProjectPaths, workspacePath } from '@vn/store';
import type { ProjectModel } from '@vn/types';
import { readText } from '@vn/util';
import type { Graph, Node } from 'pathux-graph';

import { graphSlugs, groupRefs } from './document.js';
import { readGraphFile, readGroupFile } from './graphfile.js';
import { GenImageFile, GenSheetRefs, GenTaskRefs, registerGenNodes } from './nodes/index.js';
import { graphDocFile, graphGroupFile } from './paths.js';

/** Lists the hashes one node names: an image file's own, or a refs node's seeded list. */
function hashesOf(node: Node): string[] | 'unparsed' {
  if (node instanceof GenImageFile) {
    const hash = String(node.props['hash']?.getValue() ?? '').trim();
    return hash.length === 0 ? [] : [hash];
  }
  if (!(node instanceof GenTaskRefs) && !(node instanceof GenSheetRefs)) return [];
  const raw = String(node.inputs.assets?.defaultProp?.getValue() ?? '').trim();
  if (raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return 'unparsed';
    return parsed
      .map((entry) => (entry as { hash?: unknown }).hash)
      .filter((hash): hash is string => typeof hash === 'string');
  } catch {
    return 'unparsed';
  }
}

/**
 * Checks one graph's own nodes. A group instance is not opened: its definition is checked once,
 * as its own file, so a missing hash inside it is reported once rather than once per instance.
 */
function checkGraph(
  graph: Graph,
  where: string,
  owner: string,
  has: (hash: string) => boolean,
): ProjectFinding[] {
  const findings: ProjectFinding[] = [];
  for (const node of graph.nodes) {
    const referrer = `${owner}, node ${node.id}`;
    const hashes = hashesOf(node);
    if (hashes === 'unparsed') {
      findings.push(unparsedFinding(where, referrer, `The seeded refs on ${referrer}`));
      continue;
    }
    for (const hash of hashes) {
      if (has(hash)) continue;
      findings.push({
        severity: 'blocking',
        kind    : 'missing-row',
        hash,
        where,
        referrer,
        message: `${referrer} names the picture ${hash.slice(0, 8)}, which no manifest lists.`,
      });
    }
  }
  return findings;
}

/**
 * Reads one file's JSON, or answers undefined when it does not parse. A file that vanished since
 * the listing reads as undefined too, and is then reported as unparsed.
 */
async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readText(file));
  } catch {
    return undefined;
  }
}

/**
 * Checks every graph document and group definition for hashes `has` does not know. Each file is
 * read as it is on disk, without resolving its group instances against the library.
 */
export async function validateGraphs(
  root: string,
  has: (hash: string) => boolean,
): Promise<ProjectFinding[]> {
  registerGenNodes();
  const paths = new ProjectPaths(root);
  const findings: ProjectFinding[] = [];

  for (const slug of await graphSlugs(root)) {
    const file = graphDocFile(paths, slug);
    const where = workspacePath(root, file);
    const json = await readJson(file);
    const graph = json === undefined ? undefined : readGraphFile(json).graph;
    findings.push(
      ...(graph
        ? checkGraph(graph, where, `graph ${slug}`, has)
        : [unparsedFinding(where, `graph ${slug}`)]),
    );
  }
  for (const ref of await groupRefs(root)) {
    const file = graphGroupFile(paths, ref);
    const where = workspacePath(root, file);
    const json = await readJson(file);
    const def = json === undefined ? undefined : readGroupFile(json).def;
    findings.push(
      ...(def
        ? checkGraph(def.subgraph, where, `group ${ref}`, has)
        : [unparsedFinding(where, `group ${ref}`)]),
    );
  }
  return findings;
}

/**
 * Checks every reference in the project and answers the findings, blocking ones first. Opens
 * everything from disk and writes nothing, so it can run in plan mode and beside a running
 * pipeline.
 */
export async function validateProject(opts: {
  root: string;
  model: ProjectModel;
}): Promise<ProjectFinding[]> {
  const paths = new ProjectPaths(opts.root);
  const store = await AssetStore.open(paths);
  const findings = [
    ...(await validateAssets(paths, opts.model)),
    ...(await validateGraphs(opts.root, (hash) => store.has(hash))),
  ];
  const rank = (f: ProjectFinding): number => (f.severity === 'blocking' ? 0 : 1);
  return findings.sort((a, b) => rank(a) - rank(b));
}
