/**
 * The half of the collector that reads the model, the two asset roots and the task log: which
 * manifest rows nothing uses any more, which files go with them, and which task records to
 * tombstone. It decides and writes nothing; `@vn/gengraph`'s `collectProject` adds the graph
 * documents' references and applies the plan.
 *
 * Liveness is decided per row rather than per hash, because one hash can have a row in each root:
 * an upload adopted onto a shot keeps its base row when the shot is deleted.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectConfig } from '@vn/config';
import { angleOfTask, sheetAngleOf, slotKey, slotsOf, stillsFamily } from '@vn/stills';
import { keepSet } from '@vn/constraint-solver';
import { contract } from '@vn/contracts';
import { AssetRoot, AssetStore, readProduction, workspacePath, type ProjectPaths } from '@vn/store';
import { latestRecords, loadGraph, type TaskRecord } from '@vn/taskgraph';
import type { AnyTask, Asset, ProjectModel, PromptOverride, TaskKind } from '@vn/types';

export type AssetRootName = 'base' | 'project';

export const collectUnusedRemoved = contract({
  id      : 'collect.unusedRemoved',
  rule: "A collection removes only the manifest rows nothing uses, decided per row and root. A row stays when it fills a slot the keep set lists, a kept slot's task drew it, the project or a graph file names it, it is a concept or a reference, or a kept row was drawn from it.",
  prevents:
    "Deleting art for slots no plan has reached yet, another project's pictures in a shared `assets/`, or an entity's art because its sheet failed to parse, while superseded takes pile up for ever.",
  subjects: [
    'function:packages/artgen/src/collect.ts#planAssetCollection',
    'function:packages/constraint-solver/src/keep.ts#keepSet',
    'function:packages/stills/src/kept.ts#keptSlots',
    'function:packages/stills/src/family.ts#stillsFamily',
    'function:packages/gengraph/src/collect.ts#collectProject',
    'command:asset.collect',
    'command:asset.recover',
    'tool:collect_unused_assets',
  ],
  see: [
    'docs/plans/archive/deleting-things.md',
    'docs/reference/repos-and-commits.md#the-claims-ledger',
    'docs/reference/history-pane.md#missing-pictures',
  ],
  detail:
    '`collectProject` (`packages/gengraph/src/collect.ts`, over `planAssetCollection`) decides ' +
    'everything before anything is written; `applyCollection` applies it through a mover the ' +
    "host passes (`collect.applyOrder`). `asset.collect` and the agent's `collect_unused_assets` " +
    'are its two callers. A row is kept when any of these holds: its `satisfies` binds it to a ' +
    "slot the solver's `keepSet` lists from `stillsFamily.kept` (`keptSlots`): plates and " +
    'portraits as the family enumerates them, sheets for every outfit a character defines or a ' +
    'scene names, and shots from every persisted storyboard, so an unwired scene keeps its ' +
    "frames; its hash is the output, or an attempt's output, of a kept slot's task " +
    '(`KeepSet.outputs`); an `approved_portrait:`, a `Shot.image`, a pin, or a graph document or ' +
    'group definition names it (graph files are scanned as raw text for hashes, so one that does ' +
    'not parse still protects what it names); it is a `concept` or a `reference`; a kept row ' +
    "lists it in `refs`, transitively. Every take of a kept slot is kept, so a deleted character's " +
    'portrait stays while an older frame drawn from it does. A base row is a candidate only when ' +
    "its `sourceTask` is in this project's `tasks.jsonl`, so a shared `assets/` never loses " +
    "another project's pictures. A base picture another project claims in `assets/claims/` is " +
    "kept, and this project's own claim on one it no longer uses is dropped. The collection also " +
    'removes files in an object folder no row lists, the journal and blob folder of a graph whose ' +
    'document is gone, and blobs no journal record names (with `oldAnswers`, blobs only ' +
    'superseded records name). It tombstones each task whose output it removes, and each ' +
    '`failed` or `needs_human` slot task no kept slot names (`KeepSet.tasks`). It refuses while ' +
    'an input fails to load, because a sheet that does not parse drops its entity from the model ' +
    "and that entity's art would look unused; a storyboard that does not parse keeps its scene's " +
    'frames. `asset.recover` puts a collected picture back from git history and appends a copy ' +
    "of the last `done` record whose output is its hash, stamped `restored`, when that task's " +
    'latest record is a tombstone. The copy restates a record the log already holds, so it is ' +
    'not a forged record: the picture it names is the one that task drew.',
});

/** One file the collection removes, workspace-relative and forward-slashed. */
export interface CollectedFile {
  root: AssetRootName;
  hash: string;
  file: string;
  bytes: number;
}

/** What a collection would remove from the asset roots and the task log. */
export interface AssetCollection {
  /** The rows to remove, by root. */
  rows: Record<AssetRootName, Asset[]>;
  /**
   * The files to remove: those of the removed rows still on disk, and files in an object folder
   * that no row in that root lists and nothing names.
   */
  files: CollectedFile[];
  /** The latest record of each task to tombstone. */
  tombstones: AnyTask[];
  /** Hashes this project claims and no longer uses, whose claims the collection drops. */
  released: string[];
}

/** The kinds of task a slot plans; every other kind hangs off one of these. */
const SLOT_TASKS = new Set<TaskKind>(['portrait', 'location_ref', 'model_sheet', 'shot_image']);

/** Lists every pin on one override. */
function pinsOf(override: PromptOverride | undefined): string[] {
  return Object.values(override?.refs ?? {}).flatMap((refs) => refs.map((r) => r.pin));
}

/** Answers the size of a file, or undefined when it is not there. */
async function sizeOf(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).size;
  } catch {
    return undefined;
  }
}

const OBJECT_FILE = /^([0-9a-f]+)\.[A-Za-z0-9]+$/;

/**
 * Decides what a collection removes from the asset roots and the task log, writing nothing.
 * `live` adds hashes named outside the model, the roots and the log: graph documents and group
 * definitions, and the claims ledger.
 *
 * A row is kept when any of these holds:
 * - a binding ties it to a slot the solver's `keepSet` lists for the stills family;
 * - its hash is the output, or an attempt's output, of a kept slot's task;
 * - an approved portrait, a shot's image, a pin on any rung, or `live` names its hash;
 * - it is a `concept` or a `reference`, which no slot claims by design;
 * - a kept row was drawn from it (`refs`), transitively.
 *
 * A base row is removed only when this project's task log produced it, and never while another
 * project claims it, so pictures another project made or uses in a shared `assets/` are left
 * alone. This project's own claim on a hash nothing of its own uses is `released`. A storyboard
 * that does not parse keeps every shot row bound to its scene, since what it holds cannot be known.
 */
export async function planAssetCollection(opts: {
  paths: ProjectPaths;
  model: ProjectModel;
  config: ProjectConfig;
  live?: Iterable<string>;
  /** Hashes another project claims, which are kept as if this project named them. */
  claimed?: Iterable<string>;
  /** Hashes this project claims, whose claims go once nothing of this project's uses them. */
  ownClaims?: Iterable<string>;
}): Promise<AssetCollection> {
  const { paths, config } = opts;
  const [base, project, store, graph, read, records] = await Promise.all([
    AssetRoot.open(paths.baseObjects, paths.baseManifest),
    AssetRoot.open(paths.assetsDir, paths.manifest),
    AssetStore.open(paths),
    loadGraph(paths),
    readProduction(paths, opts.model),
    latestRecords(paths),
  ]);
  const model = { ...opts.model, production: read.production };
  const unread = read.broken;
  const assets = store.manifest();
  const angleOf = angleOfTask(graph);

  const keep = keepSet(stillsFamily, { model, config, assets, tasks: graph });
  const keys = keep.slots;
  const slotTasks = keep.tasks;

  const named = new Set<string>([...(opts.live ?? []), ...keep.outputs]);
  for (const character of model.characters.values()) {
    if (character.approvedPortrait) named.add(character.approvedPortrait);
    for (const pin of pinsOf(character.promptOverride)) named.add(pin);
    for (const outfit of character.outfits)
      for (const pin of pinsOf(outfit.promptOverride)) named.add(pin);
  }
  for (const location of model.locations.values()) {
    for (const variant of location.variants) {
      for (const pin of pinsOf(variant.promptOverride)) named.add(pin);
    }
  }
  for (const board of model.production.values()) {
    for (const shot of board.shots) {
      if (shot.image) named.add(shot.image);
      for (const pin of pinsOf(shot.promptOverride)) named.add(pin);
    }
  }

  const roots: Record<AssetRootName, AssetRoot> = { base, project };
  /**
   * Answers the rows kept, keyed `root:hash`, starting from the hashes in `seed`. With `foreign`, a
   * base row this project did not make is kept too, since it belongs to another project sharing the
   * folder. The refs of every kept row keep what they were drawn from, and are added to `seed`.
   */
  const reach = (seed: Set<string>, foreign: boolean): Set<string> => {
    const kept = new Set<string>();
    const keptRow = (name: AssetRootName, row: Asset): boolean => {
      if (row.kind === 'concept' || row.kind === 'reference') return true;
      if (seed.has(row.hash)) return true;
      for (const slot of slotsOf(row, sheetAngleOf(row, { angleOf }))) {
        if (keys.has(slotKey(slot))) return true;
        if (slot.kind === 'shot' && unread.has(slot.sceneId)) return true;
      }
      return (
        foreign && name === 'base' && !(row.sourceTask !== undefined && records.has(row.sourceTask))
      );
    };
    const pending: Asset[] = [];
    for (const name of ['base', 'project'] as const) {
      for (const row of roots[name].assets()) {
        if (keptRow(name, row)) {
          kept.add(`${name}:${row.hash}`);
          pending.push(row);
        }
      }
    }
    const drawnFrom = new Set<string>();
    while (pending.length > 0) {
      const row = pending.pop()!;
      for (const ref of row.refs) {
        if (drawnFrom.has(ref)) continue;
        drawnFrom.add(ref);
        seed.add(ref);
        for (const name of ['base', 'project'] as const) {
          const other = roots[name].get(ref);
          if (other && !kept.has(`${name}:${ref}`)) {
            kept.add(`${name}:${ref}`);
            pending.push(other);
          }
        }
      }
    }
    return kept;
  };

  // What this project uses on its own, before claims and other projects' rows are counted
  const ours = new Set(named);
  const used = reach(ours, false);
  const own = [...(opts.ownClaims ?? [])];
  const released = own.filter(
    (hash) => !ours.has(hash) && !used.has(`base:${hash}`) && !used.has(`project:${hash}`),
  );
  for (const hash of opts.claimed ?? []) named.add(hash);
  for (const hash of own) if (!released.includes(hash)) named.add(hash);
  const kept = reach(named, true);

  const rows: Record<AssetRootName, Asset[]> = { base: [], project: [] };
  const files: CollectedFile[] = [];
  const rel = (abs: string): string => workspacePath(paths.root, abs);
  for (const name of ['base', 'project'] as const) {
    const root = roots[name];
    for (const row of root.assets()) {
      if (kept.has(`${name}:${row.hash}`)) continue;
      rows[name].push(row);
      const file = root.fileOf(row);
      const bytes = await sizeOf(file);
      if (bytes !== undefined) files.push({ root: name, hash: row.hash, file: rel(file), bytes });
    }
    // Also removes files no row lists, which a collection that stopped after its manifest
    // writes leaves behind
    const names = await readdir(root.dir).catch(() => [] as string[]);
    for (const entry of names) {
      const hash = OBJECT_FILE.exec(entry)?.[1];
      if (hash === undefined || root.has(hash) || named.has(hash)) continue;
      const file = join(root.dir, entry);
      const bytes = await sizeOf(file);
      if (bytes !== undefined) files.push({ root: name, hash, file: rel(file), bytes });
    }
  }

  // A task is tombstoned only when its output leaves both roots
  const gone = new Set<string>();
  for (const [name, other] of [
    ['base', project],
    ['project', base],
  ] as const) {
    for (const row of rows[name]) {
      if (
        !other.has(row.hash) ||
        !kept.has(`${name === 'base' ? 'project' : 'base'}:${row.hash}`)
      ) {
        gone.add(row.hash);
      }
    }
  }
  const tombstones: AnyTask[] = [];
  for (const task of graph.all()) {
    const orphaned =
      (task.status === 'failed' || task.status === 'needs_human') &&
      SLOT_TASKS.has(task.kind) &&
      !slotTasks.has(task.hash);
    if ((task.output !== undefined && gone.has(task.output)) || orphaned) {
      tombstones.push(records.get(task.hash) as TaskRecord);
    }
  }
  return { rows, files, tombstones, released };
}
