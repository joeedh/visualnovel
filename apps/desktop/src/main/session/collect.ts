/**
 * `asset.collect` in the desktop app: run the collector, keep what it removes in a holding folder
 * so the collection can be undone, and the sidecar phases that undo and redo it.
 *
 * A held collection is `vngen/state/collected/<hold>/`: each removed path at its own
 * workspace-relative place under the folder, and `plan.json`, which lists the removed rows, the
 * records the tombstones replaced, and what has been moved so far. `vngen/state` is outside the
 * undo snapshot, so moving files there is not drift, and the folder is ignored by git.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Asset } from '@vn/types';
import { uncommitted } from '@vn/git';
import {
  applyCollection,
  collectProject,
  collectsNothing,
  describeCollection,
  sizeLabel,
  unreadInputs,
  type CollectionPlan,
} from '@vn/gengraph/state';
import { AssetRoot, ProjectPaths } from '@vn/store';
import { latestRecords, tombstoneOf, type TaskRecord } from '@vn/taskgraph';
import { appendJsonl, exists, moveFile, readText, writeFileAtomic } from '@vn/util';
import { BUSY_PASS, BUSY_RUN } from '../../shared/ipc.js';
import { COLLECTED_DIR } from '../workspace/workspace.js';
import type { WorkspaceSession } from './core.js';
import { readProject } from './core.js';

/** What a holding folder records about its collection. Paths are workspace-relative. */
interface HeldPlan {
  rows: { base: Asset[]; project: Asset[] };
  /** The latest record of each task the collection tombstoned, as it was before. */
  tombstones: TaskRecord[];
  /** What has been moved into the folder, in order. */
  moved: string[];
}

/** One collection's outcome, as the command reports it. */
export interface CollectResult {
  message: string;
  written: string[];
  /** The holding folder's id, when the removed files were kept for undo. */
  hold?: string;
}

/** Serializes a value as JSON with every object's keys sorted, so key order does not matter. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** Compares two records by content, ignoring key order and the `restored` stamp. */
function sameRecord(a: TaskRecord | undefined, b: TaskRecord | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonical({ ...a, restored: undefined }) === canonical({ ...b, restored: undefined });
}

/** Whether two paths hold the same bytes; folders are never the same. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    if ((await stat(a)).isDirectory() || (await stat(b)).isDirectory()) return false;
    return (await readFile(a)).equals(await readFile(b));
  } catch {
    return false;
  }
}

const isGraphState = (path: string): boolean => path.startsWith('vngen/state/graphs/');

export class CollectPart {
  constructor(private readonly session: WorkspaceSession) {}

  private get paths(): ProjectPaths {
    return new ProjectPaths(this.session.dir);
  }

  private abs(path: string): string {
    return join(this.session.dir, path);
  }

  private holdDir(hold: string): string {
    return join(this.session.dir, COLLECTED_DIR, hold);
  }

  /** Returns a refusal while a run or pass that a collection would race is in progress. */
  refusal(): string | undefined {
    for (const what of [BUSY_RUN, BUSY_PASS]) {
      if (this.session.running(what)) return `Nothing was collected: ${what} is in progress.`;
    }
    return undefined;
  }

  /** Decides a collection over the project as it is on disk, writing nothing. */
  async plan(
    oldAnswers: boolean,
  ): Promise<{ ok: true; plan: CollectionPlan } | { ok: false; message: string }> {
    const busy = this.refusal();
    if (busy) return { ok: false, message: busy };
    const project = await readProject(this.session.dir);
    const unread = unreadInputs([...project.inputs.diagnostics, ...project.model.diagnostics]);
    if (unread) return { ok: false, message: unread };
    const plan = await collectProject({
      root  : this.session.dir,
      model : project.model,
      config: project.config,
      oldAnswers,
    });
    return { ok: true, plan };
  }

  /** Builds the check's sentence: the summary, then how long undo can bring the files back. */
  async preview(opts: {
    oldAnswers: boolean;
    keepForUndo: boolean;
  }): Promise<{ ok: boolean; message: string }> {
    const planned = await this.plan(opts.oldAnswers);
    if (!planned.ok) return planned;
    const files = planned.plan.assets.files.map((f) => this.abs(f.file));
    const summary = describeCollection(planned.plan, {
      uncommitted: (await uncommitted(files)).size,
    });
    if (collectsNothing(planned.plan)) return { ok: true, message: summary };
    const held = planned.plan.assets.files.reduce((sum, f) => sum + f.bytes, 0);
    const undo = opts.keepForUndo
      ? 'Undo brings all of it back until the next command that cannot be undone, such as a ' +
        `pipeline run, or until 50 later undo points push it out. Until then the files ` +
        `(${sizeLabel(held)}) stay in ${COLLECTED_DIR}/, so the space is freed only then.`
      : 'The files are deleted at once, and Undo cannot bring them back.';
    return { ok: true, message: `${summary}\n${undo}` };
  }

  /** Runs a collection, holding what it removes when `keepForUndo` is set. */
  async collect(opts: { oldAnswers: boolean; keepForUndo: boolean }): Promise<CollectResult> {
    const planned = await this.plan(opts.oldAnswers);
    if (!planned.ok) throw new Error(planned.message);
    const { plan } = planned;
    if (collectsNothing(plan)) {
      return { message: describeCollection(plan, { uncommitted: 0 }), written: [] };
    }
    const uncommittedFiles = (await uncommitted(plan.assets.files.map((f) => this.abs(f.file))))
      .size;

    const hold = opts.keepForUndo ? randomBytes(8).toString('hex') : undefined;
    const held: HeldPlan = {
      rows      : plan.assets.rows,
      tombstones: plan.assets.tombstones as TaskRecord[],
      moved     : [],
    };
    const writePlan = async (): Promise<void> => {
      if (hold)
        await writeFileAtomic(join(this.holdDir(hold), 'plan.json'), JSON.stringify(held, null, 2));
    };
    await writePlan();

    const applied = await applyCollection(this.session.dir, plan, async (path) => {
      try {
        if (hold) {
          await moveFile(this.abs(path), join(this.holdDir(hold), path));
          held.moved.push(path);
          await writePlan();
        } else {
          await rm(this.abs(path), { recursive: true, force: true });
        }
        return true;
      } catch {
        return false;
      }
    });
    held.rows = applied.rows;
    await writePlan();

    const written = [
      ...(applied.rows.base.length > 0 ? ['assets/manifest.json'] : []),
      ...(applied.rows.project.length > 0 ? ['vngen/build/manifest.json'] : []),
      ...(applied.tombstoned.length > 0 ? ['vngen/state/tasks.jsonl'] : []),
      ...applied.moved,
    ];
    const stuck =
      applied.stuck.length > 0
        ? ` ${applied.stuck.length} file(s) would not move and stay, with their rows, for the ` +
          `next collection: ${applied.stuck.slice(0, 3).join(', ')}${applied.stuck.length > 3 ? ', …' : ''}.`
        : '';
    const said = describeCollection(plan, { uncommitted: uncommittedFiles, done: true });
    const message = `${said}${stuck ? `\n${stuck.trim()}` : ''}`;
    return { message, written, ...(hold ? { hold } : {}) };
  }

  /** Reads the held plan, and throws when the holding folder is gone. */
  private async heldPlan(hold: string): Promise<HeldPlan> {
    const file = join(this.holdDir(hold), 'plan.json');
    if (!(await exists(file))) {
      throw new Error(
        'The files this collection removed are no longer held, so it cannot be undone here. ' +
          'Bring them back from git history, then recover what is missing.',
      );
    }
    return JSON.parse(await readText(file)) as HeldPlan;
  }

  /**
   * Refuses, before anything is written, when a tombstoned task's latest record is neither its
   * tombstone nor the record the tombstone replaced (a stopped undo or redo may already have
   * written either one), or when a moved path exists again with different bytes.
   */
  private async guard(hold: string, plan: HeldPlan, direction: 'undo' | 'redo'): Promise<void> {
    const latest = await latestRecords(this.paths);
    for (const replaced of plan.tombstones) {
      const now = latest.get(replaced.hash);
      const ok = sameRecord(now, tombstoneOf(replaced)) || sameRecord(now, replaced);
      if (!ok) {
        throw new Error(
          `The task ${replaced.hash.slice(0, 8)} was written again since the collection, so ` +
            `${direction === 'undo' ? 'undoing' : 'redoing'} it would overwrite that; nothing was moved.`,
        );
      }
    }
    for (const path of plan.moved) {
      const [from, to] =
        direction === 'undo'
          ? [join(this.holdDir(hold), path), this.abs(path)]
          : [this.abs(path), join(this.holdDir(hold), path)];
      if (!(await exists(from)) || !(await exists(to))) continue;
      if (!(await sameBytes(from, to))) {
        throw new Error(
          `${path} exists again with different contents, so ${direction} would overwrite it; ` +
            'nothing was moved.',
        );
      }
    }
  }

  /**
   * Moves held paths back to their places (undo) or into the holding folder (redo). Where the
   * destination already exists, the source is deleted instead.
   */
  private async shift(
    hold: string,
    paths: readonly string[],
    direction: 'undo' | 'redo',
  ): Promise<string[]> {
    const done: string[] = [];
    const failed: string[] = [];
    for (const path of paths) {
      const inHold = join(this.holdDir(hold), path);
      const [from, to] = direction === 'undo' ? [inHold, this.abs(path)] : [this.abs(path), inHold];
      if (!(await exists(from))) continue;
      try {
        if (await exists(to)) await rm(from, { recursive: true, force: true });
        else await moveFile(from, to);
        done.push(path);
      } catch {
        failed.push(path);
      }
    }
    if (failed.length > 0) {
      throw new Error(
        `${failed.length} path(s) did not move (${failed.slice(0, 3).join(', ')}); ` +
          `${done.length} did. Run it again once nothing holds them open.`,
      );
    }
    return done;
  }

  /**
   * Runs the sidecar's first phase. It checks the guards, then moves the pictures back (undo) or
   * rewrites the tombstones and removes the project rows (redo).
   */
  async beforeRestore(hold: string, direction: 'undo' | 'redo'): Promise<string[]> {
    const plan = await this.heldPlan(hold);
    await this.guard(hold, plan, direction);
    if (direction === 'undo') {
      return this.shift(
        hold,
        plan.moved.filter((p) => !isGraphState(p)),
        'undo',
      );
    }
    const written: string[] = [];
    const latest = await latestRecords(this.paths);
    for (const replaced of plan.tombstones) {
      if (sameRecord(latest.get(replaced.hash), tombstoneOf(replaced))) continue;
      await appendJsonl(this.paths.tasksLog, tombstoneOf(replaced));
      written.push('vngen/state/tasks.jsonl');
    }
    const project = await AssetRoot.open(this.paths.assetsDir, this.paths.manifest);
    if ((await project.remove(plan.rows.project.map((r) => r.hash))).length > 0) {
      written.push('vngen/build/manifest.json');
    }
    return [...new Set(written)];
  }

  /**
   * Runs the sidecar's second phase. It reinstates rows, graph state and task records (undo), or
   * moves the files back into the holding folder (redo).
   */
  async afterRestore(hold: string, direction: 'undo' | 'redo'): Promise<string[]> {
    const plan = await this.heldPlan(hold);
    if (direction === 'redo') return this.shift(hold, plan.moved, 'redo');

    const written: string[] = [];
    const project = await AssetRoot.open(this.paths.assetsDir, this.paths.manifest);
    if ((await project.reinstate(plan.rows.project)).length > 0) {
      written.push('vngen/build/manifest.json');
    }
    // The snapshot restore usually puts the base rows back already; this covers a base folder
    // the snapshot does not hold
    const base = await AssetRoot.open(this.paths.baseObjects, this.paths.baseManifest);
    if ((await base.reinstate(plan.rows.base)).length > 0) written.push('assets/manifest.json');
    written.push(
      ...(await this.shift(
        hold,
        plan.moved.filter((p) => isGraphState(p)),
        'undo',
      )),
    );
    const latest = await latestRecords(this.paths);
    const at = new Date().toISOString();
    for (const replaced of plan.tombstones) {
      if (!sameRecord(latest.get(replaced.hash), tombstoneOf(replaced))) continue;
      await appendJsonl(this.paths.tasksLog, { ...replaced, restored: at });
      written.push('vngen/state/tasks.jsonl');
    }
    return [...new Set(written)];
  }

  /** Deletes a holding folder. One already gone is not an error. */
  async release(hold: string): Promise<void> {
    await rm(this.holdDir(hold), { recursive: true, force: true });
  }
}
