/**
 * Pictures the project still names but no longer has: the check that finds them, `asset.recover`,
 * which brings one back from git history, and `asset.forget`, which drops every reference to it.
 * The check groups `validateProject`'s blocking missing-picture findings by hash.
 */
import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { assetSlotLabel } from '@vn/artgen';
import { ensureProjectId } from '@vn/config';
import { applyForget, forgetPlanMessage, planForget } from '@vn/scriptedit/write';
import { addClaim, AssetRoot, parseManifest, ProjectPaths, removeClaim } from '@vn/store';
import { latestRecords, logTombstone, restoreDone } from '@vn/taskgraph';
import type { Asset } from '@vn/types';
import { readText, writeFileAtomic } from '@vn/util';
import type { MissingPicture, MissingReport, RepoRole } from '../../shared/history.js';
import { BUSY_PASS, BUSY_RUN } from '../../shared/ipc.js';
import { ASSETCHECK_FILE } from '../workspace/workspace.js';
import type { WorkspaceSession } from './core.js';
import { editInputOf, loadProject, relPath } from './core.js';
import type { Found } from './history.js';

/** The finding kinds that mean a picture the project names is gone. */
const MISSING_KINDS = new Set(['missing-output', 'missing-file', 'missing-row']);

type RootName = 'base' | 'project';

/**
 * Where a missing picture can be put back from (git history, or the file still on disk), and what
 * restoring it takes.
 */
interface Source {
  root: RootName;
  dir: string;
  manifest: string;
  repo: Found;
  /** The commit that deleted the bytes, and the path it deleted, repository-relative. */
  deleted?: { sha: string; path: string };
  /** The row, from the manifest now or as history last held it. */
  row?: Asset;
  /** Whether the bytes are on disk already. */
  onDisk: boolean;
}

const short = (hash: string): string => hash.slice(0, 8);
const posix = (path: string): string => path.replace(/\\/g, '/');

/** Whether `inner` is `outer` or under it. */
function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel));
}

export class MissingPart {
  /** The last check's answer, which `asset.missing` serves. */
  report: MissingReport = { pictures: [], checked: null };

  constructor(private readonly session: WorkspaceSession) {}

  private get paths(): ProjectPaths {
    return new ProjectPaths(this.session.dir);
  }

  /** Returns a refusal while a run or pass that a recover or a forget would race is in progress. */
  private refusal(): string | undefined {
    for (const what of [BUSY_RUN, BUSY_PASS]) {
      if (this.session.running(what)) return `Not now: ${what} is in progress.`;
    }
    return undefined;
  }

  /** Finds the repository whose worktree holds `abs`, the innermost one when they nest. */
  private async repoHolding(abs: string): Promise<Found | null> {
    const entries = (await this.session.historyPart.repos())
      .filter((r) => !r.missing && within(r.root, abs))
      .sort((a, b) => b.root.length - a.root.length);
    const role = entries[0]?.role;
    return role === undefined ? null : this.session.historyPart.repo(role);
  }

  /** Reads each repository's `HEAD`, by role; an unborn one is absent. */
  private async heads(): Promise<Partial<Record<RepoRole, string>>> {
    const out: Partial<Record<RepoRole, string>> = {};
    for (const entry of await this.session.historyPart.repos()) {
      if (entry.missing) continue;
      const head = await (await this.session.historyPart.repo(entry.role))?.git.head();
      if (head) out[entry.role] = head;
    }
    return out;
  }

  /** Finds the row for `hash` in `manifest` as git history last held it, or undefined. */
  private async rowInHistory(
    repo: Found,
    manifest: string,
    hash: string,
    deleted?: string,
  ): Promise<Asset | undefined> {
    const file = posix(relative(repo.root, manifest));
    const mention = await repo.git.lastMention(hash, file);
    const refs = [
      ...(deleted ? [`${deleted}^`] : []),
      ...(mention ? [`${mention}^`, mention] : []),
    ];
    for (const ref of refs) {
      const bytes = await repo.git.blob(ref, file);
      if (!bytes) continue;
      try {
        const row = parseManifest(bytes.toString('utf8')).find((r) => r.hash === hash);
        if (row) return row;
      } catch {
        // A manifest that does not parse at that commit holds nothing to recover from
      }
    }
    return undefined;
  }

  /** Finds where `hash` can be put back from: the first root whose history or disk holds it. */
  private async locate(hash: string): Promise<Source | undefined> {
    const roots: [RootName, string, string][] = [
      ['base', this.paths.baseObjects, this.paths.baseManifest],
      ['project', this.paths.assetsDir, this.paths.manifest],
    ];
    for (const [root, dir, manifest] of roots) {
      const repo = await this.repoHolding(dir);
      if (!repo) continue;
      const names = await readdir(dir).catch(() => [] as string[]);
      const onDisk = names.some((name) => name.startsWith(`${hash}.`));
      const current = (await AssetRoot.open(dir, manifest)).get(hash);
      const relDir = posix(relative(repo.root, dir));
      const deleted = onDisk
        ? undefined
        : ((await repo.git.lastDeletion(`${relDir}/${hash}.*`)) ?? undefined);
      if (!onDisk && !deleted) continue;
      const row = current ?? (await this.rowInHistory(repo, manifest, hash, deleted?.sha));
      if (!row) continue;
      return { root, dir, manifest, repo, onDisk, row, ...(deleted ? { deleted } : {}) };
    }
    return undefined;
  }

  /** Explains, by name, why a picture cannot be recovered. */
  private static unrecoverable(label: string): string {
    return (
      `${label} is not in git history, so it cannot be recovered. ` +
      'Forget it instead, and the next run plans what it was for again.'
    );
  }

  /** Runs the check, keeps its answer, and records each repository's `HEAD` as checked. */
  async check(): Promise<MissingReport> {
    if (this.refusal()) return this.report;
    const findings = (await this.session.validateProject()).filter(
      (f) => f.severity === 'blocking' && MISSING_KINDS.has(f.kind) && f.hash !== undefined,
    );
    const byHash = new Map<string, string[]>();
    for (const f of findings) {
      const list = byHash.get(f.hash!) ?? [];
      const referrer = f.kind === 'missing-file' ? f.where : f.referrer;
      if (!list.includes(referrer)) list.push(referrer);
      byHash.set(f.hash!, list);
    }
    const pictures: MissingPicture[] = [];
    for (const [hash, referrers] of byHash) {
      const source = await this.locate(hash);
      const label = source?.row ? assetSlotLabel(source.row) : short(hash);
      pictures.push({
        hash,
        label,
        referrers,
        ...(source ? {} : { unrecoverable: MissingPart.unrecoverable(label) }),
      });
    }
    pictures.sort((a, b) => a.label.localeCompare(b.label));
    this.report = { pictures, checked: new Date().toISOString() };
    await writeFileAtomic(
      join(this.session.dir, ASSETCHECK_FILE),
      JSON.stringify(await this.heads(), null, 2) + '\n',
    );
    return this.report;
  }

  /** Runs the check when some repository's `HEAD` moved since the last one; otherwise nothing. */
  async checkIfMoved(): Promise<MissingReport | undefined> {
    let last: Partial<Record<RepoRole, string>> = {};
    try {
      last = JSON.parse(await readText(join(this.session.dir, ASSETCHECK_FILE))) as typeof last;
    } catch {
      // No record yet, or one that does not parse: either way the check runs
    }
    const now = await this.heads();
    const roles = new Set([...Object.keys(last), ...Object.keys(now)] as RepoRole[]);
    if ([...roles].every((role) => last[role] === now[role])) return undefined;
    return this.check();
  }

  /** Decides what `asset.recover` would do, or why it will not. */
  async previewRecover(hash: string): Promise<{ ok: boolean; message: string }> {
    const busy = this.refusal();
    if (busy) return { ok: false, message: busy };
    const source = await this.locate(hash);
    if (!source) return { ok: false, message: MissingPart.unrecoverable(short(hash)) };
    const label = source.row ? assetSlotLabel(source.row) : short(hash);
    const from = source.deleted
      ? `from the save before ${source.deleted.sha.slice(0, 8)}, which removed it`
      : 'from the file still on disk';
    const claim =
      source.root === 'base' ? ' It also records that this project uses the picture.' : '';
    return { ok: true, message: `Brings back ${label} (${short(hash)}) ${from}.${claim}` };
  }

  /**
   * Puts a missing picture back: its bytes (from git history unless still on disk), its manifest
   * row, its task record and, for base art, this project's claim.
   */
  async recover(hash: string): Promise<{ message: string; written: string[] }> {
    const busy = this.refusal();
    if (busy) throw new Error(busy);
    const source = await this.locate(hash);
    if (!source?.row) throw new Error(MissingPart.unrecoverable(short(hash)));
    const written: string[] = [];
    const rel = (abs: string): string => relPath(this.session.dir, abs);

    if (!source.onDisk && source.deleted) {
      const bytes = await source.repo.git.blob(`${source.deleted.sha}^`, source.deleted.path);
      if (!bytes) throw new Error(MissingPart.unrecoverable(short(hash)));
      const file = join(source.dir, basename(source.deleted.path));
      await writeFileAtomic(file, bytes);
      written.push(rel(file));
    }
    const root = await AssetRoot.open(source.dir, source.manifest);
    if ((await root.reinstate([source.row])).length > 0) written.push(rel(source.manifest));
    if ((await restoreDone(this.paths, hash)).length > 0) written.push(rel(this.paths.tasksLog));
    if (source.root === 'base') {
      const { id, wrote } = await ensureProjectId(this.session.dir);
      if (wrote) written.push('project.yaml');
      written.push(rel(await addClaim(this.paths, hash, id)));
    }
    await this.check();
    const label = assetSlotLabel(source.row);
    return { message: `Recovered ${label} (${short(hash)}).`, written };
  }

  /** Plans `asset.forget` against a fresh load. */
  private async planForget(hash: string) {
    const project = await loadProject(this.session.dir);
    const plan = await planForget(
      {
        ...editInputOf(project),
        characters: project.model.characters,
        locations : project.model.locations,
        inputs    : project.inputs,
      },
      hash,
    );
    return { project, plan };
  }

  /** Decides what `asset.forget` would do, or why it will not. */
  async previewForget(hash: string): Promise<{ ok: boolean; message: string }> {
    const busy = this.refusal();
    if (busy) return { ok: false, message: busy };
    const { plan } = await this.planForget(hash);
    if (!plan.ok) return plan;
    return { ok: true, message: forgetPlanMessage(plan) };
  }

  /**
   * Drops every reference this project holds to a missing picture: pins, shot images, an approved
   * portrait, its rows whose bytes are gone, this project's claim, and the task that made it.
   */
  async forget(hash: string): Promise<{ message: string; written: string[]; removed: string[] }> {
    const busy = this.refusal();
    if (busy) throw new Error(busy);
    const { project, plan } = await this.planForget(hash);
    if (!plan.ok) throw new Error(plan.message);
    const rel = (abs: string): string => relPath(this.session.dir, abs);
    const applied = await applyForget(project, plan);
    const written = applied.written.map(rel);
    const removed = applied.removed.map(rel);

    for (const [dir, manifest] of [
      [this.paths.baseObjects, this.paths.baseManifest],
      [this.paths.assetsDir, this.paths.manifest],
    ] as const) {
      const root = await AssetRoot.open(dir, manifest);
      const names = await readdir(dir).catch(() => [] as string[]);
      if (!root.has(hash) || names.some((name) => name.startsWith(`${hash}.`))) continue;
      await root.remove([hash]);
      written.push(rel(manifest));
    }
    for (const record of (await latestRecords(this.paths)).values()) {
      if (record.removed || record.output !== hash) continue;
      await logTombstone(this.paths, record);
      written.push(rel(this.paths.tasksLog));
    }
    const projectId = project.config.project_id;
    const claim =
      projectId === undefined ? undefined : await removeClaim(this.paths, hash, projectId);
    if (claim !== undefined) removed.push(rel(claim));

    await this.check();
    return { message: forgetPlanMessage(plan, true), written: [...new Set(written)], removed };
  }
}
