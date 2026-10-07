/**
 * The half of project validation that reads the model, the two asset roots, the task log and the
 * playable. It writes nothing: the manifests are opened without `repairCurrent`, so a slot left
 * with two current rows is reported rather than put right. `@vn/gengraph`'s `validateProject`
 * adds the graph documents and runs both halves.
 */
import { readdir } from 'node:fs/promises';
import type { PromptOverride } from '@vn/types';
import { playableSchema, type ProjectModel } from '@vn/types';
import {
  AssetRoot,
  AssetStore,
  discoverEntities,
  entityFile,
  readAllShots,
  workspacePath,
  type ProjectPaths,
} from '@vn/store';
import { loadGraph } from '@vn/taskgraph';
import { exists, readText } from '@vn/util';
import { overHeld } from './overheld.js';
import { angleOfTask } from './takes.js';

/**
 * `blocking` means the next run or a read of the project would fail; `information` is stale
 * state that fails nothing.
 */
export type FindingSeverity = 'blocking' | 'information';

export type FindingKind =
  /** A `done` task whose output is in neither object folder. */
  | 'missing-output'
  /** A `done` task whose output has a file but no manifest row. */
  | 'unlisted-output'
  /** A manifest row with no file in its root. */
  | 'missing-file'
  /** A sheet, a shot or a graph naming a hash no manifest has. */
  | 'missing-row'
  /** A slot with more than one current row. */
  | 'over-held'
  /** A file in an object folder with no row in that root's manifest. */
  | 'stray-file'
  /** An `Asset.refs` entry naming a hash no manifest has. */
  | 'stale-ref'
  /** `story.play.json` naming a picture that is in neither object folder. */
  | 'stale-playable'
  /** A file that did not parse, so nothing it names was checked. */
  | 'unparsed';

export interface ProjectFinding {
  severity: FindingSeverity;
  kind: FindingKind;
  hash?: string;
  /** The workspace-relative file the finding is about, forward-slashed. */
  where: string;
  /** What names the hash: a task, a character, a shot, a graph. */
  referrer: string;
  message: string;
}

const OBJECT_FILE = /^([0-9a-f]+)\.([A-Za-z0-9]+)$/;

/** Lists the file names in an object folder, by hash. A folder that does not exist holds none. */
async function objectFiles(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    const match = OBJECT_FILE.exec(name);
    if (match) files.set(match[1]!, name);
  }
  return files;
}

const short = (hash: string): string => hash.slice(0, 8);

/**
 * Builds the finding for a file, or a value inside one, that did not parse, so nothing it names
 * was checked. `subject` is what the message names; it defaults to the file itself.
 */
export function unparsedFinding(where: string, referrer: string, subject = where): ProjectFinding {
  return {
    severity: 'information',
    kind    : 'unparsed',
    where,
    referrer,
    message: `${subject} could not be checked (parse errors).`,
  };
}

/** Lists every pin on one override, with the chunk that carries it. */
function pinsOf(override: PromptOverride | undefined): { chunk: string; pin: string }[] {
  const out: { chunk: string; pin: string }[] = [];
  for (const [chunk, refs] of Object.entries(override?.refs ?? {})) {
    for (const ref of refs) out.push({ chunk, pin: ref.pin });
  }
  return out;
}

/** Checks the model, the asset roots, the task log and the playable without writing anything. */
export async function validateAssets(
  paths: ProjectPaths,
  model: ProjectModel,
): Promise<ProjectFinding[]> {
  const rel = (abs: string): string => workspacePath(paths.root, abs);
  const findings: ProjectFinding[] = [];
  const [base, project, store, graph, shots, entities] = await Promise.all([
    AssetRoot.open(paths.baseObjects, paths.baseManifest),
    AssetRoot.open(paths.assetsDir, paths.manifest),
    AssetStore.open(paths),
    loadGraph(paths),
    readAllShots(paths, model, { reportBroken: true }),
    discoverEntities(paths, []),
  ]);
  const roots = [
    { root: base, files: await objectFiles(base.dir) },
    { root: project, files: await objectFiles(project.dir) },
  ];
  const onDisk = (hash: string): boolean => roots.some((r) => r.files.has(hash));

  for (const task of graph.all()) {
    if (task.status !== 'done' || task.output === undefined) continue;
    if (task.kind === 'vision_review' || task.kind === 'prompt_refine') continue;
    const referrer = `${task.kind} task ${short(task.hash)}`;
    if (!onDisk(task.output)) {
      findings.push({
        severity: 'blocking',
        kind    : 'missing-output',
        hash    : task.output,
        where   : rel(paths.tasksLog),
        referrer,
        message: `The ${referrer} is done, but its picture ${short(task.output)} is in neither asset folder.`,
      });
    } else if (!store.has(task.output)) {
      findings.push({
        severity: 'blocking',
        kind    : 'unlisted-output',
        hash    : task.output,
        where   : rel(paths.tasksLog),
        referrer,
        message: `The ${referrer} is done, and its picture ${short(task.output)} is on disk, but no manifest lists it.`,
      });
    }
  }

  for (const { root, files } of roots) {
    const where = rel(root.manifestFile);
    for (const row of root.assets()) {
      if (files.get(row.hash) === `${row.hash}.${row.ext}`) continue;
      findings.push({
        severity: 'blocking',
        kind    : 'missing-file',
        hash    : row.hash,
        where,
        referrer: `${row.kind} row`,
        message: `${where} lists the ${row.kind} ${short(row.hash)}, but ${rel(root.fileOf(row))} is missing.`,
      });
    }
    for (const [hash, name] of files) {
      if (root.has(hash)) continue;
      findings.push({
        severity: 'information',
        kind    : 'stray-file',
        hash,
        where   : rel(root.fileOf({ hash, ext: name.slice(hash.length + 1) })),
        referrer: 'object folder',
        message : `${name} is in ${rel(root.dir)}, but ${where} has no row for it.`,
      });
    }
  }

  const unnamed = (hash: string, where: string, referrer: string, what: string): void => {
    if (store.has(hash)) return;
    findings.push({
      severity: 'blocking',
      kind    : 'missing-row',
      hash,
      where,
      referrer,
      message: `${what} names the picture ${short(hash)}, which no manifest lists.`,
    });
  };

  for (const character of model.characters.values()) {
    const file = entityFile(entities.characterDocs, character.id);
    const where = file === undefined ? `characters/${character.id}` : rel(file);
    const referrer = `character ${character.id}`;
    if (character.approvedPortrait !== undefined) {
      unnamed(character.approvedPortrait, where, referrer, `${referrer}'s approved_portrait`);
    }
    for (const { chunk, pin } of pinsOf(character.promptOverride)) {
      unnamed(pin, where, referrer, `A pin on ${referrer}'s ${chunk} clause`);
    }
    for (const outfit of character.outfits) {
      const owner = `outfit ${character.id}/${outfit.id}`;
      for (const { chunk, pin } of pinsOf(outfit.promptOverride)) {
        unnamed(pin, where, owner, `A pin on ${owner}'s ${chunk} clause`);
      }
    }
  }

  for (const location of model.locations.values()) {
    const file = entityFile(entities.locationDocs, location.id);
    const where = file === undefined ? `locations/${location.id}` : rel(file);
    for (const variant of location.variants) {
      const owner = `location ${location.id} (${variant.id})`;
      for (const { chunk, pin } of pinsOf(variant.promptOverride)) {
        unnamed(pin, where, owner, `A pin on ${owner}'s ${chunk} clause`);
      }
    }
  }

  for (const [sceneId, list] of shots) {
    const where = rel(paths.shotsFile(sceneId));
    if (list === null) {
      findings.push(unparsedFinding(where, `scene ${sceneId}`));
      continue;
    }
    for (const shot of list) {
      const referrer = `shot ${shot.id}`;
      if (shot.image !== undefined) unnamed(shot.image, where, referrer, `The ${referrer}`);
      for (const { chunk, pin } of pinsOf(shot.promptOverride)) {
        unnamed(pin, where, referrer, `A pin on the ${referrer}'s ${chunk} clause`);
      }
    }
  }

  const assets = store.manifest();
  for (const fix of overHeld({ model, assets, angleOf: angleOfTask(graph), shots })) {
    const held = [fix.keep, ...fix.drop].map(short).join(', ');
    findings.push({
      severity: 'blocking',
      kind    : 'over-held',
      where   : rel(store.manifestFileOf(fix.keep)),
      referrer: `slot ${fix.slot}`,
      message: `The slot ${fix.slot} holds ${fix.drop.length + 1} current pictures (${held}), so it resolves to none.`,
    });
  }

  for (const row of assets) {
    for (const ref of row.refs) {
      if (store.has(ref)) continue;
      findings.push({
        severity: 'information',
        kind    : 'stale-ref',
        hash    : ref,
        where   : rel(store.manifestFileOf(row.hash)),
        referrer: `${row.kind} ${short(row.hash)}`,
        message: `The ${row.kind} ${short(row.hash)} was drawn from ${short(ref)}, which no manifest lists any more.`,
      });
    }
  }

  findings.push(...(await validatePlayable(paths, onDisk)));
  return findings;
}

/**
 * Formats the findings as one message: a count line, up to `limit` findings in the order given,
 * and how many were left out.
 */
export function describeFindings(findings: readonly ProjectFinding[], limit = 20): string {
  if (findings.length === 0) return 'Validation found no problems.';
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  const head =
    `Validation found ${blocking} blocking problem(s) and ` +
    `${findings.length - blocking} for information.`;
  const lines = findings
    .slice(0, limit)
    .map((f) => `- ${f.severity === 'blocking' ? 'Blocking' : 'Info'}: ${f.message} (${f.where})`);
  const rest = findings.length - limit;
  return [head, ...lines, ...(rest > 0 ? [`… and ${rest} more.`] : [])].join('\n');
}

/**
 * Reports each picture `story.play.json` names that is in neither object folder, or the playable
 * itself when it does not parse.
 */
async function validatePlayable(
  paths: ProjectPaths,
  onDisk: (hash: string) => boolean,
): Promise<ProjectFinding[]> {
  const where = workspacePath(paths.root, paths.storyPlay);
  if (!(await exists(paths.storyPlay))) return [];
  let json: unknown;
  try {
    json = JSON.parse(await readText(paths.storyPlay));
  } catch {
    return [unparsedFinding(where, 'playable')];
  }
  const parsed = playableSchema.safeParse(json);
  if (!parsed.success) return [unparsedFinding(where, 'playable')];

  const named = new Map<string, string>();
  for (const [id, character] of Object.entries(parsed.data.characters)) {
    if (character.portrait) named.set(character.portrait.hash, `character ${id}`);
  }
  for (const [id, scene] of Object.entries(parsed.data.scenes)) {
    for (const beat of scene.beats) {
      if (beat.type !== 'show' || !beat.image) continue;
      named.set(beat.image.hash, beat.shot === undefined ? `scene ${id}` : `shot ${beat.shot}`);
    }
  }
  const findings: ProjectFinding[] = [];
  for (const [hash, referrer] of named) {
    if (onDisk(hash)) continue;
    findings.push({
      severity: 'information',
      kind    : 'stale-playable',
      hash,
      where,
      referrer,
      message: `${where} shows ${short(hash)} for ${referrer}, which is gone; export the playable again.`,
    });
  }
  return findings;
}
