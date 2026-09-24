/**
 * The disk half of the document tree's file commands: whether the folder exists, whether the
 * name is taken, which repository the path lands in, and the write itself. The path rules are
 * `shared/fileops.ts`'s, run first. Each command's check and run go through the same planner here,
 * so a menu shows the refusal the run would give.
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MEDIA_EXTS } from '@vn/commands/snapshot';
import { checkDocWrite, entityIdentity, writeDocFile, type DocResult } from '@vn/store';
import { planCreate } from '../../shared/fileops.js';
import type { DocSaveResult } from '../../shared/ipc.js';
import { fileCache } from '../workspace/filecache.js';
import type { WorkspaceSession } from './core.js';
import { DOC_WRITERS, relPath } from './core.js';

/** Filesystems that treat `a.md` and `A.md` as one name, where a taken name is compared so. */
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin';

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** Where a new item goes, once every rule shared by a new file and a new folder has passed. */
interface Placed {
  parent: string;
  path: string;
  abs: string;
}

export class FilesPart {
  constructor(private readonly session: WorkspaceSession) {}

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

  /** The rules a new file and a new folder share: the path, the folder, the repository, the name. */
  private async place(parent: string, name: string): Promise<DocResult<Placed>> {
    const plan = planCreate(parent, name);
    if (!plan.ok) return plan;
    const dir = join(this.session.dir, plan.parent);
    const found = await stat(dir).catch(() => null);
    if (!found) return refuse(`no such folder: ${plan.parent}`);
    if (!found.isDirectory()) return refuse(`${plan.parent} is a file, not a folder.`);
    const missing = await this.missingRepo(plan.path);
    if (missing) return refuse(missing);
    const fold = (s: string): string => (FOLDS_CASE ? s.toLowerCase() : s);
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
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
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
}
