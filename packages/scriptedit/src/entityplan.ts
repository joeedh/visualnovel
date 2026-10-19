/**
 * The write path for an entity delete, the counterpart of `apply.ts`'s for a prose edit: gather
 * what `entitydelete.ts` decides against, prove what it returns, then write it. A command's check
 * and its run both call {@link planEntityDelete}, so the listing an author confirms is the plan
 * the run carries out.
 */
import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { applyCharacterEdit, applyLocationEdit, docToMarkdown } from '@vn/model';
import type { EntityDoc, LoadedInputs } from '@vn/parse';
import { deleteShots, readShots, writeShots } from '@vn/store';
import type { Asset, Character, Location, Shot } from '@vn/types';
import { readText, writeFileAtomic } from '@vn/util';
import { proveScenes, type SceneEditInput } from './apply.js';
import type { ChangedShot, EntityOp, EntityWorld, Mention } from './entitydelete.js';
import { scriptStateOf } from './sources.js';

/** Everything an entity delete is decided and written against, from one load. */
export interface EntityDeleteInput extends SceneEditInput {
  characters: ReadonlyMap<string, Character>;
  locations: ReadonlyMap<string, Location>;
  inputs: Pick<LoadedInputs, 'characterDocs' | 'locationDocs'>;
  /** Every manifest row, from both roots, so the entity's takes can be found by binding. */
  manifest: readonly Asset[];
}

/** An entity delete that will happen, with nothing left to decide. */
export interface AppliedEntityPlan {
  ok: true;
  kind: 'character' | 'location';
  id: string;
  notes: string[];
  /** Scene chunks and sheets to write whole. */
  pending: { file: string; text: string }[];
  shotWrites: Map<string, Shot[]>;
  shotRemoves: string[];
  /** Files and folders to remove, absolute. */
  removes: { path: string; folder: boolean }[];
  /** The approved portrait's absolute path, which this delete removes and undo does not restore. */
  unrestorable?: string;
  /** A folder to remove after `removes` if nothing is left in it: a conventional sheet's own. */
  emptied?: string;
  changed: ChangedShot[];
  mentions: Mention[];
}

export type EntityPlan = AppliedEntityPlan | { ok: false; message: string };

/**
 * The rule `planEntityDelete` runs over the world it gathers, such as `deleteCharacter` with its
 * arguments bound.
 */
type Decide = (world: EntityWorld) => EntityOp;

const isMarkdown = (name: string): boolean => name.toLowerCase().endsWith('.md');

/**
 * Lists every `.md` under `dir` as `[absolute, workspace-relative]`, skipping `.git` and
 * `node_modules`.
 */
async function markdownUnder(root: string, dir: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const visit = async (abs: string): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const inner = join(abs, entry.name);
      if (entry.isDirectory()) await visit(inner);
      else if (entry.isFile() && isMarkdown(entry.name)) {
        out.push([inner, relative(root, inner).replace(/\\/g, '/')]);
      }
    }
  };
  await visit(dir);
  return out;
}

const present = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => null)) !== null;

/** Finds the sheet `docs` holds for `id`, taking the first one discovery found. */
const sheetOf = (docs: readonly EntityDoc[], id: string): EntityDoc | undefined =>
  docs.find((doc) => doc.id === id);

/**
 * Decides an entity delete against a fresh read of every storyboard, the wiki and the manifest,
 * and proves it, writing nothing.
 */
export async function planEntityDelete(
  input: EntityDeleteInput,
  kind: 'character' | 'location',
  id: string,
  decide: Decide,
): Promise<EntityPlan> {
  const { paths } = input;
  const docs = kind === 'character' ? input.inputs.characterDocs : input.inputs.locationDocs;
  const sheet = sheetOf(docs, id);

  const state = scriptStateOf(input.sources, input.entry);
  const shots = new Map<string, readonly Shot[]>();
  for (const sceneId of state.scenes.keys()) {
    const loaded = await readShots(paths, sceneId);
    if (loaded) shots.set(sceneId, loaded.shots);
  }
  const pages: { path: string; text: string }[] = [];
  for (const [abs, rel] of await markdownUnder(paths.root, paths.wikiDir)) {
    if (sheet && abs === sheet.file) continue;
    pages.push({ path: rel, text: await readText(abs) });
  }
  const bound = (asset: Asset): boolean =>
    asset.satisfies.some((b) => (kind === 'character' ? b.characterId : b.locationId) === id);
  const takes = new Set(input.manifest.filter(bound).map((a) => a.hash));

  const op = decide({
    state,
    shots,
    characters: input.characters,
    locations : input.locations,
    takes,
    pages,
  });
  if (!op.ok) return { ok: false, message: op.error };

  const pending = proveScenes(input, op.op);
  if (typeof pending === 'string') return { ok: false, message: pending };
  for (const edit of op.sheets) {
    const doc = sheetOf(
      edit.kind === 'character' ? input.inputs.characterDocs : input.inputs.locationDocs,
      edit.id,
    );
    if (!doc) return { ok: false, message: `No sheet on disk for ${edit.kind} "${edit.id}".` };
    const applied =
      edit.kind === 'character'
        ? applyCharacterEdit(doc.doc, edit.edit)
        : applyLocationEdit(doc.doc, edit.edit);
    if (!applied.ok) return { ok: false, message: applied.diagnostic.message };
    pending.push({ file: doc.file, text: docToMarkdown(applied.value.doc) });
  }

  const removes: { path: string; folder: boolean }[] = [];
  if (sheet) removes.push({ path: sheet.file, folder: false });
  const work =
    kind === 'character' ? paths.workCharacterDir(id) : join(paths.work, 'locations', id);
  if (await present(work)) removes.push({ path: work, folder: true });
  const portrait = paths.approvedPortrait(id);
  const unrestorable = kind === 'character' && (await present(portrait)) ? portrait : undefined;
  // A conventional sheet sits in a folder of its own, which goes too once nothing else is in it
  const own =
    sheet && basename(sheet.file) === 'character.md' && basename(dirname(sheet.file)) === id
      ? dirname(sheet.file)
      : undefined;

  return {
    ok: true,
    kind,
    id,
    notes: op.notes,
    pending,
    shotWrites : op.shots.writes,
    shotRemoves: op.shots.removes,
    removes,
    ...(unrestorable ? { unrestorable } : {}),
    ...(own ? { emptied: own } : {}),
    changed : op.changed,
    mentions: op.mentions,
  };
}

/**
 * Writes a proved plan: chunks and sheets, then storyboards, then the removals. Paths are
 * absolute.
 */
export async function applyEntityPlan(
  input: Pick<EntityDeleteInput, 'paths'>,
  plan: AppliedEntityPlan,
): Promise<{ written: string[]; removed: string[] }> {
  const written: string[] = [];
  for (const { file, text } of plan.pending) {
    await writeFileAtomic(file, text);
    written.push(file);
  }
  for (const [sceneId, shots] of plan.shotWrites) {
    if (await writeShots(input.paths, sceneId, shots)) written.push(input.paths.shotsFile(sceneId));
  }
  const removed: string[] = [];
  for (const id of plan.shotRemoves) {
    if (await deleteShots(input.paths, id)) removed.push(input.paths.shotsFile(id));
  }
  for (const { path } of plan.removes) {
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  if (plan.emptied && (await readdir(plan.emptied).catch(() => ['?'])).length === 0) {
    await rmdir(plan.emptied);
    removed.push(plan.emptied);
  }
  return { written, removed };
}

/** The price `priceShotChanges` answers, for the check to state. */
export interface ShotPrice {
  /** Changed shots whose task identity moves, so the next run draws them again. */
  moved: number;
  /** How many of those already have a rendered frame. */
  rendered: number;
}

/**
 * Lists what the check states, one consequence per line: what is deleted, what it rewrites, what
 * it costs the art, which files go, the prose left for the author, and what undo cannot bring back.
 * A host with no undo passes `undo` as false, and the last line is left out.
 */
export function entityPlanMessage(
  plan: AppliedEntityPlan,
  root: string,
  price?: ShotPrice,
  verb = 'Deletes',
  undo = true,
): string {
  const rel = (abs: string): string => relative(root, abs).replace(/\\/g, '/');
  const lines = [`${verb} ${plan.kind} ${plan.id}.`, ...plan.notes];
  if (price && price.moved > 0) {
    const already = price.rendered > 0 ? `, ${price.rendered} of them already rendered` : '';
    lines.push(`Draws ${price.moved} shot(s) again on the next run${already}.`);
  }
  if (plan.removes.length > 0) {
    const files = plan.removes.map((r) => `${rel(r.path)}${r.folder ? '/' : ''}`);
    lines.push(`Removes ${files.join(', ')}.`);
  }
  if (plan.mentions.length > 0) {
    const where = plan.mentions.map((m) => `${m.where} (${m.count})`);
    const shown =
      where.length > 5
        ? `${where.slice(0, 5).join(', ')} and ${where.length - 5} more`
        : where.join(', ');
    lines.push(`Still named in prose, which is left as it is: ${shown}.`);
  }
  if (undo && plan.unrestorable) {
    lines.push(`Undo restores every file here except the picture ${rel(plan.unrestorable)}.`);
  }
  return lines.join('\n');
}
