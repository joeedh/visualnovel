/**
 * The disk half of the document tree's file commands: whether the folder exists, whether the
 * name is taken, which repository the path lands in, and the write itself. The path rules are
 * `shared/fileops.ts`'s, run first. Each command's check and run go through the same planner here,
 * so a menu shows the refusal the run would give.
 */
import type { Stats } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { MEDIA_EXTS } from '@vn/commands/snapshot';
import { RepoResolver } from '@vn/git';
import { parseFrontMatter } from '@vn/parse';
import {
  ProjectPaths,
  checkDocWrite,
  discoverCandidates,
  entityIdentity,
  writeDocFile,
  type DocResult,
  type EntityIdentity,
} from '@vn/store';
import { applyFileDelete, planFileDelete } from '@vn/scriptedit/write';
import { sha256, writeFileAtomic } from '@vn/util';
import { snapshotted } from '../../shared/affects.js';
import {
  baseName,
  copyName,
  planCopy,
  planCreate,
  planDelete,
  planMove,
  type FileMove,
} from '../../shared/fileops.js';
import type { DocSaveResult } from '../../shared/ipc.js';
import { relink } from '../doctree/relink.js';
import { fileCache } from '../workspace/filecache.js';
import type { WorkspaceSession } from './core.js';
import { DOC_WRITERS, relPath } from './core.js';

/** Filesystems that treat `a.md` and `A.md` as one name, where a taken name is compared so. */
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin';

const fold = (s: string): string => (FOLDS_CASE ? s.toLowerCase() : s);

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** The media extensions that are pictures, which a refusal calls images. */
const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'ico',
  'psd',
  'svgz',
]);

/** The temp sibling `writeFileAtomic` leaves beside a file, which a snapshot skips. */
const TEMP_SIBLING = /\.tmp-[0-9a-f]+$/;

/** The roots whose markdown can link to a moved file and have its links rewritten. */
const LINKING_ROOTS = ['wiki', 'characters', 'locations'];

/** The roots entity discovery reads, where a moved `.md` can gain or lose an identity. */
const IDENTITY_ROOTS = ['wiki', 'characters', 'locations'];

const rootOfPath = (path: string): string => path.split('/')[0] ?? '';

const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

const isMarkdown = (path: string): boolean => path.toLowerCase().endsWith('.md');

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** Where a new item goes, once every rule shared by a new file and a new folder has passed. */
interface Placed {
  parent: string;
  path: string;
  abs: string;
}

/** Whether a transfer leaves its sources where they were. */
export type TransferMode = 'move' | 'copy';

/** One item a transfer carries, a file or a folder, with both ends absolute as well. */
interface Item extends FileMove {
  src: string;
  dest: string;
  /** Source-relative paths of the files it holds: `['']` for a file itself. */
  files: string[];
}

/** A transfer every rule has accepted, ready to run. */
interface TransferPlan {
  mode: TransferMode;
  /** A move into the folder the one item is already in, under a new name. */
  renamed: boolean;
  into: string;
  items: Item[];
  /** Every file the items carry, workspace-relative at both ends. */
  files: FileMove[];
  note: string;
}

/** What a finished transfer did. */
export interface TransferResult {
  moves: FileMove[];
  /** Files whose links were rewritten, at their paths after the transfer. */
  relinked: string[];
  written: string[];
  message: string;
}

/** A file whose links a transfer rewrote, with the bytes to put back if the transfer fails. */
interface Rewrite {
  path: string;
  abs: string;
  before: Buffer;
}

/** Joins paths as a prose list: `a`, `a and b`, `a, b and c`. */
function listed(paths: readonly string[]): string {
  if (paths.length <= 1) return paths.join('');
  return `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]}`;
}

/** Describes a transfer in one clause, such as `Moves wiki/a.md to wiki/lore/a.md`. */
function summary(verb: string, items: readonly FileMove[], into: string): string {
  if (items.length === 1) return `${verb} ${items[0]!.from} to ${items[0]!.to}`;
  return `${verb} ${listed(items.map((item) => item.from))} into ${into}`;
}

export class FilesPart {
  constructor(private readonly session: WorkspaceSession) {}

  /**
   * Runs before each item is placed and before each rewritten file is written, and does nothing.
   * Tests replace it to fail a transfer part way through and check that it is rolled back.
   */
  step: (stage: 'place' | 'relink', path: string) => Promise<void> = () => Promise.resolve();

  /**
   * Why a write under `path` would reach no history, or undefined. A submodule that is not
   * checked out is an empty directory inside the project's own repository, so only the flag
   * `repos()` reports can tell it apart.
   */
  private async missingRepo(path: string): Promise<string | undefined> {
    for (const repo of await this.session.gitRepos()) {
      if (!repo.missing) continue;
      const rel = relPath(this.session.dir, repo.root);
      if (path === rel || path.startsWith(`${rel}/`)) {
        return (
          `${rel}/ is a submodule that is not checked out, so nothing written there would be in ` +
          'any history. Run `git submodule update --init` first.'
        );
      }
    }
    return undefined;
  }

  /** Why `folder` cannot receive anything: it is not there, it is a file, or it reaches no history. */
  private async folderProblem(folder: string): Promise<string | undefined> {
    const found = await stat(join(this.session.dir, folder)).catch(() => null);
    if (!found) return `no such folder: ${folder}`;
    if (!found.isDirectory()) return `${folder} is a file, not a folder.`;
    return this.missingRepo(folder);
  }

  /** The rules a new file and a new folder share: the path, the folder, the repository, the name. */
  private async place(parent: string, name: string): Promise<DocResult<Placed>> {
    const plan = planCreate(parent, name);
    if (!plan.ok) return plan;
    const problem = await this.folderProblem(plan.parent);
    if (problem) return refuse(problem);
    const dir = join(this.session.dir, plan.parent);
    const taken = (await readdir(dir)).find((entry) => fold(entry) === fold(name));
    if (taken !== undefined) return refuse(`${plan.parent} already holds ${taken}.`);
    return { ok: true, parent: plan.parent, path: plan.path, abs: join(dir, name) };
  }

  /** What `doc.mkdir` would do, decided without writing. */
  async previewMkdir(parent: string, name: string): Promise<DocResult<{ note: string }>> {
    const placed = await this.place(parent, name);
    return placed.ok ? { ok: true, note: `Creates the folder ${placed.path}.` } : placed;
  }

  /** Creates one empty folder. */
  async mkdir(parent: string, name: string): Promise<DocResult<{ path: string }>> {
    const placed = await this.place(parent, name);
    if (!placed.ok) return placed;
    await mkdir(placed.abs);
    return { ok: true, path: placed.path };
  }

  /**
   * Everything `doc.newFile` checks before writing: the shared rules, then the two that are
   * about a file. An extension undo does not keep is refused, because undo would leave the file
   * behind. So is a path discovery would read as a sheet, because an empty sheet is an entity with
   * no fields.
   */
  private async planFile(parent: string, name: string): Promise<DocResult<Placed>> {
    const placed = await this.place(parent, name);
    if (!placed.ok) return placed;
    const ext = extOf(name);
    if (MEDIA_EXTS.has(ext)) {
      return refuse(
        `Undo does not keep .${ext} files, so the app does not create one; an empty .${ext} ` +
          'would not open as one anyway.',
      );
    }
    const identity = entityIdentity(placed.path, {});
    if (identity) {
      return refuse(
        `${placed.path} would be the sheet for ${identity.kind} ${identity.id}, and an empty ` +
          `sheet is a ${identity.kind} with no fields. Use New ${identity.kind} sheet… instead.`,
      );
    }
    return placed;
  }

  /** What `doc.newFile` would do, decided without writing. */
  async previewNewFile(parent: string, name: string): Promise<DocResult<{ note: string }>> {
    const placed = await this.planFile(parent, name);
    if (!placed.ok) return placed;
    const write = await checkDocWrite(this.session.dir, placed.path, '', '', DOC_WRITERS);
    if (!write.ok) return write;
    const unlisted =
      placed.path.startsWith('wiki/') && !name.toLowerCase().endsWith('.md')
        ? ` ${name} is not markdown, so the Wiki branch will not list it.`
        : '';
    return { ok: true, note: `Creates the empty file ${placed.path}.${unlisted}` };
  }

  /** Creates one empty file, through the same write a saved document takes. */
  async newFile(parent: string, name: string): Promise<DocResult<DocSaveResult>> {
    const placed = await this.planFile(parent, name);
    if (!placed.ok) return placed;
    const written = await writeDocFile(this.session.dir, placed.path, '', '', DOC_WRITERS);
    if (!written.ok) return written;
    await fileCache.note(written.file, '');
    return { ok: true, path: written.path, hash: written.hash, bytes: written.bytes };
  }

  /**
   * Why undo could not hold `path` and everything under it, or the files it holds. Undo's snapshot
   * skips media, links and other non-regular files, `.git`, `node_modules` and an atomic write's
   * temp sibling, so a restore would leave any of them behind at the destination. It also has no
   * entry for an empty folder, so a folder that holds files and also an empty folder is refused:
   * undo would move the files back and leave the empty folder, and its parent, where they were put.
   */
  private async holdable(
    path: string,
    info: Stats,
  ): Promise<{ files: string[] } | { reason: string }> {
    const outside = (what: string, plural: string): { reason: string } => ({
      reason: `${what}. Undo does not keep ${plural}, so the app does not move or copy them; move it outside the app.`,
    });
    const file = (rel: string, name: string): { reason: string } | undefined => {
      const ext = extOf(name);
      if (IMAGE_EXTS.has(ext)) return outside(`${rel} is an image`, 'images');
      if (MEDIA_EXTS.has(ext)) return outside(`${rel} is a .${ext} file`, `.${ext} files`);
      if (TEMP_SIBLING.test(name)) {
        return {
          reason: `${rel} is a temporary file left by an interrupted save. Delete it outside the app first.`,
        };
      }
      return undefined;
    };
    if (!snapshotted(path)) return outside(`${path} is outside what undo snapshots`, 'those paths');
    if (info.isSymbolicLink()) return outside(`${path} is a symbolic link`, 'links');
    if (info.isFile()) {
      const problem = file(path, baseName(path));
      return problem ?? { files: [''] };
    }
    if (!info.isDirectory()) return outside(`${path} is not an ordinary file`, 'such files');

    const files: string[] = [];
    const empty: string[] = [];
    const walk = async (rel: string): Promise<{ reason: string } | number> => {
      const abs = join(this.session.dir, path, rel);
      let held = 0;
      for (const entry of await readdir(abs, { withFileTypes: true })) {
        const inner = rel === '' ? entry.name : `${rel}/${entry.name}`;
        const shown = `${path}/${inner}`;
        if (entry.name === '.git') {
          return outside(`${shown} is a git repository's own folder`, 'repositories');
        }
        if (entry.name === 'node_modules')
          return outside(`${shown} is a node_modules folder`, 'node_modules folders');
        if (entry.isSymbolicLink()) return outside(`${shown} is a symbolic link`, 'links');
        if (entry.isDirectory()) {
          const below = await walk(inner);
          if (typeof below !== 'number') return below;
          if (below === 0) empty.push(shown);
          held += below;
        } else if (entry.isFile()) {
          const problem = file(shown, entry.name);
          if (problem) return problem;
          files.push(inner);
          held++;
        } else return outside(`${shown} is not an ordinary file`, 'such files');
      }
      return held;
    };
    const walked = await walk('');
    if (typeof walked !== 'number') return walked;
    const hollow = empty.find((dir) => !empty.some((other) => dir.startsWith(`${other}/`)));
    if (files.length > 0 && hollow !== undefined) {
      return {
        reason:
          `${hollow} is an empty folder. Undo does not keep empty folders, so undoing this would ` +
          'leave it behind; put a file in it, or remove it outside the app, first.',
      };
    }
    return { files };
  }

  /**
   * Why the sources and `into` cannot be moved or copied between: they are in different git
   * repositories. Two paths in no repository count as the same one.
   */
  private async repoProblem(items: readonly Item[], into: string): Promise<string | undefined> {
    const resolver = new RepoResolver();
    const target = await resolver.rootOf(join(this.session.dir, into));
    const home = await resolver.rootOf(this.session.dir);
    for (const item of items) {
      const root = await resolver.rootOf(item.src);
      if (root === target) continue;
      const nested = [root, target].find((r) => r !== null && r !== home) ?? root ?? target!;
      const own = relPath(this.session.dir, nested);
      return (
        `${item.from} and ${into}/ are in different git repositories (${own}/ is a repository ` +
        'of its own). Moving or copying between repositories is not supported in the app, ' +
        `because the file's history would stay in one and other projects sharing ${own}/ would ` +
        'see it vanish.'
      );
    }
    return undefined;
  }

  /**
   * Why the transfer would change which characters and locations the project has, or undefined.
   * A moved sheet must keep the identity discovery gives it now, compared against discovery's
   * candidates rather than re-derived, so a losing duplicate keeps its identity too. A copy must
   * have none, since it would be a second sheet.
   */
  private async identityProblem(
    plan: Pick<TransferPlan, 'mode' | 'items' | 'files'>,
    name: string,
  ): Promise<string | undefined> {
    const relevant = plan.files.filter(
      (f) =>
        (isMarkdown(f.from) || isMarkdown(f.to)) &&
        [f.from, f.to].some((p) => IDENTITY_ROOTS.includes(rootOfPath(p))),
    );
    if (relevant.length === 0) return undefined;
    const now = new Map<string, EntityIdentity>();
    if (plan.mode === 'move') {
      for (const found of await discoverCandidates(new ProjectPaths(this.session.dir), [])) {
        now.set(relPath(this.session.dir, found.doc.file), { kind: found.kind, id: found.doc.id });
      }
    }
    const same = (a?: EntityIdentity, b?: EntityIdentity): boolean =>
      a?.kind === b?.kind && a?.id === b?.id;
    for (const file of relevant) {
      const item = plan.items.find(
        (i) => file.from === i.from || file.from.startsWith(`${i.from}/`),
      )!;
      const data = await this.frontMatter(join(this.session.dir, file.from));
      const after = data === undefined ? undefined : entityIdentity(file.to, data);
      if (plan.mode === 'copy') {
        if (!after) continue;
        const source = data === undefined ? undefined : entityIdentity(file.from, data);
        return source
          ? `${file.from} is the sheet for ${source.kind} ${source.id}, so a copy would be a second ` +
              `${source.kind} sheet. Copy its text into a new sheet instead.`
          : `A copy of ${file.from} at ${file.to} would be the sheet for ${after.kind} ${after.id}, ` +
              `a ${after.kind} the project does not have now.`;
      }
      const before = now.get(file.from);
      if (same(before, after)) continue;
      if (before && name !== '' && item.from === file.from) {
        return (
          `${file.from} is the sheet for ${before.kind} ${before.id}, and its file name is the id ` +
          `shots and cast lists use. Renaming the file would make a different ${before.kind}. ` +
          'Double-click it in the tree to change the name it is shown under.'
        );
      }
      if (before) {
        return `Moving ${item.from} would change ${before.kind} ${before.id}'s id, which shots and cast lists use.`;
      }
      return (
        `Moving ${file.from} to ${file.to} would make it the sheet for ${after!.kind} ` +
        `${after!.id}, a ${after!.kind} the project does not have now.`
      );
    }
    return undefined;
  }

  /** A file's front-matter, or undefined when it will not parse, which discovery also skips. */
  private async frontMatter(abs: string): Promise<Record<string, unknown> | undefined> {
    try {
      return parseFrontMatter(await readFile(abs, 'utf8')).data;
    } catch {
      return undefined;
    }
  }

  /**
   * Every rule a move or a copy must pass, run by the check and by the run alike. It reads only
   * the named paths, the subtrees under them, `into`'s listing, and the front-matter of the
   * markdown among them; a move of a markdown file in `wiki/`, `characters/` or `locations/` also
   * runs entity discovery, because main holds no loaded project to compare against.
   */
  private async planTransfer(
    paths: readonly string[],
    into: string,
    mode: TransferMode,
    name: string,
  ): Promise<DocResult<TransferPlan>> {
    const planned = mode === 'move' ? planMove(paths, into, name) : planCopy(paths, into);
    if (!planned.ok) return planned;
    const folderProblem = await this.folderProblem(planned.into);
    if (folderProblem) return refuse(folderProblem);

    const items: Item[] = [];
    for (const move of planned.moves) {
      const src = join(this.session.dir, move.from);
      const info = await lstat(src).catch(() => null);
      if (!info) return refuse(`no such file: ${move.from}`);
      const held = await this.holdable(move.from, info);
      if ('reason' in held) return refuse(held.reason);
      items.push({ ...move, src, dest: '', files: held.files });
    }

    const listing = await readdir(join(this.session.dir, planned.into));
    const taken = new Set(listing.map(fold));
    for (const item of items) {
      const wanted = baseName(item.to);
      if (mode === 'copy') {
        const free = copyName(wanted, !item.files.includes(''), (n) => taken.has(fold(n)));
        item.to = `${planned.into}/${free}`;
        taken.add(fold(free));
      } else if (taken.has(fold(wanted))) {
        const holder = listing.find((entry) => fold(entry) === fold(wanted));
        return refuse(`${planned.into} already holds ${holder}.`);
      }
      item.dest = join(this.session.dir, item.to);
    }

    const repo = await this.repoProblem(items, planned.into);
    if (repo) return refuse(repo);

    const files = items.flatMap((item) =>
      item.files.map((rel) =>
        rel === ''
          ? { from: item.from, to: item.to }
          : { from: `${item.from}/${rel}`, to: `${item.to}/${rel}` },
      ),
    );
    const identity = await this.identityProblem({ mode, items, files }, name);
    if (identity) return refuse(identity);

    const renamed = name !== '' && folderOf(items[0]!.from) === planned.into;
    const verb = mode === 'copy' ? 'Copies' : renamed ? 'Renames' : 'Moves';
    const stops = files.find(
      (f) => isMarkdown(f.from) && !isMarkdown(f.to) && f.to.startsWith('wiki/'),
    );
    const unlisted = stops
      ? ` ${baseName(stops.to)} is not markdown, so the Wiki branch will stop listing it.`
      : '';
    const note = `${summary(verb, items, planned.into)}.${unlisted}`;
    return { ok: true, mode, renamed, into: planned.into, items, files, note };
  }

  /** What `doc.move` or `doc.copy` would do, decided without writing. */
  async previewTransfer(
    paths: readonly string[],
    into: string,
    mode: TransferMode,
    name = '',
  ): Promise<DocResult<{ note: string }>> {
    const plan = await this.planTransfer(paths, into, mode, name);
    return plan.ok ? { ok: true, note: plan.note } : plan;
  }

  /**
   * Moves or copies files and folders into `into`, then rewrites relative links: in every
   * markdown file under `wiki/`, `characters/` and `locations/` that points at a moved file, and
   * in each moved or copied markdown file itself. Nothing under `archive/` is rewritten. Every
   * destination file gets a fresh mtime, because undo's store trusts a matching `(mtime, size)`
   * at a path and a renamed file keeps its own. If any step fails, everything done so far is put
   * back before the error is thrown, since a failed command leaves no undo point.
   */
  async transfer(
    paths: readonly string[],
    into: string,
    mode: TransferMode,
    name = '',
  ): Promise<DocResult<TransferResult>> {
    const plan = await this.planTransfer(paths, into, mode, name);
    if (!plan.ok) return plan;
    const placed: Item[] = [];
    const rewrites: Rewrite[] = [];
    let relinked: string[];
    try {
      for (const item of plan.items) {
        await this.step('place', item.to);
        if (mode === 'move') await rename(item.src, item.dest);
        else await cp(item.src, item.dest, { recursive: true, errorOnExist: true, force: false });
        placed.push(item);
      }
      const now = new Date();
      for (const file of plan.files) await utimes(join(this.session.dir, file.to), now, now);
      relinked = await this.relinkAll(plan, rewrites);
    } catch (err) {
      return this.rollBack(mode, placed, rewrites, err);
    }

    const moves = plan.items.map(({ from, to }) => ({ from, to }));
    const written = [
      ...(mode === 'move' ? [...moves.map((m) => m.from), ...plan.files.map((f) => f.from)] : []),
      ...plan.files.map((f) => f.to),
      ...relinked,
    ];
    const verb = mode === 'copy' ? 'Copied' : plan.renamed ? 'Renamed' : 'Moved';
    const links =
      relinked.length === 0
        ? ''
        : `; updated links in ${relinked.length} document${relinked.length === 1 ? '' : 's'}`;
    return {
      ok: true,
      moves,
      relinked,
      written: [...new Set(written)],
      message: `${summary(verb, moves, plan.into)}${links}.`,
    };
  }

  /**
   * Runs every rule a delete must pass, for the check and the run alike: the app's own path rules
   * (a skill's path, an unchecked-out submodule), then `planFileDelete`, which `vnauthor` runs too.
   * Pictures and other media are allowed, and `kept` says that undo does not bring them back.
   */
  private async planDeletion(
    paths: readonly string[],
  ): Promise<DocResult<{ items: string[]; files: string[]; summary: string; kept: string }>> {
    const planned = planDelete(paths);
    if (!planned.ok) return planned;
    for (const item of planned.items) {
      const missing = await this.missingRepo(item);
      if (missing) return refuse(missing);
    }
    const plan = await planFileDelete(new ProjectPaths(this.session.dir), planned.items);
    if (!plan.ok) return plan;

    const media = plan.files.filter(
      (file) => MEDIA_EXTS.has(extOf(file)) || IMAGE_EXTS.has(extOf(file)),
    );
    const what = plan.items.length === 1 ? plan.items[0]! : listed(plan.items);
    const count = plan.files.length === 1 ? '1 file' : `${plan.files.length} files`;
    const more = media.length > 5 ? ` and ${media.length - 5} more` : '';
    const kept =
      media.length === 0
        ? ''
        : `Undo does not bring back ${listed(media.slice(0, 5))}${more}; only git history can.`;
    return { ok: true, items: plan.items, files: plan.files, summary: `${what} (${count})`, kept };
  }

  /** Decides what `doc.delete` would do, without deleting. */
  async previewDelete(paths: readonly string[]): Promise<DocResult<{ note: string }>> {
    const plan = await this.planDeletion(paths);
    if (!plan.ok) return plan;
    return { ok: true, note: [`Deletes ${plan.summary}.`, plan.kept].filter(Boolean).join('\n') };
  }

  /** Deletes files and folders, answering every path that went. */
  async deleteFiles(
    paths: readonly string[],
  ): Promise<DocResult<{ deleted: string[]; written: string[]; message: string }>> {
    const plan = await this.planDeletion(paths);
    if (!plan.ok) return plan;
    await applyFileDelete(this.session.dir, { ok: true, items: plan.items, files: plan.files });
    return {
      ok     : true,
      deleted: plan.items,
      written: [...new Set([...plan.items, ...plan.files])],
      message: `Deleted ${plan.summary}.`,
    };
  }

  /**
   * Rewrites the links a transfer broke, and answers the files it rewrote. Every file is read and
   * rewritten in memory first; each is then written only if it still hashes to what was read.
   * The bytes are written as they are, not through `writeDocFile`, so a note with broken
   * front-matter or an oversized file cannot block a move.
   */
  private async relinkAll(plan: TransferPlan, rewrites: Rewrite[]): Promise<string[]> {
    const moves = plan.items.map(({ from, to }) => ({ from, to }));
    const archived = (path: string): boolean => rootOfPath(path) === 'archive';
    const docs: { oldPath: string; newPath: string }[] = plan.files
      .filter((f) => isMarkdown(f.to) && !archived(f.from) && !archived(f.to))
      .map((f) => ({ oldPath: f.from, newPath: f.to }));
    if (plan.mode === 'move') {
      const placed = new Set(plan.files.map((f) => f.to));
      for (const root of LINKING_ROOTS) {
        for (const path of await this.markdownUnder(root)) {
          if (!placed.has(path)) docs.push({ oldPath: path, newPath: path });
        }
      }
    }

    const pending: (Rewrite & { hash: string; after: string })[] = [];
    for (const { oldPath, newPath } of docs) {
      const abs = join(this.session.dir, newPath);
      const before = await readFile(abs);
      const text = before.toString('utf8');
      // A file that is not UTF-8 would not survive the round trip through a string
      if (!Buffer.from(text, 'utf8').equals(before)) continue;
      const done = relink(oldPath, newPath, text, moves);
      if (done.count === 0) continue;
      pending.push({ path: newPath, abs, before, hash: sha256(before), after: done.text });
    }
    for (const doc of pending) {
      await this.step('relink', doc.path);
      if (sha256(await readFile(doc.abs)) !== doc.hash) {
        throw new Error(
          `${doc.path} changed while its links were being rewritten, so nothing was moved.`,
        );
      }
      await writeFileAtomic(doc.abs, doc.after);
      rewrites.push(doc);
      await fileCache.note(doc.abs, doc.after);
    }
    return pending.map((doc) => doc.path);
  }

  /** Every `.md` file under one of the linking roots, workspace-relative, skipping `.git` and `node_modules`. */
  private async markdownUnder(root: string): Promise<string[]> {
    const out: string[] = [];
    const visit = async (rel: string): Promise<void> => {
      const entries = await readdir(join(this.session.dir, rel), { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const inner = `${rel}/${entry.name}`;
        if (entry.isDirectory()) await visit(inner);
        else if (entry.isFile() && isMarkdown(entry.name)) out.push(inner);
      }
    };
    await visit(root);
    return out;
  }

  /**
   * Puts back what a failed transfer did, newest first: rewritten files get their old bytes,
   * then moved items go back and copies are removed. Throws the transfer's own error, naming the
   * paths left behind when putting something back failed too.
   */
  private async rollBack(
    mode: TransferMode,
    placed: Item[],
    rewrites: Rewrite[],
    err: unknown,
  ): Promise<never> {
    const left: string[] = [];
    for (const doc of [...rewrites].reverse()) {
      try {
        await writeFileAtomic(doc.abs, doc.before);
        await fileCache.note(doc.abs, doc.before.toString('utf8'));
      } catch {
        left.push(doc.path);
      }
    }
    for (const item of [...placed].reverse()) {
      try {
        if (mode === 'move') await rename(item.dest, item.src);
        else await rm(item.dest, { recursive: true, force: true });
      } catch {
        left.push(item.to);
      }
    }
    if (left.length === 0) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message} Putting things back failed too, so these are left where the run put them: ${left.join(', ')}.`,
    );
  }
}
