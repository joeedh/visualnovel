/**
 * The collector: `collectProject` decides what a project no longer uses, across the asset roots,
 * the task log and the generation graphs' state, and `applyCollection` removes it. The asset half
 * of the decision is `@vn/artgen`'s `planAssetCollection`; this module adds what the graph
 * documents name and what their journals and blob folders hold.
 *
 * Neither function knows where removed files go. The host passes a mover, which deletes them or
 * keeps them somewhere undo can reach.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { planAssetCollection, type AssetCollection, type AssetRootName } from '@vn/artgen';
import type { ProjectConfig } from '@vn/config';
import {
  AssetRoot,
  claimedByOthers,
  ProjectPaths,
  readClaims,
  removeClaim,
  workspacePath,
} from '@vn/store';
import { logTombstone } from '@vn/taskgraph';
import type { AnyTask, Asset, Diagnostic, ProjectModel } from '@vn/types';
import { exists, readText } from '@vn/util';

import { graphSlugs, groupRefs } from './document.js';
import { replayJournal } from './journal.js';
import { listGraphBlobs } from './blobs.js';
import {
  graphBlobDir,
  graphBlobFile,
  graphDocFile,
  graphGroupFile,
  graphJournalFile,
  graphStateDir,
} from './paths.js';

/** A content hash as the stores and blob folders spell one. */
const HASH = /\b[0-9a-f]{64}\b/g;

/** What a collection removes from the generation graphs' state. Paths are workspace-relative. */
export interface GraphStateCollection {
  /** The journal and blob folder of each graph whose document file is gone. */
  orphans: { slug: string; paths: string[]; bytes: number }[];
  /** Blobs of the graphs that remain that no journal record names. */
  blobs: { slug: string; file: string; bytes: number }[];
}

export interface CollectionPlan {
  assets: AssetCollection;
  graphs: GraphStateCollection;
  /** This project's `project_id`, which names its claims; absent until it first claims one. */
  projectId?: string;
}

/** Sums the bytes under a path, a folder's contents included; zero for one that is not there. */
async function bytesUnder(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const name of await readdir(path)) total += await bytesUnder(join(path, name));
    return total;
  } catch {
    return 0;
  }
}

/** Lists every content hash a text names. */
function hashesIn(text: string): string[] {
  return text.match(HASH) ?? [];
}

/**
 * Collects the hashes every graph document and group definition names. Each file is read as raw
 * text, so a file that does not parse still keeps what it names.
 */
async function graphNames(root: string): Promise<Set<string>> {
  const paths = new ProjectPaths(root);
  const out = new Set<string>();
  const files = [
    ...(await graphSlugs(root)).map((slug) => graphDocFile(paths, slug)),
    ...(await groupRefs(root)).map((ref) => graphGroupFile(paths, ref)),
  ];
  for (const file of files) {
    const text = await readText(file).catch(() => '');
    for (const hash of hashesIn(text)) out.add(hash);
  }
  return out;
}

/**
 * Lists the slugs that have state: a journal, a blob folder, or both. Every directory in the state
 * folder is a blob folder; groups keep no state, so none belongs to the group library.
 */
async function slugsWithState(paths: ProjectPaths): Promise<Set<string>> {
  const slugs = new Set<string>();
  const entries = await readdir(graphStateDir(paths), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) slugs.add(entry.name);
    else if (entry.name.endsWith('.jsonl')) slugs.add(entry.name.slice(0, -'.jsonl'.length));
  }
  return slugs;
}

/**
 * Decides what the graphs' state no longer needs. A graph whose document file is gone loses its
 * journal and blob folder; a document that exists but does not parse keeps both. In a graph that
 * remains, a blob goes when no journal record names it, or, with `oldAnswers`, when only answers
 * since superseded name it.
 */
export async function planGraphCollection(
  root: string,
  opts: { oldAnswers?: boolean; named?: ReadonlySet<string> } = {},
): Promise<GraphStateCollection> {
  const paths = new ProjectPaths(root);
  const rel = (abs: string): string => workspacePath(root, abs);
  const docs = new Set(await graphSlugs(root));
  const named = opts.named ?? new Set<string>();
  const out: GraphStateCollection = { orphans: [], blobs: [] };

  for (const slug of [...(await slugsWithState(paths))].sort()) {
    const journal = graphJournalFile(paths, slug);
    const blobDir = graphBlobDir(paths, slug);
    if (!docs.has(slug)) {
      const present: string[] = [];
      let bytes = 0;
      for (const path of [journal, blobDir]) {
        if (!(await exists(path))) continue;
        present.push(rel(path));
        bytes += await bytesUnder(path);
      }
      out.orphans.push({ slug, paths: present, bytes });
      continue;
    }

    let text: string;
    try {
      text = await readText(journal);
    } catch {
      text = '';
    }
    const keep = new Set<string>(named);
    if (opts.oldAnswers) {
      const replayed = replayJournal(text);
      const answers = [
        ...replayed.latest.values(),
        ...replayed.lastDone.values(),
        ...[...replayed.cached.values()].flatMap((byKey) => [...byKey.values()]),
      ];
      for (const record of answers) {
        for (const hash of hashesIn(JSON.stringify(record.output ?? null))) keep.add(hash);
      }
    } else {
      for (const hash of hashesIn(text)) keep.add(hash);
    }
    for (const blob of await listGraphBlobs(paths, slug)) {
      if (keep.has(blob.hash)) continue;
      const file = graphBlobFile(paths, slug, blob);
      out.blobs.push({ slug, file: rel(file), bytes: await bytesUnder(file) });
    }
  }
  return out;
}

/**
 * Answers why a collection may not run over inputs that did not all load, or nothing when they
 * did. A sheet that would not parse leaves its character or location out of the model, and the
 * collector would then remove that entity's art as unused. A wiki page that will not parse counts
 * too, because it may be a sheet.
 */
export function unreadInputs(diagnostics: readonly Diagnostic[]): string | undefined {
  const unread = diagnostics.filter((d) => d.severity === 'error' || d.code === 'entity_file');
  if (unread.length === 0) return undefined;
  const problems =
    unread.length === 1 ? '1 input problem means' : `${unread.length} input problems mean`;
  return (
    `Nothing was collected: ${problems} what the project uses cannot be known. Fix ` +
    `${unread.length === 1 ? 'it' : 'them'} first: ${unread[0]!.message}`
  );
}

/**
 * Decides everything a collection removes, writing nothing: the asset rows, files and task
 * records nothing uses, and the graph state no document needs. `live` adds hashes another
 * source names. A picture another project claims is kept, and this project's own claim on one
 * nothing of its own uses is dropped.
 */
export async function collectProject(opts: {
  root: string;
  model: ProjectModel;
  config: ProjectConfig;
  oldAnswers?: boolean;
  live?: Iterable<string>;
}): Promise<CollectionPlan> {
  const paths = new ProjectPaths(opts.root);
  const named = await graphNames(opts.root);
  for (const hash of opts.live ?? []) named.add(hash);
  const claims = await readClaims(paths);
  const projectId = opts.config.project_id;
  const assets = await planAssetCollection({
    paths,
    model    : opts.model,
    config   : opts.config,
    live     : named,
    claimed  : claimedByOthers(claims, projectId),
    ownClaims: [...claims]
      .filter(([, ids]) => projectId !== undefined && ids.has(projectId))
      .map(([hash]) => hash),
  });
  const graphs = await planGraphCollection(opts.root, { oldAnswers: opts.oldAnswers, named });
  return { assets, graphs, ...(projectId === undefined ? {} : { projectId }) };
}

/** Lists every path a plan removes, in the order {@link applyCollection} removes them. */
export function collectedPaths(plan: CollectionPlan): string[] {
  return [
    ...plan.assets.files.map((f) => f.file),
    ...plan.graphs.orphans.flatMap((o) => o.paths),
    ...plan.graphs.blobs.map((b) => b.file),
  ];
}

/** Whether a plan removes nothing at all. */
export function collectsNothing(plan: CollectionPlan): boolean {
  const { rows, files, tombstones, released } = plan.assets;
  return (
    rows.base.length + rows.project.length + files.length + tombstones.length + released.length ===
      0 && plan.graphs.orphans.length + plan.graphs.blobs.length === 0
  );
}

/** Sums the bytes a plan frees, per asset root and for the graphs' state. */
export function collectedBytes(plan: CollectionPlan): Record<AssetRootName | 'graphs', number> {
  const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);
  const files = plan.assets.files;
  return {
    base   : sum(files.filter((f) => f.root === 'base').map((f) => f.bytes)),
    project: sum(files.filter((f) => f.root === 'project').map((f) => f.bytes)),
    graphs : sum([...plan.graphs.orphans, ...plan.graphs.blobs].map((x) => x.bytes)),
  };
}

/** Formats a byte count as a person reads one: `512 B`, `3.4 KB`, `1.2 MB`. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** How many groups the detail line names before it says how many more there are. */
const GROUPS_SHOWN = 4;

/** Names what a removed row was drawn for, as the detail line puts it. */
function ownerOf(row: Asset): string {
  const bound = row.satisfies[0];
  if (bound?.sceneId) return `shots of ${bound.sceneId}`;
  if (bound?.characterId && bound.outfit) return `sheets of ${bound.characterId}`;
  if (bound?.characterId) return `portraits of ${bound.characterId}`;
  if (bound?.locationId) return `plates of ${bound.locationId}`;
  return 'other pictures';
}

/** Formats `n thing(s)` with the plural spelled out. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Summarizes a plan, one line each, largest fact first: the total, the split between the asset
 * roots, how many pictures no commit holds, what the pictures were drawn for, then the task
 * records and graph state. `done` words it as finished rather than proposed.
 */
export function describeCollection(
  plan: CollectionPlan,
  opts: { uncommitted: number; done?: boolean },
): string {
  if (collectsNothing(plan)) {
    return 'Nothing to collect: every picture, task record and graph file is still in use.';
  }
  const verb = opts.done ? 'Removed' : 'Removes';
  const bytes = collectedBytes(plan);
  const { rows, files, tombstones } = plan.assets;
  const { orphans, blobs } = plan.graphs;
  const listed = new Set([...rows.base, ...rows.project].map((r) => r.hash));
  const strays = files.filter((f) => !listed.has(f.hash)).length;
  const pictures = rows.base.length + rows.project.length + strays;
  const lines: string[] = [];

  if (pictures > 0) {
    lines.push(
      `${verb} ${count(pictures, 'picture')} (${sizeLabel(bytes.base + bytes.project)}) that ` +
        'nothing in the project uses.',
    );
    const split = [
      ['Project build', 'project'],
      ['Shared assets folder', 'base'],
    ] as const;
    const parts = split
      .map(([label, name]) => {
        const n =
          rows[name].length + files.filter((f) => f.root === name && !listed.has(f.hash)).length;
        return n > 0 ? `${label}: ${n} (${sizeLabel(bytes[name])}).` : '';
      })
      .filter(Boolean);
    if (parts.length > 1) lines.push(parts.join(' '));
    lines.push(
      opts.uncommitted > 0
        ? `${count(opts.uncommitted, 'picture is', 'pictures are')} in no commit, so git cannot ` +
            `bring ${opts.uncommitted === 1 ? 'it' : 'them'} back.`
        : `${pictures === 1 ? 'It is' : 'Every one of them is'} in git history.`,
    );
    const groups = new Map<string, number>();
    for (const row of [...rows.project, ...rows.base]) {
      groups.set(ownerOf(row), (groups.get(ownerOf(row)) ?? 0) + 1);
    }
    if (strays > 0) groups.set('files no manifest lists', strays);
    const ranked = [...groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const named = ranked.slice(0, GROUPS_SHOWN).map(([what, n]) => `${what} (${n})`);
    const more = ranked.length - named.length;
    lines.push(`They are ${named.join(', ')}${more > 0 ? `, and ${more} more groups` : ''}.`);
  }
  const rest: string[] = [];
  if (tombstones.length > 0) rest.push(count(tombstones.length, 'task record'));
  if (plan.assets.released.length > 0) {
    rest.push(
      `this project's claim on ${count(plan.assets.released.length, 'shared picture')} it no longer uses`,
    );
  }
  if (orphans.length > 0) {
    const slugs = orphans.map((o) => o.slug);
    const shown = slugs.length > 3 ? `${slugs.slice(0, 3).join(', ')}, â€¦` : slugs.join(', ');
    rest.push(`the run history of ${count(orphans.length, 'deleted graph')} (${shown})`);
  }
  if (blobs.length > 0) {
    rest.push(`${count(blobs.length, 'graph intermediate')} no run record names`);
  }
  if (rest.length > 0) {
    const last = rest.pop()!;
    const list = rest.length > 0 ? `${rest.join(', ')} and ${last}` : last;
    const size = bytes.graphs > 0 ? ` (${sizeLabel(bytes.graphs)})` : '';
    lines.push(
      `${pictures > 0 ? 'Also ' : ''}${pictures > 0 ? verb.toLowerCase() : verb} ${list}${size}.`,
    );
  }
  if (tombstones.length > 0) {
    lines.push('A picture that is still wanted after this is planned again on the next run.');
  }
  return lines.join('\n');
}

/**
 * Takes a workspace-relative path away from where it is, by moving or deleting it, and answers
 * whether it is gone. A path that will not go stays where it is.
 */
export type CollectionMover = (path: string) => Promise<boolean>;

/** What a collection removed. A path the mover could not take is `stuck`, with its row kept. */
export interface AppliedCollection {
  rows: Record<AssetRootName, Asset[]>;
  tombstoned: AnyTask[];
  /** This project's claim files the collection deleted, workspace-relative. */
  released: string[];
  moved: string[];
  stuck: string[];
}

/**
 * Removes what a plan names, in an order a crash cannot hurt: the tombstones, then both manifests,
 * then the files, then graph state. A crash after the tombstones leaves rows and files that the
 * next collection removes, since their tasks are gone. A file the mover cannot take keeps its row,
 * so a stuck picture is never left unlisted.
 */
export async function applyCollection(
  root: string,
  plan: CollectionPlan,
  move: CollectionMover,
): Promise<AppliedCollection> {
  const paths = new ProjectPaths(root);
  for (const task of plan.assets.tombstones) await logTombstone(paths, task);

  const roots: Record<AssetRootName, AssetRoot> = {
    base   : await AssetRoot.open(paths.baseObjects, paths.baseManifest),
    project: await AssetRoot.open(paths.assetsDir, paths.manifest),
  };
  const rows: Record<AssetRootName, Asset[]> = {
    base   : await roots.base.remove(plan.assets.rows.base.map((r) => r.hash)),
    project: await roots.project.remove(plan.assets.rows.project.map((r) => r.hash)),
  };
  // A claim is a document the undo snapshot holds, so it is deleted here rather than moved
  const released: string[] = [];
  if (plan.projectId !== undefined) {
    for (const hash of plan.assets.released) {
      const file = await removeClaim(paths, hash, plan.projectId);
      if (file !== undefined) released.push(workspacePath(root, file));
    }
  }

  const moved: string[] = [];
  const stuck: string[] = [];
  for (const file of plan.assets.files) {
    if (await move(file.file)) {
      moved.push(file.file);
      continue;
    }
    stuck.push(file.file);
    const row = rows[file.root].find((r) => r.hash === file.hash);
    if (!row) continue;
    await roots[file.root].reinstate([row]);
    rows[file.root] = rows[file.root].filter((r) => r !== row);
  }
  for (const path of collectedPaths({
    assets: { ...plan.assets, files: [] },
    graphs: plan.graphs,
  })) {
    if (await move(path)) moved.push(path);
    else stuck.push(path);
  }
  return { rows, tombstoned: plan.assets.tombstones, released, moved, stuck };
}
