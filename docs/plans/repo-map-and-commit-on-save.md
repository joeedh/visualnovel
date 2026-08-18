# Repo map and commit-on-save

Status: **shipped** — see [As shipped](#as-shipped) for what came out differently, and
[`../repos-and-commits.md`](../repos-and-commits.md) for the as-built write-up. Item 4 of [`refactorTaskList.md`](refactorTaskList.md), from §4 of the
[migration report](../research/codebase-migration-for-new-requirements.md). It blocks item 10
(project bootstrap) and the "wiki in its own repo" option item 3 deliberately left open.

<!-- toc -->

<!-- tocstop -->

## What the requirements ask for

Four sentences from [`../designRequirementsEtc.md`](../designRequirementsEtc.md):

- "Projects live in git repos."
- "the story bible may optionally be in its own git repo separate from the project repo"
- base assets "may optionally be in their own git repo"
- "The app initializes a git repository if necessary. It will automatically commit existing
  files." … "Saving files also commits to git."

Three capabilities, then: **know which repo owns a path**, **commit on every act**, and
**bootstrap a repo around whatever the user picked**.

## Where the code already is

`@vn/git` is per-directory by construction — `Git` takes a `root`, every call spawns with that
cwd — so multi-repo needs no new plumbing, only a resolver. The plumbing undo rests on
(`writeTree`/`commitTree`/`applyTree` against a scratch index) is likewise already per-repo.

Commit policy today is split three ways and none of it is commit-on-save:

| Surface | When it commits |
| --- | --- |
| `vnauthor` | once per approved plan, gated on validation (`packages/authoring/src/loop.ts`) |
| desktop commands | never — a `CommandRecord` is appended to `commands.jsonl`, HEAD does not move |
| `vngen` CLI | never |
| `seedWorkspace` | once, when the sample workspace is first copied |

Undo is shadow snapshots under `refs/vn/undo/<seq>/{pre,post}`, scoped to the document class
(`['.', ':(exclude)vngen/build', ':(exclude)vngen/state']`), refusing when the worktree tree-sha
has drifted from what the record says it left.

## The conflict, stated honestly

Commit-per-mutating-command is [`../gitUndoOptions.md`](../gitUndoOptions.md) §4, and it **lost**
to shadow snapshots. It lost on one argument — "it pollutes history; a per-keystroke-ish commit
log buries the author's own narrative" — and the requirements have now retired that argument.
The author's history is *supposed* to record every save.

Its second argument still stands and this plan has to answer it: "`vnauthor` commits once per
approved plan. Two components both owning 'when to commit' is a design smell." See
[decision 6](#6-vnauthor-keeps-its-per-plan-commit).

The two mechanisms **compose without ordering constraints**, which is the fact that makes this
plan small: a commit moves a branch ref and the index, and changes no file in the worktree, so
it cannot perturb a snapshot tree taken either side of it. Committing after the post-snapshot
and comparing trees at undo time are independent operations on the same clean worktree.

## Decisions

### 1. The repo map is discovered, not declared

`git rev-parse --show-toplevel` from a path's directory, cached per directory. No `repos:` block
in `project.yaml`.

A declared map is a second source of truth that is wrong the moment a user runs `git init` in
`wiki/`, and right only while someone maintains it. Discovery *is* git's own answer: it handles
`.git` files (worktrees, submodules), `GIT_DIR`, and ceiling directories, and it agrees with what
`git status` in that directory would report. It also gets the important case right for free — git
does not descend into a nested repository, so a `wiki/.git` genuinely is not the project repo's
business, and the resolver saying so is not a special case.

### 2. Commit scope is the whole worktree, per repo

Each repo in the map commits `-A`. Not `record.written` (§3 of the undo survey rejected trusting a
hand-declared claim, and nothing verifies one), and not the undo pathspec.

This rests on an invariant the plan establishes and must hold: **the app opens on a clean worktree,
and every act ends with one.** Step 5's open-time checkpoint commit is what establishes it; every
act's commit is what maintains it. Under that invariant "everything dirty" and "what this act did"
are the same set, so the simplest possible scope is also the correct one — and a `pipeline.run`
that writes five hundred files needs no special case to become one commit.

Undo's scope stays the document class and does **not** widen to match. The two scopes answer
different questions: *what changed* (commit) versus *what may be rolled back* (undo). Rolling back
content-addressed assets would delete bytes a later run pays to regenerate — `gitUndoOptions.md`
§6, unchanged. An undo therefore leaves the generated tree alone and commits a worktree that is
documents-rolled-back plus generated-as-is, which is exactly what is on disk.

### 3. A pipeline run is one commit, at exit

The report's recommendation, taken: "authored saves commit individually; a pipeline run commits
once at exit — a run is one event in the story of the project, not five hundred." It needs no
mechanism: `pipeline.run` is itself a command on the stack, so it commits once when it returns,
like every other command, under decision 2's scope.

Per-wave commits were considered and rejected: a wave is a scheduling artifact, not an authorial
event, and a crash mid-run leaves the worktree dirty either way — which the next open's checkpoint
commit records honestly as "whatever was there".

### 4. The CLI does not commit

`vngen run` stays as it is. A CLI run is a build step, and build steps do not author history; a
headless run in CI that committed would be a surprise, and the desktop is the surface the
requirement describes. A CLI run's output is picked up by the next session open as a checkpoint
commit (step 5), which attributes it correctly rather than folding it into the next authored act.

### 5. Undo commits its restore; it never resets

The shadow-ref mechanism is kept whole. After restoring the `pre` tree, undo commits — a new,
revert-shaped commit — rather than moving a branch ref backwards. `git reset` is not on the table:
it rewrites the author's history and, with commit-on-save, the commit it discards may be the only
record of a save.

Not `git revert` either: revert applies an inverse *diff* and can conflict. We hold the exact tree
the author wants back, so we restore it and commit the result. The message is
`Undo: <subject of the undone commit>` with a `Vn-Undo:` trailer naming the seq. Redo is
symmetric against `post`.

The drift refusal gets *stronger* rather than weaker, as the report predicted: a clean worktree
becomes the norm, so a check that fails now means something really did change outside the app.

### 6. `vnauthor` keeps its per-plan commit

The agent does not adopt commit-on-save. An approved plan is one authorial act composed of many
file writes; committing each `edit_character` inside it would produce exactly the history §4 of
the undo survey warned about, and the approval is the event worth recording. The desktop reaches
the agent through `agent.*` commands, whose own commit-on-save would double-commit — so the
committer skips a command that reports the agent already committed (decision 7's `skipCommit`).

One owner per act, therefore, which is what "two components owning when to commit" actually
demanded: not that there be one committer, but that no act have two.

### 7. Multi-repo undo refuses as a unit

A command's writes are resolved to owning repos; each repo gets its own snapshot pair under its
own `refs/vn/undo/<seq>/`, keyed by the stack's global `seq` so one act has one name everywhere.
Undo checks **every** repo for drift before restoring **any**, and refuses as a unit.

That makes the common failure (someone edited a wiki file in another editor) a clean refusal
rather than a half-restore. It does not make the restore atomic — an I/O error between two repos
still leaves one moved — so the failure path reports which repos were restored, and does not
pretend the operation was a no-op.

### 8. `CommandRecord` widens additively

Two optional fields, no shape changes:

```ts
/** Commits this act produced, one per repo that had something to commit. */
commits?: { repo: string; sha: string }[];
/** Per-repo snapshots when an act spanned more than one. The existing top-level
 *  `undo.pre`/`post` stay the *project* repo's, so every existing reader keeps working. */
undo?: { pre: string; post: string; changed: boolean; repos?: Record<string, Snapshot2> };
```

Records written before this plan stay readable and stay undoable; a record with no `commits` is
simply one that ran before saves committed.

## Steps

Each step ends green (`pnpm check`, `pnpm test`, `pnpm lint`) and is independently revertible.

### Step 1 — `RepoResolver` in `@vn/git`

Mechanism only; the package stays policy-free.

```ts
export class RepoResolver {
  constructor(base?: string);
  /** The repo root owning `path`, or null if it is not in a work tree. Cached per directory. */
  rootOf(path: string): Promise<string | null>;
  /** A `Git` scoped to that root, memoized per root. */
  gitFor(path: string): Promise<Git | null>;
  /** Partition paths by owning root — the multi-repo entry point. */
  group(paths: string[]): Promise<Map<string, string[]>>;
  /** Drop the cache. Called after `git init` creates a repo the cache remembers as absent. */
  forget(): void;
}
```

`rootOf` resolves a non-existent path (a file about to be created) against its parent directory,
and normalizes git's forward-slash output to platform separators so a root compares equal to a
path the app built with `join`.

Also on `Git`: `commit` gains `trailers?: Record<string, string>`, appended as a trailer block
after a blank line. Trailers are the provenance seam — mechanical, no policy.

Tests: nested repo resolves to the inner root; a path under the project resolves to the project;
outside any repo → null; `group` partitions a mixed list; cache is not consulted across `forget`.

### Step 2 — `Committer` in `@vn/commands`

A sibling of `UndoJournal`, opt-in the same way, so a stack without one behaves exactly as today
(which is what keeps testkit and the existing tests unchanged).

```ts
export interface CommitterOptions {
  /** Repos to commit in, in order. Each commits `-A`; nothing to commit is a no-op. */
  repos: () => Promise<Git[]>;
}
export class Committer {
  commit(record: CommandRecord): Promise<{ repo: string; sha: string }[]>;
}
```

Wired as `committer?: Committer` on `CommandStackOptions`, invoked after the post-snapshot for a
record that is `mutating`, `status: 'ok'` and not marked `skipCommit`, with its results written
onto `record.commits` before `onRecord` runs.

Message shape, from fields the record already holds:

```
Moved line L4 into rooftop

Vn-Command: story.moveLine
Vn-Seq: 12
Vn-Invocation: story.moveLine(lineId='L4' toScene='rooftop')
Vn-Source: ui
```

Subject is `record.message`, stripped of a trailing period and capped at 72 characters — commands
already return a human one-liner, and a second hand-written sentence would only drift from it.

Tests: a mutating command commits; a failed one does not; a command that changed nothing produces
no commit (git's own "nothing to commit"); trailers round-trip through `git log`; a stack with no
committer moves HEAD not at all.

### Step 3 — undo and redo commit their restores

`CommandStack.move` commits after `journal.restore`, with the revert-shaped message and the
`Vn-Undo:`/`Vn-Redo:` trailer. The existing drift check runs first and is untouched.

Tests: undo after a commit-on-save leaves HEAD *ahead*, not behind, and the tree matches `pre`;
the undone commit is still in `git log`; redo commits again and the tree matches `post`; a drifted
worktree refuses and commits nothing.

### Step 4 — multi-repo

`UndoJournal` takes a repo list rather than one `Git`, capturing and restoring per repo under the
same seq; `check` fails if any repo drifted, naming which. `CommandRecord.undo.repos` carries the
extra pairs (decision 8). `Committer` already iterates repos from step 2.

Tests: a project with a nested `wiki/.git`, an edit in each, one act, two commits; a drifted wiki
refuses the whole undo and leaves both worktrees alone; a single-repo project produces records
byte-identical to step 3's.

### Step 5 — desktop wiring and bootstrap

- `ensureRepo(root)` — extracted from `seedWorkspace`'s tail: `isRepo` → else `init` + the
  fallback identity + `core.autocrlf false`, then commit whatever is already there. This is
  item 10's "auto-commit of existing files", landing here because the resolver is here; item 10
  keeps the directory picker.
- On session open: `ensureRepo` for the project, then a **checkpoint commit** in each mapped repo
  (`Checkpoint: files changed outside the app`) if it is dirty. This is what establishes decision
  2's invariant, and it is where a CLI run's output gets attributed.
- The repo map: `{ project, wiki?, baseAssets? }`, resolved from `paths.root` / `paths.wikiDir` /
  the base-asset root once item 5 defines one, deduplicated by root. Reported on `WorkspaceIndex`
  as `repos: { role, root }[]` so the UI can say which repo a file belongs to.
- The stack is constructed with a `Committer` over that map, and its `UndoJournal` over the same.

Tests (desktop `session.test.ts`, testkit-backed): a `story.*` command commits; the count of
commits equals the count of mutating acts; opening on a dirty tree produces exactly one checkpoint
commit; `bibleFiles`-style index assertions extended with `repos`.

### Step 6 — docs

- `docs/repos-and-commits.md` (new, listed in `docs/index.md`): the repo map, the commit-on-save
  invariant, message and trailer shapes, how undo composes with it, what the CLI does not do.
- `gitUndoOptions.md` — a short section recording that §4's rejection was reversed by a
  requirements change and how §4 and §5 now coexist. The survey stays as written.
- `command-system.md` — the committer alongside the journal in the provenance section.
- `CLAUDE.md` — the commit-on-save invariant as a core-idea bullet, `@vn/git`'s row gaining the
  resolver, and the `@vn/commands` row gaining the `Committer`.
- `refactorTaskList.md` / `plans/index.md` — status, and item 10's row noting the bootstrap half
  that landed here.

## Out of scope

- **The directory picker** (item 10) and any first-run UI.
- **A base-asset repo role in practice.** The map has the slot; what a base-asset root *is* is
  item 5's decision, and this plan only refrains from making it harder.
- **Push/pull, remotes, conflict resolution.** Nothing here leaves the local repo.
- **Squashing or rewriting the save history.** A user who wants a tidier log has `git rebase`;
  the app never rewrites what it wrote.
- **Committing outside the stack.** File writes that do not go through a command (there should be
  none) are picked up by the next checkpoint commit, not chased.

## As shipped

All six steps landed as written. Four things came out differently:

- **A repo the project doesn't own is refused, and that was not in the plan.** Wiring the desktop
  app surfaced a hazard the plan missed: `openGit(projectRoot).isRepo()` is true when the project
  merely *sits inside* a repo — `--project templates/basic` inside this monorepo, say — so the
  session's opening `-A` checkpoint would have committed the entire monorepo worktree under
  "Changes made outside the app". `RepoRef.owned` (`root === resolve(dir)`) is the answer: the app
  reports the repo, warns, and declines to write history it doesn't own. Undo is unaffected, since
  a shadow ref writes nobody's history.
- **The skip flag lives on the command, not the record.** The plan had `skipCommit` set by a
  command's own result; `Command.commitsItself` is a static property instead. Whether `agent.run`
  owns its commits is a fact about the command, not about a particular run of it, and as a
  property it shows up in the catalog.
- **Undo's commit subject is the record's own sentence.** Rather than `Undo: <original subject>`,
  an undo commits under the `Undid <invocation>` message the undo record already carries, with the
  `Vn-Undo:` trailer naming the seq. One less place that reaches back into another record.
- **Step 5's tests landed elsewhere.** The plan named the desktop `session.test.ts`; the
  `CommandStack` is constructed in Electron-only `main/index.ts`, which that project cannot import.
  Coverage went to `packages/commands/src/tests/commit.test.ts` (the stack path, against a real
  repo), `packages/authoring/src/tests/repos.test.ts` (the map), and
  `apps/desktop/src/main/tests/workspace.test.ts` (`ensureRepo`).
