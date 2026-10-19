/**
 * The rule behind `doc.delete` and the agent's `delete_files`: which files and folders a delete may
 * remove, decided against the disk. Both hosts run it, so a sheet is refused in the same sentence
 * wherever the delete is asked for. What only one host can know stays with that host: the desktop
 * refuses a skill's own path and an unchecked-out submodule before it asks here.
 */
import { lstat, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { discoverCandidates, type EntityIdentity, type ProjectPaths } from '@vn/store';
import { rootProblem } from '@vn/types';

/** A delete every rule has accepted. Paths are workspace-relative. */
export interface FileDeletePlan {
  ok: true;
  /** What is removed: each path given, less any inside another one given. */
  items: string[];
  /** Every file the items hold, a file item being its own. */
  files: string[];
}

export type FileDelete = FileDeletePlan | { ok: false; reason: string };

const trimPath = (path: string): string =>
  path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** Whether `path` is `folder` or inside it, compared without regard to letter case. */
const within = (path: string, folder: string): boolean => {
  const p = path.toLowerCase();
  const f = folder.toLowerCase();
  return p === f || p.startsWith(`${f}/`);
};

/**
 * Lists the files under a folder, workspace-relative. Answers a refusal instead when the folder
 * holds a git repository's own folder, which cannot be deleted here.
 */
async function filesUnder(root: string, folder: string): Promise<string[] | string> {
  const out: string[] = [];
  const visit = async (rel: string): Promise<string | undefined> => {
    for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
      const inner = `${rel}/${entry.name}`;
      if (entry.name === '.git') {
        return `${inner} is a git repository's own folder; delete a repository outside the app.`;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const problem = await visit(inner);
        if (problem) return problem;
      } else out.push(inner);
    }
    return undefined;
  };
  return (await visit(folder)) ?? out;
}

/**
 * Decides a delete of `paths`, removing nothing. Every path must be an item under the file roots
 * that exists; a path inside another one given is dropped, since that folder carries it. A
 * character or location sheet, or a folder holding one, is refused by name, because deleting the
 * file alone would leave every reference to the entity pointing at nothing. `deleter` names what
 * deletes an entity in the asking host: a command, or an agent tool.
 */
export async function planFileDelete(
  paths: ProjectPaths,
  given: readonly string[],
  deleter: (kind: string) => string = (kind) => `${kind}.delete`,
): Promise<FileDelete> {
  const refuse = (reason: string): FileDelete => ({ ok: false, reason });
  const listed = [...new Set(given.map(trimPath))];
  if (listed.length === 0) return refuse('Name at least one file or folder to delete.');
  for (const path of listed) {
    const problem = rootProblem(path, 'item');
    if (problem) return refuse(problem);
  }
  const items = listed.filter(
    (path) => !listed.some((other) => other !== path && within(path, other)),
  );

  const sheets = new Map<string, EntityIdentity>();
  for (const found of await discoverCandidates(paths, [])) {
    const rel = relative(paths.root, found.doc.file).replace(/\\/g, '/');
    sheets.set(rel, { kind: found.kind, id: found.doc.id });
  }

  const files: string[] = [];
  for (const item of items) {
    const info = await lstat(join(paths.root, item)).catch(() => null);
    if (!info) return refuse(`no such file: ${item}`);
    const held = info.isDirectory() ? await filesUnder(paths.root, item) : [item];
    if (typeof held === 'string') return refuse(held);
    for (const file of held) {
      const sheet = sheets.get(file);
      if (sheet) {
        const where = file === item ? `${item} is` : `${item} holds ${file}, which is`;
        return refuse(
          `${where} the sheet for ${sheet.kind} ${sheet.id}. Delete it with ` +
            `${deleter(sheet.kind)}, which also rewrites what refers to ${sheet.id}.`,
        );
      }
      files.push(file);
    }
  }
  return { ok: true, items, files };
}

/** Removes what a plan names. */
export async function applyFileDelete(root: string, plan: FileDeletePlan): Promise<void> {
  for (const item of plan.items) await rm(join(root, item), { recursive: true, force: true });
}
