/**
 * Where the desktop app opens, and how a first launch gets something to open.
 *
 * `examples/sample` is a read-only **template**. A real run writes ~100 MB of generated art
 * into `vngen/`, and doing that inside the source tree buries `git status` and leaves no way
 * to tell "the sample we ship" from "the copy I've been messing with". So the app seeds a
 * scratch copy with its own git repo — gitignored by the parent, hence not a submodule — and
 * works there.
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '@vn/config';
import { openGit, type Git } from '@vn/git';
import { writeFileAtomic } from '@vn/util';

/**
 * Template entries that are never seeded: `vngen/` is a previous run's output (a fresh
 * workspace has not been run, and pretending otherwise would make the first `run` look like
 * a no-op), `keys/` is secrets, and the rest are machinery.
 */
const SKIP = new Set(['vngen', 'keys', '.git', 'node_modules']);

/** Used only when git can't already answer who the committer is. */
const FALLBACK_IDENTITY = { name: 'VN Studio', email: 'vnstudio@localhost' };

export interface SeedResult {
  root: string;
  /** False when the workspace already existed and was opened untouched. */
  seeded: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open `target`, creating it from `template` on first use. An existing directory is opened
 * **untouched** — never re-copied, never overwritten: it is the user's working copy and it is
 * the only thing between a stray reseed and a day's authoring. Resetting is deleting it.
 */
export async function seedWorkspace(template: string, target: string): Promise<SeedResult> {
  if (await exists(target)) return { root: target, seeded: false };
  if (!(await exists(template))) {
    throw new Error(`cannot seed ${target}: no project template at ${template}`);
  }

  await mkdir(target, { recursive: true });
  for (const entry of await readdir(template)) {
    if (SKIP.has(entry)) continue;
    await cp(join(template, entry), join(target, entry), { recursive: true });
  }

  await ensureRepo(target, 'Sample project inputs');
  return { root: target, seeded: true };
}

/**
 * Bring `root` under version control, committing whatever is already there — "the app
 * initializes a git repository if necessary; it will automatically commit existing files".
 *
 * Idempotent, and it stops at the first question: a directory that is *already* in a work tree
 * is left entirely alone, whether or not it is that tree's root.
 */
export async function ensureRepo(root: string, message = 'Existing project files'): Promise<Git> {
  const git = openGit(root);
  if (await git.isRepo()) return git;

  await git.init();
  // A fresh repo inherits no local identity, and `commit` fails outright without one — but a
  // global identity is the user's own, so only fill in what git can't already answer.
  if (!(await git.configGet('user.email'))) {
    await git.config('user.email', FALLBACK_IDENTITY.email);
    await git.config('user.name', FALLBACK_IDENTITY.name);
  }
  // Same reason testkit sets it: the branch editor patches scene prose byte-exactly.
  await git.config('core.autocrlf', 'false');
  await git.commit({ message, paths: ['-A'] });
  return git;
}

/** What a directory is, before anything is written to it. `openWorkspace`'s read-only twin. */
export interface WorkspaceInspection {
  root: string;
  /** False when the path does not exist, or exists and is not a directory. */
  directory: boolean;
  /** True when a `project.yaml` is already there, whether or not it parses. */
  project: boolean;
  /** Why the existing config is unusable, if it is. Never set when `project` is false. */
  problem?: string;
  title?: string;
}

/**
 * Look at a directory without touching it, so a command can declare what opening it would do
 * — open an existing project, or create one here — before it does either.
 */
export async function inspectWorkspace(root: string): Promise<WorkspaceInspection> {
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) return { root, directory: false, project: false };
  if (!(await exists(join(root, CONFIG_FILENAME)))) {
    return { root, directory: true, project: false };
  }
  try {
    const config = await loadConfig(root);
    return { root, directory: true, project: true, title: config.title };
  } catch (err) {
    return { root, directory: true, project: true, problem: (err as Error).message };
  }
}

export interface OpenResult {
  root: string;
  /** True when this call wrote `project.yaml` — the directory was not a project yet. */
  created: boolean;
  title: string;
}

/**
 * Open the directory the user picked, making it a project if it is not one yet: the shortest
 * honest `project.yaml` (`title` is the only key without a default) and then `ensureRepo`.
 *
 * Not a copy of the template — an empty project is empty. A config that will not parse throws
 * rather than opening, so the failure names the file instead of surfacing three reads later.
 */
export async function openWorkspace(root: string): Promise<OpenResult> {
  const found = await inspectWorkspace(root);
  if (!found.directory) throw new Error(`cannot open ${root}: not a directory`);
  if (found.problem) throw new Error(found.problem);

  const title = found.title ?? basename(root) ?? 'Untitled';
  if (!found.project) {
    await writeFileAtomic(join(root, CONFIG_FILENAME), `title: ${JSON.stringify(title)}\n`);
  }
  await ensureRepo(root, found.project ? 'Existing project files' : 'New project');
  return { root, created: !found.project, title };
}

/** Where the remembered projects live, and how many are kept. */
export const RECENT_KEY = 'workspace.recent';
export const RECENT_MAX = 10;

/**
 * The recents list is in the *global* session store, not a project's own state — it is the one
 * thing that must be readable before any workspace is open. Only this much of `SessionStore` is
 * named, so the helpers stay testable against a plain object.
 */
export interface RecentStore {
  get<T extends string[]>(key: string, fallback: T): T;
  set(key: string, value: string[]): void;
}

export function recentWorkspaces(state: RecentStore): string[] {
  const raw = state.get(RECENT_KEY, [] as string[]);
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : [];
}

/** Move `root` to the front, deduped and capped. Returns the list as it now stands. */
export function rememberWorkspace(state: RecentStore, root: string): string[] {
  const next = [root, ...recentWorkspaces(state).filter((r) => r !== root)].slice(0, RECENT_MAX);
  state.set(RECENT_KEY, next);
  return next;
}
