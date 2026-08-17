/**
 * Where the desktop app opens, and how a first launch gets something to open.
 *
 * `examples/sample` is a read-only **template**. A real run writes ~100 MB of generated art
 * into `vngen/`, and doing that inside the source tree buries `git status` and leaves no way
 * to tell "the sample we ship" from "the copy I've been messing with". So the app seeds a
 * scratch copy with its own git repo — gitignored by the parent, hence not a submodule — and
 * works there.
 */
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '@vn/config';
import { openGit, type Git } from '@vn/git';
import { slug } from '@vn/model';
import { writeFileAtomic } from '@vn/util';
import { LAYOUT_ATTRIBUTES_BLOCK, shippedLayoutFiles } from '../shared/layouts.js';
import { ensureLayouts } from './layouts.js';

/**
 * Template entries that are never seeded: `vngen/` is a previous run's output (a fresh
 * workspace has not been run, and pretending otherwise would make the first `run` look like
 * a no-op), `keys/` is secrets, and the rest are machinery.
 */
const SKIP = new Set(['vngen', 'keys', '.git', 'node_modules']);

/** Used only when git can't already answer who the committer is. */
const FALLBACK_IDENTITY = { name: 'VN Studio', email: 'vnstudio@localhost' };

/**
 * What a project's `.gitignore` starts as. `vngen/` is deliberately **not** here: the generated
 * tree is committed on purpose. `keys` is the load-bearing line — commit-on-save runs
 * `git commit -A`, so a key git can see is committed within the second.
 */
const DEFAULT_IGNORES = ['keys', 'node_modules', '.DS_Store'];

/**
 * Ensure `root/.gitignore` ignores each of `entries`, appending only what is missing and
 * creating the file if there is none. Answers whether it wrote. Lines are compared whole, with
 * a trailing slash normalized away: a substring test would read `keysomething` as `keys`.
 */
export async function ensureIgnored(root: string, entries: string[]): Promise<boolean> {
  const path = join(root, '.gitignore');
  const before = await readFile(path, 'utf8').catch(() => '');
  const have = new Set(before.split(/\r?\n/).map((line) => line.trim().replace(/\/$/, '')));
  const missing = entries.filter((entry) => !have.has(entry.replace(/\/$/, '')));
  if (missing.length === 0) return false;
  const head = before === '' || before.endsWith('\n') ? before : `${before}\n`;
  await writeFileAtomic(path, `${head}${missing.join('\n')}\n`);
  return true;
}

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
  return initRepoAt(root, message);
}

/**
 * `ensureRepo`'s deliberate opposite: initialize a repository **at** `root` whatever encloses it,
 * because "create a new project here" is a request for a project and a project has a repo. A
 * nested one is a thing this codebase already understands — git does not descend into it, and
 * `Workspace.repos()` calls a project owning its own root `owned`, which is what commits it.
 */
export async function initRepoAt(root: string, message: string): Promise<Git> {
  const git = openGit(root);
  await git.init();
  // A fresh repo inherits no local identity, and `commit` fails outright without one — but a
  // global identity is the user's own, so only fill in what git can't already answer.
  if (!(await git.configGet('user.email'))) {
    await git.config('user.email', FALLBACK_IDENTITY.email);
    await git.config('user.name', FALLBACK_IDENTITY.name);
  }
  // Same reason testkit sets it: the branch editor patches scene prose byte-exactly.
  await git.config('core.autocrlf', 'false');
  // Before the first commit, so `keys` is ignored by the time anything can be committed.
  await ensureIgnored(root, DEFAULT_IGNORES);
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
  // Before `ensureRepo`, so a repository being initialized here takes these in its first commit;
  // a repository that already exists gets its own commits below. Either way opening a project
  // must not leave the worktree dirty — the app's open-time checkpoint would otherwise sweep
  // these up under "Changes made outside the app", once, on every author's machine.
  const wroteLayouts = await ensureLayouts(root);
  const wroteAttributes = await ensureGitAttributes(root);
  const fresh = !(await openGit(root).isRepo());
  const git = await ensureRepo(root, found.project ? 'Existing project files' : 'New project');
  if (!fresh) {
    if (wroteAttributes) {
      await git.commit({ message: GITATTRIBUTES_COMMIT, paths: ['.gitattributes'] });
    }
    if (wroteLayouts.length > 0) {
      await git.commit({ message: LAYOUTS_COMMIT, paths: wroteLayouts });
    }
  }
  return { root, created: !found.project, title };
}

/**
 * The same guarantee for a project that is *reached* rather than opened. `openWorkspace` runs on
 * an explicit `workspace.open`, but the ordinary boot path resolves a root from the recents list
 * or `VN_PROJECT` and goes straight to the repos — so this is what reaches a project the author
 * simply reopened, and it is why the attribute is not a create-time-only affair.
 *
 * Commits what it wrote, for the reason `openWorkspace` gives: the app's open-time checkpoint
 * would otherwise sweep this file up under "Changes made outside the app".
 */
export async function adoptGitAttributes(root: string): Promise<boolean> {
  if (!(await ensureGitAttributes(root))) return false;
  const git = openGit(root);
  if (await git.isRepo()) {
    await git.commit({ message: GITATTRIBUTES_COMMIT, paths: ['.gitattributes'] });
  }
  return true;
}

const GITATTRIBUTES_COMMIT = 'Union-merge the notification log';
const LAYOUTS_COMMIT = 'Add the shipped layout templates';

/** The one attribute a project needs from us, and why it needs it. */
const GITATTRIBUTES_LINE = 'vngen/state/notifications.jsonl merge=union';
const GITATTRIBUTES_TEXT =
  '# The notification log is append-only and its read/hidden flags are patched in place.\n' +
  '# Union-merge it: two branches’ notifications combine instead of conflicting, and the\n' +
  '# reader dedupes by id and ORs the flags, so a line that comes back twice folds cleanly.\n' +
  `${GITATTRIBUTES_LINE}\n`;

/**
 * Give an existing project the union-merge attribute it was created without. Idempotent, and it
 * appends rather than writes: a `.gitattributes` is the user's file and may already say plenty.
 *
 * Deliberately *not* carrying this repo's own `* text=auto eol=lf`. `merge` and `text`/`eol` are
 * orthogonal attributes, so the line stands alone — and a project is the author's repository, not
 * somewhere to install our line-ending policy. `initRepoAt` already sets `core.autocrlf=false`.
 */
export async function ensureGitAttributes(root: string): Promise<boolean> {
  const path = join(root, '.gitattributes');
  const current = await readFile(path, 'utf8').catch(() => undefined);
  if (current?.includes(GITATTRIBUTES_LINE)) return false;

  const prefix = current === undefined || current === '' || current.endsWith('\n') ? '' : '\n';
  await writeFile(path, `${current ?? ''}${prefix}${GITATTRIBUTES_TEXT}`);
  return true;
}

/** The one scene a new project starts with — named by `start:` and by the file it lives in. */
export const START_SCENE = 'opening';

/**
 * The files a new project is created with: three that make its model build, the shipped layout
 * templates, and the `.gitattributes` carrying both rules a project needs from us.
 *
 * Not a copy of `examples/sample`: that is somebody else's story, and an author's first ten
 * minutes should not go on deleting a cast. Not nothing either — with no `start:` and no scenes
 * the model builds with error diagnostics, so an empty project greets its author with a red count.
 *
 * The layouts are here rather than left to `ensureLayouts` so they land in the first commit,
 * under the subject that says what they are.
 */
function skeleton(title: string): { path: string; text: string }[] {
  return [
    ...shippedLayoutFiles(),
    { path: '.gitattributes', text: `${GITATTRIBUTES_TEXT}\n${LAYOUT_ATTRIBUTES_BLOCK}` },
    { path: CONFIG_FILENAME, text: `title: ${JSON.stringify(title)}\nstart: ${START_SCENE}\n` },
    {
      path: `scenes/${START_SCENE}.md`,
      text:
        `---\nscene: ${START_SCENE}\n---\n\n` +
        'INT. A ROOM - DAY\n\n' +
        'The story starts here.\n\n' +
        'Write over this, or ask the agent to.\n',
    },
    {
      path: 'wiki/index.md',
      text:
        '# Story bible\n\n' +
        'Everything under `wiki/` is searchable by the authoring agent. One page per subject:\n' +
        'history, factions, rules, whatever the story needs remembered.\n',
    },
  ];
}

/** What creating a project at a path would run into, before anything is written. */
export interface CreateInspection {
  root: string;
  exists: boolean;
  /** False when the path is a file, or is not there at all. */
  directory: boolean;
  /** True when there is nothing here to lose: no such path, or a directory with no entries. */
  empty: boolean;
  /** The repo that already owns this path, if any — commit-on-save will not run here. */
  insideRepo?: string;
}

/**
 * Where a create lands: the folder that was chosen, or a child of it named from the title. The
 * two halves of "choose a parent and type a name" — separated so an OS chooser can answer one
 * and a textbox the other. Slugged, because a title is prose and a folder name is not.
 */
export function createRoot(path: string, title: string, newFolder: boolean): string {
  const base = resolve(path);
  const name = slug(title);
  return newFolder && name ? join(base, name) : base;
}

/** The closest ancestor that exists, so git can be asked about a path that does not yet. */
async function nearestExistingDir(path: string): Promise<string | undefined> {
  let cur = resolve(path);
  for (;;) {
    if ((await stat(cur).catch(() => null))?.isDirectory()) return cur;
    const up = dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

/**
 * Look at where a project would be created without touching it. `exists`/`directory`/`empty`
 * decide whether it may happen at all; `insideRepo` is a warning rather than a refusal, because
 * a project three levels down in a monorepo works — it just never gets committed for you.
 */
export async function inspectCreate(root: string): Promise<CreateInspection> {
  const info = await stat(root).catch(() => null);
  const directory = info?.isDirectory() === true;
  const empty = info === null || (directory && (await readdir(root)).length === 0);
  const near = await nearestExistingDir(root);
  const insideRepo = near ? ((await openGit(near).topLevel()) ?? undefined) : undefined;
  return { root, exists: info !== null, directory, empty, insideRepo };
}

/**
 * Create a project at `root` and open it. Unlike `openWorkspace` this scaffolds: "create a new
 * project here" is an explicit request for a project, and one whose model will not build is a
 * worse answer than three files.
 *
 * The repo is initialized before the open so the first commit is the skeleton under its own
 * subject; `openWorkspace` then finds a `project.yaml` already there and only reads it. It is
 * `initRepoAt` rather than `ensureRepo` because the promise is a repository, not a repository
 * unless something already encloses this one.
 */
export async function createWorkspace(root: string, title: string): Promise<OpenResult> {
  if (!(await inspectCreate(root)).empty) {
    throw new Error(`cannot create a project at ${root}: it is not empty`);
  }

  for (const file of skeleton(title)) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, file.text);
  }
  await initRepoAt(root, 'New project');
  return { ...(await openWorkspace(root)), created: true };
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
