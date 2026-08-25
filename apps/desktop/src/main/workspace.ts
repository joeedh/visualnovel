/**
 * Where the desktop app opens, and how a first launch gets something to open.
 *
 * `templates/basic` is a read-only template. A real run writes about 100 MB of generated art
 * into `vngen/`, and doing that inside the source tree buries `git status` and leaves no way to
 * tell the shipped sample from a modified copy. The app seeds a scratch copy with its own git
 * repo (gitignored by the parent, so it is not a submodule) and works there.
 */
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '@vn/config';
import { openGit, type Git } from '@vn/git';
import { slug } from '@vn/model';
import { writeFileAtomic } from '@vn/util';
import { LAYOUT_ATTRIBUTES_BLOCK, shippedLayoutFiles } from '../shared/layouts.js';
import { gitHealth } from './doctor.js';
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
 * The remembered window arrangement, ignored rather than committed. It changes on every border
 * drag, so tracking it would churn `git status`, conflict on every pull, and make `UndoJournal`
 * refuse an undo because `Git.writeTree` runs `git add -A` and would see it move. The glob also
 * covers the `.tmp-<hex>` sibling `writeFileAtomic` leaves beside a file mid-write.
 */
export const SESSION_IGNORE = '.vnstudio/session.json*';

/**
 * What an undo snapshot covers: the authored documents, and nothing the pipeline generated.
 * `build/` is content-addressed and `state/` is an append-only log — rolling either back would
 * throw away work a later run has to pay for again, and excluding them is also what keeps a
 * `pipeline.run` between two edits from reading as workspace drift.
 *
 * `SESSION_IGNORE` is what keeps the session file out, rather than a fourth entry here.
 * `git add -A` fails outright when a pathspec names an ignored file, and an exclude pathspec
 * counts as naming one, so listing the session file would make every snapshot throw and leave
 * no undo point at all.
 */
export const UNDO_PATHS = ['.', ':(exclude)vngen/build', ':(exclude)vngen/state'];

/**
 * What a project's `.gitignore` starts as. `vngen/` is deliberately absent, because the generated
 * tree is committed on purpose. `keys` is the load-bearing line: commit-on-save runs
 * `git commit -A`, so a key git can see is committed within the second.
 */
const DEFAULT_IGNORES = ['keys', 'node_modules', '.DS_Store', SESSION_IGNORE];

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

/** What a scaffolding pass wrote, so the commit half knows which commits there are to make. */
export interface Scaffolding {
  attributes: boolean;
  ignores: boolean;
  /** Workspace-relative paths of the layout templates that were written. */
  layouts: string[];
}

/**
 * Write the files a project needs from this app: the shipped layout templates, the union-merge
 * attribute, and the ignore line for the session file. Idempotent, and it writes whatever repo
 * encloses `root` — the files belong to the project either way, and only committing them is
 * somebody else's business.
 */
export async function writeScaffolding(root: string): Promise<Scaffolding> {
  return {
    layouts: await ensureLayouts(root),
    attributes: await ensureGitAttributes(root),
    ignores: await ensureIgnored(root, [SESSION_IGNORE]),
  };
}

/**
 * Commit what `writeScaffolding` wrote, one subject each. Does nothing unless the repository is
 * the project's own, on the grounds `ownsRepo` gives.
 *
 * Committing is not optional: opening a project must not leave the worktree dirty, or the
 * open-time checkpoint sweeps these files up under "Changes made outside the app".
 */
export async function commitScaffolding(root: string, wrote: Scaffolding): Promise<void> {
  if (!(await ownsRepo(root))) return;
  const git = openGit(root);
  if (wrote.attributes)
    await git.commit({ message: GITATTRIBUTES_COMMIT, paths: ['.gitattributes'] });
  if (wrote.layouts.length > 0) await git.commit({ message: LAYOUTS_COMMIT, paths: wrote.layouts });
  if (wrote.ignores) await git.commit({ message: IGNORES_COMMIT, paths: ['.gitignore'] });
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
 * untouched: never re-copied, never overwritten, because it is the user's working copy and a
 * stray reseed would cost a day's authoring. Resetting a workspace means deleting the directory.
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
 * Idempotent. A directory already inside a work tree is left alone, whether or not it is that
 * tree's root.
 */
export async function ensureRepo(root: string, message = 'Existing project files'): Promise<Git> {
  const git = openGit(root);
  if (await git.isRepo()) return git;
  // Without git (`./doctor.ts`) `init` is the first spawn that throws rather than answering false,
  // and it runs before any window exists. Returning the handle instead lets the app open: reads
  // answer "not a repo", writes refuse, and a notification says why saving does not work
  if (!gitHealth().ok) return git;
  return initRepoAt(root, message);
}

/**
 * Whether the repository containing `root` belongs to the project itself, rather than one the
 * project merely sits inside — `RepoRef.owned`, asked of a single directory and without loading
 * a model.
 *
 * Scaffolding may write into a foreign work tree, because the file belongs to the project either
 * way. It must not commit there, on the grounds `openRepos()` gives: that history belongs to
 * somebody else. False for a directory in no work tree at all, which has no history to write to.
 */
export async function ownsRepo(root: string): Promise<boolean> {
  const top = await openGit(root).topLevel();
  return top !== null && resolve(top) === resolve(root);
}

/**
 * Initialize a repository at `root` whatever encloses it, because creating a new project here is
 * a request for a project and a project has a repo. A nested repository is understood elsewhere in
 * this codebase: git does not descend into it, and `Workspace.repos()` calls a project owning its
 * own root `owned`, which is what commits it. Unlike `ensureRepo`, this throws when git is missing,
 * because the caller asked for a repository rather than taking a precaution.
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
  // The branch editor patches scene prose byte-exactly, so line endings must not be rewritten
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
 * Nothing is copied from the template, so a project created this way starts empty. A config that
 * will not parse throws rather than opening, so the failure names the file instead of surfacing
 * three reads later.
 */
export async function openWorkspace(root: string): Promise<OpenResult> {
  const found = await inspectWorkspace(root);
  if (!found.directory) throw new Error(`cannot open ${root}: not a directory`);
  if (found.problem) throw new Error(found.problem);

  const title = found.title ?? basename(root) ?? 'Untitled';
  if (!found.project) {
    await writeFileAtomic(join(root, CONFIG_FILENAME), `title: ${JSON.stringify(title)}\n`);
  }
  // Before `ensureRepo`, so a repository initialized here takes these in its first commit.
  const wrote = await writeScaffolding(root);
  const fresh = !(await openGit(root).isRepo());
  await ensureRepo(root, found.project ? 'Existing project files' : 'New project');
  // A repo `ensureRepo` just initialized already holds these files, under the subject that says
  // what the commit is. One that was already there gets a commit each.
  if (!fresh) await commitScaffolding(root, wrote);
  return { root, created: !found.project, title };
}

const GITATTRIBUTES_COMMIT = 'Set how git merges the state logs';
const LAYOUTS_COMMIT = 'Add the shipped layout templates';
const IGNORES_COMMIT = 'Ignore the remembered window arrangement';

/**
 * The attributes a project needs from this app, each with the paragraph saying why. They are
 * separate blocks rather than one because a project created before the second one existed has the
 * first already, and {@link ensureGitAttributes} appends whichever it cannot find.
 */
const GITATTRIBUTES_BLOCKS = [
  {
    line: 'vngen/state/notifications.jsonl merge=union',
    why:
      '# The notification log is append-only and its read/hidden flags are patched in place.\n' +
      '# Union-merge it: two branches’ notifications combine instead of conflicting, and the\n' +
      '# reader dedupes by id and ORs the flags, so a line that comes back twice folds cleanly.\n',
  },
  {
    line: 'vngen/state/threads/*.native.jsonl -merge',
    why:
      '# A conversation’s native log is what the agent is replayed when a thread is continued.\n' +
      '# Refuse to merge it: conflict markers would be dropped as unparseable lines, and the\n' +
      '# conversation would then resume from a history that was quietly truncated.\n',
  },
  {
    line: 'vngen/work/graphs/*.json -merge',
    why:
      '# A generation graph is serialized node ids and socket references rather than prose.\n' +
      '# Refuse to merge it: a textual merge can pair an edge with a node the other side\n' +
      '# renumbered, which deserializes into a graph nobody authored.\n',
  },
  {
    line: 'vngen/work/graphs/lib/*.json -merge',
    why: '# A saved node group is a graph fragment, and merges no better than a whole one.\n',
  },
];

const GITATTRIBUTES_TEXT = GITATTRIBUTES_BLOCKS.map((b) => `${b.why}${b.line}\n`).join('\n');

/**
 * Give an existing project the merge attributes it was created without. Idempotent, and it appends
 * rather than writes: a `.gitattributes` is the user's file and may already say plenty.
 *
 * This deliberately does not carry this repo's own `* text=auto eol=lf`. `merge` and `text`/`eol`
 * are orthogonal attributes, so the lines stand alone, and a project is the author's repository
 * rather than somewhere to install this app's line-ending policy. `initRepoAt` already sets
 * `core.autocrlf=false`.
 */
export async function ensureGitAttributes(root: string): Promise<boolean> {
  const path = join(root, '.gitattributes');
  const current = await readFile(path, 'utf8').catch(() => undefined);
  const owed = GITATTRIBUTES_BLOCKS.filter((block) => !current?.includes(block.line));
  if (owed.length === 0) return false;

  const prefix = current === undefined || current === '' || current.endsWith('\n') ? '' : '\n';
  const text = owed.map((block) => `${block.why}${block.line}\n`).join('\n');
  await writeFile(path, `${current ?? ''}${prefix}${text}`);
  return true;
}

/** The one scene a new project starts with — named by `start:` and by the file it lives in. */
export const START_SCENE = 'opening';

/**
 * The files a new project is created with: three that make its model build, the shipped layout
 * templates, and the `.gitattributes` carrying both rules a project needs from this app.
 *
 * `templates/basic` is deliberately not copied, so an author does not start by deleting a cast
 * they did not write. An empty directory is not used either: with no `start:` and no scenes the
 * model builds with error diagnostics, so an empty project would open with a red count.
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
 * Where a create lands: the chosen folder, or a child of it named from the title. The parent and
 * the name are separate arguments so an OS chooser can answer one and a textbox the other. The
 * name is slugged, because a title is prose and a folder name is not.
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
 * Create a project at `root` and open it. Unlike `openWorkspace` this scaffolds, because creating
 * a new project here is an explicit request for a project and a project whose model will not build
 * is a worse answer than three files.
 *
 * The repo is initialized before the open so the first commit is the skeleton under its own
 * subject; `openWorkspace` then finds a `project.yaml` already there and only reads it. It is
 * `initRepoAt` rather than `ensureRepo` because a create must produce a repository even when
 * another repository already encloses this directory.
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
 * The recents list lives in the global session store rather than a project's own state, because
 * it must be readable before a workspace is open. Only this much of `SessionStore` is named, so
 * the helpers stay testable against a plain object.
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

/**
 * The remembered projects that are still there, pruning the store as it reads. A project moved or
 * deleted outside the app leaves an entry that can only be offered and then refused, and with
 * `RECENT_MAX` slots a few of those push every live entry off the end of the menu.
 *
 * `exists` is injected so the pruning is testable without a filesystem; main passes `existsSync`.
 */
export function liveWorkspaces(state: RecentStore, exists: (path: string) => boolean): string[] {
  const all = recentWorkspaces(state);
  const live = all.filter((root) => exists(root));
  if (live.length !== all.length) state.set(RECENT_KEY, live);
  return live;
}
