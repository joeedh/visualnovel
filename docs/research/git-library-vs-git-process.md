# An in-process git library instead of the git subprocess

<!-- toc -->

- [Recommendation](#recommendation)
- [1. What this repo asks git to do](#1-what-this-repo-asks-git-to-do)
  * [The surface](#the-surface)
  * [Where the calls come from, and how often](#where-the-calls-come-from-and-how-often)
  * [Plumbing versus porcelain](#plumbing-versus-porcelain)
  * [What is not there](#what-is-not-there)
- [2. Whether a library would actually help](#2-whether-a-library-would-actually-help)
  * [Three costs that get conflated](#three-costs-that-get-conflated)
  * [What the deferral plan measured, and what it did not vary](#what-the-deferral-plan-measured-and-what-it-did-not-vary)
  * [The scratch index re-hashes every document, every snapshot](#the-scratch-index-re-hashes-every-document-every-snapshot)
  * [What is left after the cheap fixes](#what-is-left-after-the-cheap-fixes)
  * [The alternatives to a library, ranked](#the-alternatives-to-a-library-ranked)
- [3. The libraries, against this repo's constraints](#3-the-libraries-against-this-repos-constraints)
  * [The four constraints they have to clear](#the-four-constraints-they-have-to-clear)
  * [nodegit](#nodegit)
  * [es-git](#es-git)
  * [@napi-rs/simple-git](#napi-rssimple-git)
  * [isomorphic-git](#isomorphic-git)
  * [wasm-git](#wasm-git)
  * [dugite, and the bundled-git option](#dugite-and-the-bundled-git-option)
  * [What is not out there](#what-is-not-out-there)
  * [Coverage against the inventory](#coverage-against-the-inventory)
- [4. Correctness and compatibility risks](#4-correctness-and-compatibility-risks)
  * [Line endings, and why they move a tree hash](#line-endings-and-why-they-move-a-tree-hash)
  * [The index and the lockfile](#the-index-and-the-lockfile)
  * [fsmonitor and the untracked cache](#fsmonitor-and-the-untracked-cache)
  * [Signing](#signing)
  * [Hooks](#hooks)
  * [.gitignore and .gitattributes](#gitignore-and-gitattributes)
  * [Submodules](#submodules)
  * [Failures are returned here, not thrown](#failures-are-returned-here-not-thrown)
  * [Risks that turn out not to apply](#risks-that-turn-out-not-to-apply)
- [5. The recommendation, sized](#5-the-recommendation-sized)
  * [Stage 0, which is the whole recommendation](#stage-0-which-is-the-whole-recommendation)
  * [If stage 0 is not enough](#if-stage-0-is-not-enough)
  * [What would change the recommendation](#what-would-change-the-recommendation)
- [How this was measured](#how-this-was-measured)
- [Unverified items](#unverified-items)
- [Primary sources](#primary-sources)

<!-- tocstop -->

The research and measurements here date from 2026-08-25. The library facts come from the npm
registry's own `time` maps, the projects' repositories, and their published type declarations,
all read on that date; staleness is flagged where staleness is the finding. The timings come
from this machine (Windows 11, git 2.53.0.windows.1, Node v24.14.0) using throwaway scripts
described at the end, against fixture repositories built for the purpose. Prior timings are
taken from the "Measured" section of docs/plans/archive/deferring-commit-on-save.md rather than
re-derived, and are labelled where they are used.

## Recommendation

Do not replace the subprocess. Four changes inside `@vn/git` and its callers recover most of
what a library would recover, cost about a day, add no dependency, and remove the one part of
the cost that grows with the size of the author's project. Seed the scratch index from the real
one before `writeTree` stages into it, memoize the answers that cannot change for the life of a
repo handle (`isRepo`, `rev-parse --absolute-git-dir`, `topLevel`), memoize `git.status()`
across one `listGraphs` pass, and pass the `head` that the command stack already read into both
snapshots. On a 2000-document fixture the first two changes alone cut one undo snapshot from
1269 ms to 219 ms, producing a byte-identical tree. On a 200-document fixture those two changes
cut the same snapshot from 388 ms to 214 ms.

This counterargument belongs here rather than at the end. After those fixes roughly ten
subprocesses remain per mutating command, costing about 430 ms on Windows, and almost all of
that is process startup. The cost is real, it falls on the interactive path, and only an
in-process library removes it. The reason to decline one anyway is that neither of the two
libraries that load in Electron without an ABI rebuild (`es-git` and `@napi-rs/simple-git`)
exposes `read-tree`, which is what `Git.applyTree` is built from, so the undo restore path
cannot be ported to either one without reimplementing it against a different primitive. The
restore path must not be reimplemented approximately.

## 1. What this repo asks git to do

### The surface

Every `git` invocation goes through `packages/git/src/git.ts`, which is 341 lines and the only
place in the repository that spawns `git`. Its `run()` uses `execFile` (never a shell), passes
`windowsHide`, sets `GIT_INDEX_FILE` when a scratch index is in use, and returns `{ok, stdout,
stderr}` rather than throwing on a non-zero exit.

| Method | Commands it runs | Spawns | Kind |
| --- | --- | --- | --- |
| `isRepo` | `rev-parse --is-inside-work-tree` | 1 | plumbing |
| `topLevel` | `rev-parse --show-toplevel` | 1 | plumbing |
| `init` | `init` | 1 | porcelain |
| `config` / `configGet` | `config --local` / `config --get` | 1 | porcelain |
| `branch` | `rev-parse --abbrev-ref HEAD` | 1 | plumbing |
| `head` | `rev-parse HEAD` | 1 | plumbing |
| `status` | `status --porcelain` plus `branch()` | 2 | porcelain |
| `isDirty` | `status --porcelain [-- <pathspec>]` | 1 | porcelain |
| `add` | `add -A` (or a path list) | 1 | porcelain |
| `commit` | `add`, `rev-parse HEAD`, `commit -m`, `rev-parse HEAD` | 4 | porcelain |
| `log` / `lastCommitFor` | `log --format=…` | 1 | porcelain |
| `show` / `diff` | `show` / `diff` | 1 | porcelain |
| `revert` / `restore` | `revert --no-edit` / `restore --source` | 1 | porcelain |
| `writeTree` | `rev-parse --absolute-git-dir`, `add -A -- <pathspec>`, `write-tree` | 3 | plumbing |
| `commitTree` | `commit-tree` | 1 | plumbing |
| `treeOf` | `rev-parse <c>^{tree}` | 1 | plumbing |
| `updateRef` / `deleteRef` | `update-ref` / `update-ref -d` | 1 | plumbing |
| `listRefs` | `for-each-ref --format=…` | 1 | plumbing |
| `applyTree` | `rev-parse --absolute-git-dir`, `read-tree`, `read-tree -u --reset` | 3 | plumbing |

`withScratchIndex` is why two of those cost three spawns. It queries git for the location of
the git directory, points `GIT_INDEX_FILE` at a per-process file inside it, and removes the
file in a `finally`. No step here stages into the author's own index.

### Where the calls come from, and how often

The hot path runs one mutating, undoable command in the desktop app, which an author triggers
by typing in the script editor or dragging a node. `CommandStack.runCommand`
(`packages/commands/src/stack.ts`) runs, in order, a flush of any deferred commit batch,
`gitState()`, an undo `capture('pre')`, the command's own work, a `capture('post')`, and then
either a commit or a deferral. Against a single repository, that sequence amounts to:

| Step | Spawns | Notes |
| --- | --- | --- |
| `gitState()` | 3 | `isRepo`, `head`, `isDirty` |
| `capture('pre')` | 7 | `isRepo`, `writeTree` (3), `commitTree`, `head`, `updateRef` |
| the command's own read and write | ~2 | measured as such in the deferral plan |
| `capture('post')` | 7 | the same seven |
| the commit | 0, or 5 when the batch flushes | `isRepo` plus `commit`'s four |

An edit makes seventeen to nineteen spawns, which matches the deferral plan's own count of 24
before batching landed, minus the five that `Committer.commit` no longer runs on every command.

`defersCommit` does not reduce this cost. It defers the commit, and `capture` runs regardless,
so a gesture command sent once per frame still pays `gitState` plus two snapshots on every
frame. A cost paid on every frame is latency-critical rather than merely slow.

Everything else is colder:

- **Doc-tree rebuild.** `listGraphs` in `apps/desktop/src/main/graphs.ts` calls `readGraph`
  once per graph, and each `readGraph` calls `conflictedGraphs`, which calls `git.status()`.
  Each graph therefore costs two spawns, and neither result is memoized. A project with ten
  bound graphs pays twenty spawns of the most expensive command in the surface for one answer
  that is identical across all ten.
- **Startup.** `checkGit()` in `apps/desktop/src/main/doctor.ts` spawns `git --version` once.
  `RepoResolver` resolves each directory with `rev-parse --show-toplevel` and memoizes the
  result. `ensureRepo` may `init` and set config. `commitScaffolding` writes up to three
  commits, and `checkpoint('Changes made outside the app')` records anything the author changed
  while the app was closed.
- **Undo and redo.** `journal.check` costs four spawns per repo and `journal.restore` costs
  three. Both commands are user-initiated and infrequent.
- **The authoring agent.** `packages/authoring/src/tools.ts` exposes `status`, `log`, `show`,
  `diff`, `commit`, `revert`, `restore` and `init` as tools. Each call runs as one turn of a
  conversation, so the model's latency hides the subprocess cost.
- **GitHub Pages.** `project.installPages` writes files and nothing else. `pagesState` costs
  three spawns. Commit-on-save commits the result. The app never pushes.

### Plumbing versus porcelain

The undo journal (the expensive half) already uses only "plumbing" (low-level) commands:
`write-tree`, `commit-tree`, `update-ref`, `for-each-ref`, `read-tree`, and `rev-parse` in its
object-naming role. The journal ports cleanly in principle, because every one of those has a
one-to-one libgit2 equivalent and none of them parses human-facing output.

The code depends on less porcelain output than the command names suggest. `status --porcelain`
is the only porcelain output the code parses, and git defines `--porcelain` as a stable machine
format, so the "porcelain" (git's term for its user-facing commands) label here follows from
the command name rather than from any risk in parsing it. `commit`, `add`, `revert` and
`restore` are invoked for their effect and checked by exit code. The one exception is
`commit`'s string match against `nothing to commit|no changes added to commit`, which is
genuinely fragile and is the only place the code depends on the text of a git message.

### What is not there

The codebase contains no network git. `packages/git`, `apps/desktop/src/main`, and
`packages/authoring/src` contain no push, no fetch, no clone, and no pull.
docs/guides/github-pages.md states the same: commit-on-save commits everything, and the app
never pushes. The evaluation therefore excludes libgit2's hardest and least reliable area
(transport, credential helpers, SSH). That exclusion is the single biggest reason a migration
here would be less dangerous than the usual case.

There is also no `git worktree` usage at runtime. The word appears in the codebase only as
"working tree".

## 2. Whether a library would actually help

### Three costs that get conflated

**Process startup.** On this machine `git --version` takes 36.5 ms and does nothing. Every
single-command probe in the surface takes between 37 and 46 ms: `rev-parse --show-toplevel`
37.7 ms, `rev-parse HEAD` 38.6 ms, `hash-object README.md` 39.3 ms. Windows imposes this floor
on every spawn, regardless of what the command does. An in-process library removes the startup
cost completely.

`status --porcelain` scans the worktree. It costs 167.0 ms in this monorepo and 47.2 ms in a
200-file project-shaped repository. Subtracting the spawn floor leaves roughly 130 ms of scan
in the monorepo and roughly 10 ms in the project-shaped repository. `node_modules` and the
vendor submodules inflate the monorepo number, and an author's project has neither. Scoping the
same call to `-- docs` brings it to 46.3 ms, so the scan is pathspec-sensitive and can be
narrowed without any new dependency. A library does not remove this cost; libgit2 does the same
walk.

**Object hashing and index writing.** Hashing objects and writing the index is real work
proportional to the number of files in the pathspec, and no library removes it either. A
library can avoid doing that work twice, and that is where most of the saving comes from.

### What the deferral plan measured, and what it did not vary

docs/plans/archive/deferring-commit-on-save.md measured one edit as the mean of 20, on Windows
11 with git 2.51, in a project carrying 2000 committed assets: `exec` 1004 ms across 24
subprocesses, of which `gitState()` was 113 ms in 3, the two `capture` calls 566 ms in 14,
`Committer.commit` 232 ms in 5, and the command's own read and write 93 ms in 2. The document
concluded that "the time is process startup, not tree size", on the strength of 1012 / 1004 /
1011 ms at 0, 2000 and 6000 assets, and that "any alternative that narrows a pathspec instead
buys nothing." After the change shipped, the document re-measured 1036.4 → 824.7 ms wall clock
and 967.9 → 747.3 ms in `exec`.

The conclusion is correct for what the experiment varied, and the reason is worth stating
precisely. `UNDO_PATHS` is `['.', ':(exclude)vngen/build', ':(exclude)vngen/state']`, so the
pathspec excludes the assets the plan added by construction. The experiment varied the number
of files the snapshot never looks at. It did not vary the number of files the snapshot does
look at, which is the number of documents (scenes, wiki pages, character sheets, graphs and
layouts).

### The scratch index re-hashes every document, every snapshot

`withScratchIndex` starts from a file that does not exist. `git add -A` against an empty index
has no stat cache to consult, so it re-hashes every file in the pathspec on every snapshot,
twice per command. The following replays `UndoJournal.capture()`'s exact seven-spawn sequence:

| Fixture | `add -A` | One `capture()` |
| --- | --- | --- |
| 200 documents | 133.3 ms | 388.4 ms |
| this monorepo | 280.3 ms | 574.1 ms |
| 2000 documents | 937.7 ms | 1268.9 ms |

At 2000 documents one snapshot costs 1.27 s, and hashing accounts for two-thirds of that, not
spawning. Two snapshots per edit cost 2.5 s. The deferral plan reports no such growth curve
because it measured the wrong axis.

Copying the real `.git/index` into the scratch path first (one file copy, about 1 ms) gives
`add -A` a valid stat cache and a valid cache-tree extension, so it hashes only the files that
changed and `write-tree` reuses subtree hashes it already has:

| Fixture | `add -A` | `write-tree` | One `capture()`, probes memoized |
| --- | --- | --- | --- |
| 200 documents, empty scratch index | 133.2 ms | 53.1 ms | 316.9 ms |
| 200 documents, seeded | 42.1 ms | 41.3 ms | 214.3 ms |
| 2000 documents, empty scratch index | 910.2 ms | 114.6 ms | 1156.6 ms |
| 2000 documents, seeded | 44.3 ms | 43.9 ms | 218.9 ms |

Both routes produce the same tree hash: `0983b4ab…` on the 200-document fixture and `b1fc9b12…`
on the 2000-document one. That agreement is what the undo journal depends on, because its drift
check compares tree hashes and a divergence there would refuse valid undos.

One caveat makes this a day's work rather than an afternoon's. Both fixtures have no
`:(exclude)` terms. The real `UNDO_PATHS` does, so a copied index carries entries for
`vngen/build` and `vngen/state` that the pathspec is supposed to leave out, and the resulting
tree would differ. The seeded index needs those entries removed first. One option is to run
`git rm --cached -r --ignore-unmatch` once per excluded prefix against the scratch index. The
other is to `read-tree` the previous snapshot's tree instead of copying the live index. Either
approach has to be proved by comparing tree hashes against the current implementation on a
project that actually has both directories populated.

### What is left after the cheap fixes

Memoizing `isRepo` and `rev-parse --absolute-git-dir` for as long as a repo handle exists
removes two spawns from every `capture` and one from every `gitState`. With that memoization
and the seeded index, one mutating command against a project-shaped repository costs roughly:

| Step | Spawns | Cost |
| --- | --- | --- |
| `gitState()` | 2 | ~87 ms |
| `capture('pre')` | 5 | ~214 ms |
| the command's own work | ~2 | ~80 ms |
| `capture('post')` | 5 | ~214 ms |
| **total** | **~14** | **~595 ms** |

Today's timings are ~976 ms at 200 documents and ~2740 ms at 2000 documents. The 2000-document
case becomes ~605 ms, so the fixes remove the growth with document count as well as most of the
constant cost.

The remaining time is then almost entirely spawn overhead: twelve to fourteen processes at
roughly 43 ms each. Passing the `head` that `gitState` already fetched into both captures
removes two more spawns. Ten spawns (about 430 ms) is the lower bound for this design on
Windows without changing what it runs on.

So a library would save around 400 ms per edit, and that is a real win. The saving is not a
rounding error, and this report does not claim it is. Section 3 gives the reasons the cost is
too high anyway.

### The alternatives to a library, ranked

1. **Seed the scratch index.** Removes 90 ms per snapshot at 200 documents and 870 ms at
   2000. Largest single win, no dependency, and it is the only item here that changes the
   scaling behaviour rather than the constant.
2. 2. **Memoize the repo-invariant probes.** The probes cost three spawns per command, roughly
   130 ms. The answers cannot change while a repo handle is alive, and `RepoResolver` already
   memoizes `topLevel` this way, so the pattern exists.
3. 3. **Memoize `git.status()` across one `listGraphs` pass.** Removes 2(N−1) spawns per
   doc-tree rebuild. On a project with ten graphs that is eighteen spawns and (at monorepo scan
   cost) most of a second. The repeated status call counts as a bug more than a missed
   optimization.
4. **Pass the known `head` into `capture`.** Two spawns, ~80 ms.
5. 5. **Narrow the `isDirty` pathspec.** The deferral plan found that narrowing the pathspec
   bought nothing, and that finding stands: the scan takes 10 ms in a project-shaped
   repository, so narrowing it saves nothing worth the risk of getting the pathspec wrong.
6. 6. **`core.fsmonitor`.** Speeds up the scan, and the scan already costs little in a
   project-shaped repository. It is already `true` in this monorepo. The app should not
   configure it into the projects it creates.
7. 7. **A long-running git helper.** There is no protocol for this. `git cat-file --batch`
   covers object reads and `hash-object --stdin-paths` covers hashing, and neither handles the
   index operations that make up most of the work here. This is not an available option.

Items 1 through 4 are the recommendation. They are additive with a library rather than
alternative to it (a library would still want a warm index), so doing them first costs nothing
even if a migration eventually happens.

## 3. The libraries, against this repo's constraints

### The four constraints they have to clear

**Electron.** `apps/desktop` runs Electron 33.4.11 (`^33.2.0`), which embeds Node 20. A NAN or
raw-V8 addon needs a rebuild against Electron's ABI for each Electron release. A strictly
Node-API addon does not, provided it targets a `NAPI_VERSION` the embedded Node supports, is
built with `win_delay_load_hook`, and is loaded in the main process. The renderer is sandboxed
and has no Node environment, so `@vn/git` must load in the main process. Neither Node's nor
Electron's documentation states an explicit Electron exemption for N-API stability. The
exemption follows from N-API being ABI-stable and Electron embedding Node, and napi-rs tests it
continuously, but it remains an inference and not a published guarantee.

**Packaging.** `scripts/package.desktop.mjs` writes a scratch `package.json` whose
`dependencies` are exactly the three runtime externals, then runs `pnpm install
--ignore-workspace --config.node-linker=hoisted` because pnpm's tree of symlinked dependencies
does not survive being copied into an app image. A native module would have to be added to that
list and to `EXTERNAL` in `scripts/aliases.mjs`, since esbuild cannot bundle a `.node` file.
`apps/desktop/electron-builder.yml` sets `asar: true` and unpacks only esbuild's platform
packages; electron-builder's `smartUnpack` usually catches `.node` files but has a documented
history of both over- and under-unpacking, so `asarUnpack: ["**/*.node"]` would be set
explicitly instead of relying on `smartUnpack`. `pnpm smoke` would need a fourth check, because
it exists to catch a module that resolves in the repo and not in the image. No code signing is
configured today and only Windows is targeted, so signing an addon costs nothing yet. That cost
arrives the day macOS is packaged, since notarization requires every nested Mach-O to be
signed.

**Tests.** Sixteen test files exercise real git against real temporary repositories —
`packages/git` (23 tests), `packages/commands` (82), `packages/authoring` (212) and
`apps/desktop` (178). That suite is the strongest asset in this question, because it is a
ready-made differential harness that any replacement has to pass unchanged. Two mechanical
obstacles constrain such a replacement. `scripts/jest-esbuild.cjs` transpiles to CommonJS and
documents that `transformSync` never lowers `import()` to `require`, so a candidate must have a
working CommonJS entry point. `jest.config.cjs` also overrides `moduleFileExtensions` to
`['ts', 'tsx', 'js', 'json']`, dropping jest's default `node` entry, so a package that resolves
its addon without an explicit extension will not resolve under test. Separately, the desktop
jest project is node-only, so tests would exercise Node 24's ABI while the shipped app
exercises Electron 33's, and the two would need to be kept in agreement by something other than
the test suite.

This is a question of reach. `@vn/cli` does not depend on `@vn/git`, and neither `@vn/pipeline`
nor `@vn/scheduler` depends on it. The `vngen` bundle contains no git code at all, so it is
unaffected. `@vn/authoring-app` and `@vn/desktop` both depend on `@vn/git`, so `vnauthor` and
the desktop app are the only two hosts affected.

The runtime check is `checkGit()`, which spawns `git --version` at startup. If the spawn fails,
it files a durable note and lets the app open read-only. An in-process library removes that
failure mode outright, which is a genuine benefit and not only a performance one.
`apps/desktop/src/main/doctor.ts` already records the alternative and declines it, on the
grounds that a portable git "would add tens of megabytes and a second thing to keep patched, to
solve a problem only Windows has."

### nodegit

The `latest` tag is `0.27.0`, published 2020-07-28, which is six years old as of today. It
supports Node ABI 83 and Electron 10 at most, so it cannot run here at all. Using the package
here requires the `next` tag, `0.28.0-alpha.38` (2026-04-23), an alpha line that has run since
2020 and reached its thirty-eighth iteration without ever being promoted. The repository still
receives commits: the last one, titled "Update maintainers", landed 2026-07-16, and 363 issues
are open.

It vendors its own libgit2 fork at 1.9.1 plus patches. Prebuilds come from a private S3 bucket
via `node-pre-gyp` with `--fallback-to-build`, so an install that finds no prebuild compiles
libgit2, OpenSSL and libssh2 on the user's machine without warning. Enumerating that bucket
shows `0.28.0-alpha.38` carrying Node ABIs 115/127/137 and exactly one Electron ABI,
`electron-v41.3`. This app is on Electron 33. The bucket holds no prebuild for Electron 33, so
`--fallback-to-build` compiles from source on every install.

nodegit is also still NAN-bound rather than context-aware: issue #1774, "Make nodegit
context-aware for compatibility with Electron 9 and beyond", has been open since 2020-05-24.
The nodegit Electron install guide still uses `target = 1.2.8` as the example, a version
released in 2016.

nodegit has by far the most complete API of anything here, including `read-tree`, reset,
worktrees, submodules, gitattributes and signatures. That coverage does not decide the choice.
The ABI and prebuild story rules nodegit out on its own.

### es-git

The latest release is `0.7.0`, published 2026-05-17. The binding uses napi-rs and targets
Node-API v6, so the same `.node` file loads in Node 20/22/24 and in Electron with no rebuild
and no `electron-rebuild` step. It vendors libgit2 ~1.9.3 statically and ships ten platform
triples, including musl. The repository has 327 stars and 20 open issues.

The maintenance signal is mixed. `main` has not moved since the 0.7.0 release three months ago,
while pull requests are still arriving as recently as today, including one to automate the
release process. Contributions arrive, but merges and releases do not follow. If merges and
releases are still missing at the end of 2026, treat the project as at-risk.

Its API is the most complete of the N-API options: `Index.writeTree`, `addAll` with pathspecs,
`statuses`, `commit` with `updateRef` and a pre-computed signature, `isPathIgnored`, `getAttr`,
worktrees, submodules, stash, rebase. It does not expose `read-tree` and it does not expose
reset. `Index.read(force)` reads the index from disk, not a tree into the index. The
recommendation names that missing `read-tree` as the blocker. `Git.applyTree` runs `read-tree
<from>` followed by `read-tree -u --reset <to>`, and the nearest reconstruction available uses
`setHead` plus `checkoutTree` with force, which is a different operation with different
behaviour for files that exist in `from` and not in `to`.

Its documentation never mentions Electron and its issue tracker contains no Electron issues. It
should work by construction, but no one has tested it.

### @napi-rs/simple-git

The latest version is `1.1.0`, published 2026-07-07, with the last commit on 2026-08-10 and one
open issue. The package draws about 362k downloads a week, thirty times as many as es-git. It
builds against libgit2 1.9.4, the newest of any package evaluated here. It ships fifteen
platform triples, the widest coverage of anything evaluated, including musl, FreeBSD and
win32-ia32. It targets Node-API v6, so it needs no rebuild, the same as es-git. napi-rs's own
author maintains it, so the toolchain and the binding move together.

The API covers roughly half of es-git's. It has `Index.writeTree`, `addAll`, `statuses` with an
async and cancellable variant, `commit`, `checkoutTree`, and `Config` read and write. It has no
`read-tree`, no reset, no worktrees, no submodules, no `isPathIgnored`, no gitattributes
access, and no way to pass a signature to a commit. It cannot do the undo restore path, and it
cannot answer the ignore and attribute questions.

Note that it is unrelated to `simple-git`, which is a subprocess wrapper of the same name.

### isomorphic-git

It is pure JavaScript, with no native code, no ABI, no prebuilds, and no packaging consequences
at all. Version `1.41.9` was published 2026-08-23, two days ago. It is the fastest-moving
project in this list, with seventeen releases in August 2026 alone after a quiet 2024, and it
is downloaded 1.8M times a week.

It is the only candidate that covers the whole plumbing set: `writeTree`, `readTree`,
`hashBlob`, `resetIndex`, `updateIndex`, and a `statusMatrix` that fits this code better than
parsing porcelain output. It reads `core.autocrlf` and applies it, and it supports signing
through an `onSign` callback.

Three things count against it here. Its `add` takes paths and directories but no glob or magic
pathspecs, so `':(exclude)vngen/build'` has no equivalent. `UNDO_PATHS` would have to be
reimplemented as an explicit traversal with exclusions applied in JavaScript, which carries the
same divergence risk as the restore path applied to the snapshot path. It has no
`.gitattributes` support, as section 4 discusses. Its cache is unbounded by design; its own
documentation describes the unbounded cache as a memory leak in long-running processes, and an
Electron main process that holds a workspace open for hours is a long-running process.

### wasm-git

This is libgit2 1.9.4 via Emscripten. Version `0.0.17` was published 2026-07-17, and the
project is actively maintained after a long gap. There are no ABI or prebuild concerns.

It is disqualified by its shape rather than its status. It exposes libgit2's examples CLI
through `callMain(argv)`, which takes an array of strings and writes to stdout, and that
example program implements no `write-tree`, no `read-tree`, no `hash-object`, no reset, and no
`status --porcelain`. It also operates on an Emscripten virtual filesystem, so reaching real
repository paths requires a NODEFS mount and re-setting the working directory before each call.
For a desktop app that operates on real paths, this is the wrong tool.

### dugite, and the bundled-git option

`3.2.3`, published 2026-08-11, nine open issues, `engines: node >= 20`. It is a subprocess
wrapper like `@vn/git`, but it bundles its own git (2.53.0 in the current release, fetched by a
postinstall script and checksum-pinned) across eight platforms. GitHub Desktop uses it, so it
is proven in this scenario.

It does not improve latency, since it spawns the same processes at the same cost. It removes
the missing-git failure mode and pins the git version, which eliminates every correctness risk
in section 4 at once, because real git supplies the semantics. The price is roughly 50 MB in
the image, a postinstall network download, and `extraResources` plus `GIT_EXEC_PATH` wiring.
The comment in `apps/desktop/src/main/doctor.ts` already weighed that cost and declined it.

This option is listed here because it answers a different question. If the missing-git failure
mode, rather than the latency, becomes the problem worth fixing, choose this option. It is a
much smaller change than a library migration.

### What is not out there

There is no gitoxide binding for Node worth considering. Every plausible npm name is unclaimed,
and the npm keyword `gitoxide` has zero packages. The only real package, `@hologit/holo-tree`
(a napi-rs binding to `gix`, first published 2026-06-29), works on bare repositories only (no
index, no working directory, no status) and gets about 97 downloads a month. Gitoxide itself is
under active development, but its own `crate-status.md` lists "tree from index" as
unimplemented, so even a binding written tomorrow would not cover the operation this codebase
uses most heavily. Gitoxide closed its WASM support issue as `not_planned` on 2026-07-22.

No new libgit2 N-API binding has appeared since es-git.

### Coverage against the inventory

These operations are the section 1 operations that the hot path uses.

| | nodegit | es-git | @napi-rs/simple-git | isomorphic-git | wasm-git | dugite |
| --- | --- | --- | --- | --- | --- | --- |
| Loads in Electron 33 unrebuilt | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Latest release | 2020-07-28 (`next` 2026-04-23) | 2026-05-17 | 2026-07-07 | 2026-08-23 | 2026-07-17 | 2026-08-11 |
| libgit2 / git | 1.9.1 fork | ~1.9.3 | 1.9.4 | n/a | 1.9.4 | git 2.53.0 |
| `write-tree` | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| `read-tree` (`applyTree`) | ✅ | **❌** | **❌** | ✅ | ❌ | ✅ |
| `commit-tree` | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| `update-ref` / `for-each-ref` | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| `add -A` with exclude pathspecs | ✅ | ✅ | ⚠️ narrow | **❌ no globs** | ❌ | ✅ |
| `status --porcelain` | ✅ | ✅ | ✅ | ✅ better | ❌ | ✅ |
| `.gitattributes` honored | ✅ | ✅ read | ❌ | **❌ none** | ❌ | ✅ |
| `core.autocrlf` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Signing | ✅ | ⚠️ pass a signature | ❌ | ✅ callback | ❌ | ✅ |
| Hooks | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

The `read-tree` row is decisive. The undo journal is built from `read-tree`, and the two
candidates that clear the Electron constraint fail that operation.

## 4. Correctness and compatibility risks

Every risk in this section is a correctness risk rather than a performance one. A subprocess
that calls the author's own `git` binary matches that binary's behaviour by definition. Any
other implementation matches only as far as it has reimplemented git's behaviour. Where it
diverges, the symptom in this codebase is a tree hash that does not match rather than a crash,
and that surfaces as the undo journal refusing a valid undo with "the workspace has changed…
since that command ran".

### Line endings, and why they move a tree hash

`initRepoAt` sets `core.autocrlf false` on repositories the app creates, with the comment that
the branch editor patches scene prose byte-exactly. It does not (and cannot) control
repositories the author already had. This machine's global `core.autocrlf` is `true` (the
Windows default from Git for Windows' installer), so an author who runs `git init` themselves
and then opens the directory in the app gets a repository where the setting is on.

libgit2 implements the CRLF filter and reads `core.autocrlf`, and isomorphic-git reads it too,
so this is not an outright hole. The two filters can still diverge. If git's filter and a
library's filter disagree, the blob hash changes, which changes the tree hash, and
`UndoJournal.check` then compares a tree the library wrote against a tree git wrote and
concludes the workspace drifted. That failure is silent and intermittent, and it looks like a
bug in undo rather than a bug in hashing.

This risk most deserves the differential harness in section 5.

### The index and the lockfile

The author is expected to use git themselves. The whole design assumes it, and the agent tools
expose `commit`, `revert` and `restore` for the author to drive. Two processes writing
`.git/index.lock` contend, and git does not retry the same way a library does.
`withScratchIndex` already keeps the app off the author's index for snapshots, which is correct
and should survive any migration. `Committer.commit` and the agent's `commit` tool do use the
real index and would be the contention points.

A library also writes an index that git then has to read. libgit2 writes V2/V3 indexes with the
TREE and EOIE extensions, which git reads, but git also maintains extensions libgit2 does not
write. A later git command may therefore be unable to use the cache and redo that work without
reporting it. That is a performance consequence rather than a correctness one, and this
consequence weakens the case for the migration itself.

### fsmonitor and the untracked cache

`core.fsmonitor` is `true` in this monorepo. Neither libgit2 nor isomorphic-git implements
fsmonitor, so a status call through either library ignores the cache that the author's git
maintains. Where fsmonitor is effective, the in-process status can be slower than the
subprocess it replaced, spawn overhead included. Measure this cost rather than assuming it
away.

### Signing

libgit2 does not invoke GPG. es-git accepts a pre-computed signature string; the other N-API
option accepts nothing; isomorphic-git takes an `onSign` callback the caller has to implement.
An author with `commit.gpgsign=true` in their global config would get unsigned commits from the
app and signed ones from their own terminal, in the same repository, with no error and no
notice. Nothing in this repository sets `commit.gpgsign` and it is unset on this machine, so
the exposure depends entirely on the author's own configuration, which the app has no way to
anticipate.

### Hooks

libgit2 declined hooks in 2012 and again in 2015; neither N-API binding runs them, and
isomorphic-git does not either. Nothing in this repository installs hooks — no `.husky`, no
`core.hooksPath`, no non-sample file in `.git/hooks` — so this codebase is not at risk. The
risk falls on an author whose project repository has a `pre-commit` hook, which would stop
running as soon as the app began committing in-process. The impact is low, and nothing reports
the failure.

### .gitignore and .gitattributes

libgit2 implements both. isomorphic-git implements `.gitignore` and has no `.gitattributes`
support at all. The app writes `.gitattributes` marks that matter:
`vngen/state/notifications.jsonl merge=union`, and `-merge` on
`vngen/state/threads/*.native.jsonl`, `vngen/work/graphs/*.json`,
`vngen/work/graphs/lib/*.json` and `.vnstudio/layouts/*.json`. Under isomorphic-git the app
would write those marks and the library would then ignore them.

The severity is lower than it first looks, for the reason given in the last subsection below.
The failure is still the dangerous kind, because a policy that is silently not applied produces
no error at the moment it stops working. That missing error is enough on its own to rule
isomorphic-git out for a codebase whose merge policy is expressed entirely in attributes.

### Submodules

`vendor/path.ux` carries submodules of its own and `vendor/nstructjs` is a third. Submodules
are a risk to development in this repository rather than to an author's project, since a
generated VN project has no submodules. `es-git` and nodegit expose submodules;
`@napi-rs/simple-git` and isomorphic-git do not. Nothing in `@vn/git` touches submodules today,
so the exposure is limited to `status` reporting a submodule's state differently from how git
reports it. That difference would only show up if someone opened this repository as a
workspace.

### Failures are returned here, not thrown

`Git.run` never throws, and every caller in the codebase reads `{ok, stdout, stderr}`. Every
candidate library throws. The change is mechanical but pervasive: it touches every method in
`packages/git/src/git.ts`, and getting it wrong lets an exception escape into a command's
`catch`, where it is recorded as a failed command rather than handled. The sixteen test files
depend on the value-returning contract at the `@vn/git` boundary, so preserving it is a hard
requirement of any migration rather than a refactor to do afterwards.

### Risks that turn out not to apply

**Custom merge drivers.** No library exposes `git_merge_driver_register`, which is usually
listed as a hazard. The missing registration is not a hazard here, because nothing in this
codebase ever merges. The `-merge` and `merge=union` marks are instructions to the author's own
git, which runs the merge; the app only reads the result through porcelain status codes
(`isConflictCode`, covering `DD AU UD UA DU AA UU`). docs/reference/repos-and-commits.md
records that a custom merge driver was considered and rejected because nothing here merges. The
merge-driver column in section 3's table is therefore irrelevant to the decision, and the
`.gitattributes` risk reduces to whether the library writes and preserves the attributes file,
not whether the library acts on it.

**Network operations.** There are none, as established in section 1. libgit2's credential
handling, SSH support and wire protocol version support (normally the largest source of
migration pain) do not apply.

**`git worktree`.** The app never runs `git worktree`. A human runs the worktree workflows in
the development guidance with the real `git` binary, and no migration touches them.

## 5. The recommendation, sized

### Stage 0, which is the whole recommendation

Four changes follow, none of which adds a dependency:

1. 1. **Seed the scratch index in `withScratchIndex`**, removing entries outside the pathspec
   before staging. Prove the seeding by asserting that `writeTree` returns the same hash as the
   current implementation on a project with `vngen/build` and `vngen/state` populated.
2. **Memoize `isRepo`, `topLevel` and the absolute git directory** on the `Git` handle.
3. **Memoize `git.status()` for the duration of one `listGraphs` pass**, by resolving
   `conflictedGraphs` once and passing the set down rather than calling it per graph.
4. **Pass the `head` that `gitState()` already read into both `capture` calls.**

This is about a day's work, most of it on item 1's exclusion handling and on the tree-hash
assertions. The risk is low and bounded by the existing suite, since every one of these changes
preserves behaviour by construction and the suite tests the tree hash.

One mutating command is predicted to drop from ~976 ms to ~595 ms at 200 documents, and from
~2740 ms to ~605 ms at 2000, based on the fixtures. Re-measure afterwards with the deferral
plan's own harness, because the harness figure is the number that has to move.

### If stage 0 is not enough

The residual is about 430 ms per edit across ten spawns, and only an in-process change can
address it. If the residual still matters after stage 0, the next step is narrower than a
migration:

- Add `es-git` behind the existing `@vn/git` interface for the snapshot path only, meaning
  `writeTree`, `commitTree`, `updateRef`, `listRefs` and `head`. Keep `applyTree`, `commit`,
  `status` and everything the agent touches on the subprocess. The snapshot path is where the
  spawns are, and es-git covers it completely.
- Draw the "seam" inside `packages/git/src/git.ts` and preserve the value-returning contract,
  so no caller changes and all sixteen test files run unmodified against both backends.
- Gate everything else on one test. Run the full suite against both backends and assert
  identical tree hashes on every snapshot, on repositories with `core.autocrlf` both `true` and
  `false`. Stop if the hashes diverge. That single assertion covers the CRLF risk, the
  index-format risk and the pathspec risk at once.
- Consider `applyTree` only after that, and only with a stated plan for reconstructing
  `read-tree -u --reset` from `checkoutTree`, tested specifically against file deletions.

That stage costs three to five days for the seam and the differential harness, plus the
packaging work (`EXTERNAL`, the scratch `package.json`, `asarUnpack: ["**/*.node"]`, a fourth
`pnpm smoke` check, and adding `node` back to jest's `moduleFileExtensions`). The total is
roughly a week, and it saves perhaps 300 of the 430 ms, because `status` and the commit path
would stay on the subprocess.

### What would change the recommendation

- **Stage 0 does not deliver the measured drop.** If the seeded index cannot be made to
  produce identical trees under the exclusions in `UNDO_PATHS`, the largest cheap saving is
  lost and the case for the library becomes much stronger.
- **`es-git` or `@napi-rs/simple-git` exposes `read-tree` or reset.** es-git's tracker is
  taking contributions today, so this is a plausible near-term change. It would make a full
  migration coherent rather than partial.
- **An author reports the missing-git failure in real use.** Reporting that failure is
  dugite's responsibility rather than a library's, and adding the report is a smaller change
  than either alternative.
- **The app starts pushing.** The app does not push today. Once it does, libgit2's transport
  and credential handling become the dominant risk, and the recommendation against migrating
  should grow stronger rather than weaker.
- **macOS packaging.** Notarization raises the cost of shipping a native addon, which makes
  the pure-JS and subprocess options relatively cheaper.
- **es-git's `main` stays frozen through Q4 2026.** If it does, the only Electron-safe native
  option with an adequate API is unmaintained, and a subprocess remains the approach
  indefinitely.

## How this was measured

Three throwaway scripts were written outside the repository and are not committed. Each takes a
repository path and an iteration count and reports the mean.

- **Spawn floor and scan cost.** Calls `execFile` in a loop for 30 iterations, discarding one
  warm-up call, over `git --version`, `rev-parse --show-toplevel`, `rev-parse HEAD`, `status
  --porcelain`, `status --porcelain -- docs` and `hash-object README.md`. Runs against this
  monorepo and against a 200-file fixture.
- **Snapshot cost.** Replays `UndoJournal.capture()`'s exact sequence with the same
  `execFile` options `Git.run` uses, the same `UNDO_PATHS` pathspec, and the same
  `GIT_INDEX_FILE` handling, and times each spawn separately. Runs 10 to 20 iterations.
- **The cheap fixes.** The same replay runs with the two repo-invariant probes hoisted out of
  the loop, and with an optional `copyFile` of `.git/index` into the scratch path before `add
  -A`. The tree hash is printed on every run and compared between modes.

There are two fixtures. `tiny` is 200 committed files shaped like a project. `big` is 1000
`wiki/*.md` plus 1000 `scenes/*.fountain`, all committed. Both are created with `core.autocrlf
false`, because this machine's global setting is `true` and would otherwise add filter cost to
every hash.

The environment is Windows 11 Pro 26200, git 2.53.0.windows.1, and Node v24.14.0, on the
repository's own disk. Absolute numbers are machine-specific, and the finding rests on the
ratios between them. The 2026-08-25 measurements are not directly comparable to the deferral
plan's, which used git 2.51 and a different fixture, so the two are reported separately rather
than merged.

The repository facts were read from the source on 2026-08-25 and are cited by file above: the
operation inventory, the spawn counts, the call sites, the Electron version, the packaging and
jest configuration, and the absence of hooks, signing, network git and `git worktree` usage.

## Unverified items

- **N-API stability across Electron is inferred rather than documented.** The inference
  follows from N-API's ABI stability and Electron embedding Node, and napi-rs's CI exercises
  the combination, but neither Node's nor Electron's documentation states the exemption. Load
  the module in a packaged build to confirm the stability before relying on it.
- **es-git in Electron is unattested.** The es-git documentation never mentions Electron, and
  the es-git issue tracker holds no Electron issues.
- The libgit2 version for es-git is inferred from the `git2 = "=0.20.4"` pin and the release
  date, which gives ~1.9.3. The project's own documentation does not state the version.
- **The seeded-index tree equality was proved only on fixtures with no `:(exclude)` terms.**
  Under the real `UNDO_PATHS`, the proof is expected to require removing out-of-pathspec
  entries first, and that removal has not been implemented or tested.
- fsmonitor's effect on a library-backed status was reasoned about rather than measured.
- The ~430 ms residual was calculated from per-spawn measurements, not measured end to end in
  a patched app.

## Primary sources

Repository: `packages/git/src/git.ts` · `packages/git/src/repos.ts` ·
`packages/commands/src/stack.ts` · `packages/commands/src/undo.ts` ·
`packages/commands/src/commit.ts` · `apps/desktop/src/main/doctor.ts` ·
`apps/desktop/src/main/workspace.ts` · `apps/desktop/src/main/graphs.ts` ·
`apps/desktop/electron-builder.yml` · `scripts/package.desktop.mjs` ·
`scripts/aliases.mjs` · `jest.config.cjs` · `scripts/jest-esbuild.cjs` ·
[`plans/archive/deferring-commit-on-save.md`](../plans/archive/deferring-commit-on-save.md) ·
[`reference/repos-and-commits.md`](../reference/repos-and-commits.md) ·
[`guides/github-pages.md`](../guides/github-pages.md)

nodegit: [nodegit/nodegit](https://github.com/nodegit/nodegit) ·
[#1774 Electron context-awareness](https://github.com/nodegit/nodegit/issues/1774) ·
[#2015 Node 22 prebuilds](https://github.com/nodegit/nodegit/issues/2015) ·
[Electron install guide](https://www.nodegit.org/guides/install/electron/) ·
[prebuild bucket listing](https://axonodegit.s3.amazonaws.com/?list-type=2&prefix=nodegit/nodegit/)

N-API bindings: [toss/es-git](https://github.com/toss/es-git) ·
[es-git.dev](https://es-git.dev/getting-started.html) ·
[Brooooooklyn/simple-git](https://github.com/Brooooooklyn/simple-git) ·
[crates.io libgit2-sys](https://crates.io/crates/libgit2-sys)

Subprocess and pure-JS: [steveukx/git-js](https://github.com/steveukx/git-js) ·
[desktop/dugite](https://github.com/desktop/dugite) ·
[desktop/dugite-native](https://github.com/desktop/dugite-native) ·
[isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) ·
[petersalomonsen/wasm-git](https://github.com/petersalomonsen/wasm-git)

gitoxide: [GitoxideLabs/gitoxide](https://github.com/GitoxideLabs/gitoxide) ·
[crate-status.md](https://github.com/GitoxideLabs/gitoxide/blob/main/crate-status.md) ·
[#463 WASM support, not planned](https://github.com/GitoxideLabs/gitoxide/issues/463) ·
[@hologit/holo-tree](https://www.npmjs.com/package/@hologit/holo-tree)

libgit2 hooks: [#964](https://github.com/libgit2/libgit2/issues/964) ·
[#3004](https://github.com/libgit2/libgit2/pull/3004)

Packaging: [electron-builder asar.smartUnpack](https://www.electron.build/configuration.html) ·
[esbuild: what it cannot bundle](https://esbuild.github.io/content-types/#file)
