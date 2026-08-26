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

Researched and measured 2026-08-25. The library facts come from the npm registry's own
`time` maps, the projects' repositories, and their published type declarations, all read
on that date; staleness is flagged where it is the finding. The timings come from this
machine (Windows 11, git 2.53.0.windows.1, Node v24.14.0) using throwaway scripts
described at the end, against fixture repositories built for the purpose. Prior timings
are taken from the "Measured" section of
docs/plans/archive/deferring-commit-on-save.md rather than re-derived, and are labelled
where they are used.

## Recommendation

**Do not replace the subprocess. Four changes inside `@vn/git` and its callers take back
most of what a library would take back, cost about a day, add no dependency, and remove the
one part of the cost that grows with the size of the author's project.** Seed the scratch
index from the real one before `writeTree` stages into it, memoize the answers that cannot
change for the life of a repo handle (`isRepo`, `rev-parse --absolute-git-dir`,
`topLevel`), memoize `git.status()` across one `listGraphs` pass, and pass the `head` the
command stack already read into both snapshots. On a 2000-document fixture the first two
alone take one undo snapshot from 1269 ms to 219 ms, producing a byte-identical tree. On a
200-document fixture they take it from 388 ms to 214 ms.

The counterweight belongs here rather than at the end. After those fixes roughly ten
subprocesses remain per mutating command, costing about 430 ms on Windows, and almost all
of that is process startup. That is real, it is on the interactive path, and an
in-process library is the only thing that removes it. The reason to decline it anyway is
that the two libraries which load in Electron without an ABI rebuild — `es-git` and
`@napi-rs/simple-git` — neither expose `read-tree`, which is exactly what `Git.applyTree`
is built from, so the undo restore path cannot be ported to either one without
reimplementing it against a different primitive. Reimplementing the restore path is the
last thing in this codebase that should be approximated.

## 1. What this repo asks git to do

### The surface

Everything goes through `packages/git/src/git.ts`, which is 341 lines and the only place
in the repository that spawns `git`. Its `run()` uses `execFile` (never a shell), passes
`windowsHide`, sets `GIT_INDEX_FILE` when a scratch index is in play, and returns
`{ok, stdout, stderr}` rather than throwing on a non-zero exit.

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

`withScratchIndex` is the reason two of those cost three spawns: it asks git where the git
directory is, points `GIT_INDEX_FILE` at a per-process file inside it, and removes the file
in a `finally`. Nothing here ever stages into the author's own index.

### Where the calls come from, and how often

The hot path is one mutating, undoable command in the desktop app, which is what an author
triggers by typing in the script editor or dragging a node. `CommandStack.runCommand`
(`packages/commands/src/stack.ts`) runs, in order, a flush of any deferred commit batch,
`gitState()`, an undo `capture('pre')`, the command's own work, a `capture('post')`, and
then either a commit or a deferral. Against a single repository that is:

| Step | Spawns | Notes |
| --- | --- | --- |
| `gitState()` | 3 | `isRepo`, `head`, `isDirty` |
| `capture('pre')` | 7 | `isRepo`, `writeTree` (3), `commitTree`, `head`, `updateRef` |
| the command's own read and write | ~2 | measured as such in the deferral plan |
| `capture('post')` | 7 | the same seven |
| the commit | 0, or 5 when the batch flushes | `isRepo` plus `commit`'s four |

Seventeen to nineteen spawns per edit, which matches the deferral plan's own count of 24
before batching landed, minus the five that `Committer.commit` no longer runs on every
command.

`defersCommit` does not reduce this. It defers the commit, and `capture` runs regardless,
so a gesture command sent once per frame still pays `gitState` plus two snapshots on every
frame. That is what makes this latency-critical rather than merely slow.

Everything else is colder:

- **Doc-tree rebuild.** `listGraphs` in `apps/desktop/src/main/graphs.ts` calls `readGraph`
  per graph, and each `readGraph` calls `conflictedGraphs`, which calls `git.status()` —
  two spawns, unmemoized, once per graph. A project with ten bound graphs pays twenty
  spawns of the most expensive command in the surface for one answer that is identical
  across all ten.
- **Startup.** `checkGit()` in `apps/desktop/src/main/doctor.ts` spawns `git --version`
  once. `RepoResolver` resolves each directory with `rev-parse --show-toplevel` and
  memoizes it. `ensureRepo` may `init` and set config. `commitScaffolding` writes up to
  three commits, and `checkpoint('Changes made outside the app')` sweeps anything the
  author changed while the app was closed.
- **Undo and redo.** `journal.check` costs four spawns per repo and `journal.restore`
  three, but both are user-initiated and infrequent.
- **The authoring agent.** `packages/authoring/src/tools.ts` exposes `status`, `log`,
  `show`, `diff`, `commit`, `revert`, `restore` and `init` as tools. Each is one turn of a
  conversation, so the subprocess cost disappears into the model's latency.
- **GitHub Pages.** `project.installPages` writes files and nothing else;
  `pagesState` costs three spawns. Commit-on-save commits the result. The app never
  pushes.

### Plumbing versus porcelain

The undo journal — the expensive half — is already entirely plumbing: `write-tree`,
`commit-tree`, `update-ref`, `for-each-ref`, `read-tree`, and `rev-parse` in its
object-naming role. It ports cleanly in principle, because every one of those has a
one-to-one libgit2 equivalent and none of them parses human-facing output.

The porcelain is thinner than it looks. `status --porcelain` is the only porcelain output
the code parses, and `--porcelain` is defined by git as a stable machine format, so it is
porcelain by command name rather than by risk. `commit`, `add`, `revert` and `restore` are
invoked for their effect and checked by exit code, except for `commit`'s one string match
against `nothing to commit|no changes added to commit`, which is a real fragility and the
only place a git message string is load-bearing.

### What is not there

There is no network git anywhere in the codebase. No push, no fetch, no clone, no pull, in
`packages/git`, in `apps/desktop/src/main`, or in `packages/authoring/src`.
docs/guides/github-pages.md states it directly: commit-on-save commits everything, and the
app never pushes. This removes libgit2's hardest and least reliable area — transport,
credential helpers, SSH — from the evaluation entirely, and it is the single biggest reason
a migration here would be less dangerous than the usual case.

There is also no `git worktree` usage at runtime. The word appears in the codebase only as
"working tree".

## 2. Whether a library would actually help

### Three costs that get conflated

**Process startup.** On this machine `git --version` costs 36.5 ms and does nothing.
Every single-command probe in the surface lands between 37 and 46 ms:
`rev-parse --show-toplevel` 37.7 ms, `rev-parse HEAD` 38.6 ms, `hash-object README.md`
39.3 ms. This is a Windows floor, and it is per spawn regardless of what the command does.
An in-process library removes it completely.

**The worktree scan.** `status --porcelain` costs 167.0 ms in this monorepo and 47.2 ms in
a 200-file project-shaped repository. Subtracting the spawn floor leaves roughly 130 ms of
scan here and roughly 10 ms there. The monorepo number is inflated by `node_modules` and
the vendor submodules, which an author's project does not have. Scoping the same call to
`-- docs` brings it to 46.3 ms, so the scan is pathspec-sensitive and can be narrowed
without any new dependency. A library does not remove this cost; libgit2 does the same
walk.

**Object hashing and index writing.** This is real work proportional to the number of
files in the pathspec, and no library removes it either. What a library could do is avoid
paying it twice, and that turns out to be where the money is.

### What the deferral plan measured, and what it did not vary

docs/plans/archive/deferring-commit-on-save.md measured one edit as the mean of 20, on
Windows 11 with git 2.51, in a project carrying 2000 committed assets: `exec` 1004 ms
across 24 subprocesses, of which `gitState()` was 113 ms in 3, the two `capture` calls
566 ms in 14, `Committer.commit` 232 ms in 5, and the command's own read and write 93 ms
in 2. It concluded that "the time is process startup, not tree size", on the strength of
1012 / 1004 / 1011 ms at 0, 2000 and 6000 assets, and that "any alternative that narrows a
pathspec instead buys nothing." After the change shipped it re-measured 1036.4 → 824.7 ms
wall clock and 967.9 → 747.3 ms in `exec`.

That conclusion is correct for what it varied, and it is worth being precise about why.
`UNDO_PATHS` is `['.', ':(exclude)vngen/build', ':(exclude)vngen/state']`, so the assets
the plan added were excluded from the snapshot pathspec by construction. The experiment
varied the number of files the snapshot never looks at. It did not vary the number of
files the snapshot does look at, which is the count of scenes, wiki pages, character
sheets, graphs and layouts — the documents.

### The scratch index re-hashes every document, every snapshot

`withScratchIndex` starts from a file that does not exist. `git add -A` against an empty
index has no stat cache to consult, so it re-hashes every file in the pathspec, on every
snapshot, twice per command. Replaying `UndoJournal.capture()`'s exact seven-spawn sequence:

| Fixture | `add -A` | One `capture()` |
| --- | --- | --- |
| 200 documents | 133.3 ms | 388.4 ms |
| this monorepo | 280.3 ms | 574.1 ms |
| 2000 documents | 937.7 ms | 1268.9 ms |

At 2000 documents one snapshot costs 1.27 s and two-thirds of it is hashing, not spawning.
Two snapshots per edit is 2.5 s. That is a growth curve the deferral plan reports as
absent, because its axis was the wrong one.

Copying the real `.git/index` into the scratch path first — one file copy, about 1 ms —
gives `add -A` a valid stat cache and a valid cache-tree extension, so it hashes nothing
that has not changed and `write-tree` reuses subtree hashes it already has:

| Fixture | `add -A` | `write-tree` | One `capture()`, probes memoized |
| --- | --- | --- | --- |
| 200 documents, empty scratch index | 133.2 ms | 53.1 ms | 316.9 ms |
| 200 documents, seeded | 42.1 ms | 41.3 ms | 214.3 ms |
| 2000 documents, empty scratch index | 910.2 ms | 114.6 ms | 1156.6 ms |
| 2000 documents, seeded | 44.3 ms | 43.9 ms | 218.9 ms |

The tree hash is identical either way — `0983b4ab…` on the 200-document fixture and
`b1fc9b12…` on the 2000-document one, both routes — which is the property that matters,
because the undo journal's drift check compares tree hashes and a divergence there would
refuse valid undos.

One caveat, which is why this is a day's work rather than an afternoon's. Both fixtures
have no `:(exclude)` terms. The real `UNDO_PATHS` does, so a copied index carries entries
for `vngen/build` and `vngen/state` that the pathspec is supposed to leave out, and the
resulting tree would differ. The seeded index needs those entries removed first — one
`git rm --cached -r --ignore-unmatch` per excluded prefix against the scratch index, or a
`read-tree` of the previous snapshot's tree instead of a copy of the live index. Whichever
is chosen, it has to be proved by comparing tree hashes against the current implementation
on a project that actually has both directories populated.

### What is left after the cheap fixes

Memoizing `isRepo` and `rev-parse --absolute-git-dir` for the life of a repo handle removes
two spawns from every `capture` and one from every `gitState`. With that and the seeded
index, one mutating command against a project-shaped repository costs roughly:

| Step | Spawns | Cost |
| --- | --- | --- |
| `gitState()` | 2 | ~87 ms |
| `capture('pre')` | 5 | ~214 ms |
| the command's own work | ~2 | ~80 ms |
| `capture('post')` | 5 | ~214 ms |
| **total** | **~14** | **~595 ms** |

Against ~976 ms at 200 documents and ~2740 ms at 2000 documents today. The 2000-document
case becomes ~605 ms, meaning the fixes remove the growth curve as well as most of the
constant.

And then the residual is almost pure spawn overhead: twelve to fourteen processes at
roughly 43 ms each. Passing the `head` that `gitState` already fetched into both captures
removes two more. Ten spawns, about 430 ms, is the floor this design reaches on Windows
without changing what it runs on.

So the win a library is competing for is real, and it is around 400 ms per edit. It is not
a rounding error and this report does not claim it is. Section 3 gives the reasons the
price is too high anyway.

### The alternatives to a library, ranked

1. **Seed the scratch index.** Removes 90 ms per snapshot at 200 documents and 870 ms at
   2000. Largest single win, no dependency, and it is the only item here that changes the
   scaling behaviour rather than the constant.
2. **Memoize the repo-invariant probes.** Three spawns per command, roughly 130 ms. The
   answers cannot change while a repo handle is alive; `RepoResolver` already memoizes
   `topLevel` this way, so the pattern exists.
3. **Memoize `git.status()` across one `listGraphs` pass.** Removes 2(N−1) spawns per
   doc-tree rebuild. On a project with ten graphs that is eighteen spawns and, at monorepo
   scan cost, most of a second. This one is closer to a bug than an optimization.
4. **Pass the known `head` into `capture`.** Two spawns, ~80 ms.
5. **Narrow the `isDirty` pathspec.** The deferral plan found this bought nothing, and its
   finding stands: the scan is 10 ms in a project-shaped repository, so narrowing it saves
   nothing worth the risk of getting the pathspec wrong.
6. **`core.fsmonitor`.** Helps the scan, which is the cost that is already small in a
   project-shaped repository. It is already `true` in this monorepo. Not worth configuring
   into projects the app creates.
7. **A long-running git helper.** There is no protocol for this. `git cat-file --batch`
   covers object reads and `hash-object --stdin-paths` covers hashing, and neither touches
   the index operations that dominate here. This is not an available option.

Items 1 through 4 are the recommendation. They are additive with a library rather than
alternative to it — a library would still want a warm index — so doing them first costs
nothing even in the world where a migration eventually happens.

## 3. The libraries, against this repo's constraints

### The four constraints they have to clear

**Electron.** `apps/desktop` runs Electron 33.4.11 (`^33.2.0`), which embeds Node 20.
A NAN or raw-V8 addon needs a rebuild against Electron's ABI, per Electron release. A
strictly Node-API addon does not, provided it targets a `NAPI_VERSION` the embedded Node
supports, is built with `win_delay_load_hook`, and is loaded in the main process — the
renderer is sandboxed and has no Node environment, so `@vn/git`'s home in main is a
requirement rather than a convenience. Neither Node's nor Electron's documentation states
an explicit Electron exemption for N-API stability; it follows from N-API being ABI-stable
and Electron embedding Node, and napi-rs tests it continuously, but it is inference rather
than a published guarantee.

**Packaging.** `scripts/package.desktop.mjs` writes a scratch `package.json` whose
`dependencies` are exactly the three runtime externals, then runs
`pnpm install --ignore-workspace --config.node-linker=hoisted` because pnpm's symlink farm
does not survive being copied into an app image. A native module would have to be added to
that list and to `EXTERNAL` in `scripts/aliases.mjs`, since esbuild cannot bundle a `.node`
file. `apps/desktop/electron-builder.yml` sets `asar: true` and unpacks only esbuild's
platform packages; electron-builder's `smartUnpack` usually catches `.node` files but has
a documented history of both over- and under-unpacking, so `asarUnpack: ["**/*.node"]`
would be added explicitly rather than trusted. `pnpm smoke` would need a fourth check,
because it exists precisely to catch a module that resolves in the repo and not in the
image. No code signing is configured today and only Windows is targeted, so signing an
addon is a latent cost rather than a present one; it becomes real the day macOS is
packaged, since notarization requires every nested Mach-O to be signed.

**Tests.** Sixteen test files exercise real git against real temporary repositories —
`packages/git` (23 tests), `packages/commands` (82), `packages/authoring` (212) and
`apps/desktop` (178). That suite is the strongest asset in this whole question: it is a
ready-made differential harness, and any replacement has to pass it unchanged. Two
mechanical obstacles sit in front of it. `scripts/jest-esbuild.cjs` transpiles to CommonJS
and documents that `transformSync` never lowers `import()` to `require`, so a candidate
must have a working CommonJS entry point. And `jest.config.cjs` overrides
`moduleFileExtensions` to `['ts', 'tsx', 'js', 'json']`, dropping jest's default `node`
entry, so a package that resolves its addon without an explicit extension will not resolve
under test. Separately, the desktop jest project is node-only, so tests would exercise
Node 24's ABI while the shipped app exercises Electron 33's — the two would need to be
kept in agreement by something other than the test suite.

**Reach.** `@vn/cli` does not depend on `@vn/git`, and neither does `@vn/pipeline` or
`@vn/scheduler`. The `vngen` bundle contains no git code at all, so nothing about this
question touches it. `@vn/authoring-app` and `@vn/desktop` both depend on `@vn/git`, so
`vnauthor` and the desktop app are the only two hosts affected.

**The runtime check.** `checkGit()` spawns `git --version` at startup and, on failure,
files a durable note and lets the app open read-only. An in-process library removes that
failure mode outright, which is a genuine benefit and not only a performance one. Note
that `apps/desktop/src/main/doctor.ts` already records the alternative and declines it: a
portable git "would add tens of megabytes and a second thing to keep patched, to solve a
problem only Windows has."

### nodegit

The `latest` tag is `0.27.0`, published 2020-07-28, which is six years old as of today. It
tops out at Node ABI 83
and Electron 10, so it cannot run here at all. Real use means the `next` tag,
`0.28.0-alpha.38` (2026-04-23), an alpha line that has run since 2020 and reached its
thirty-eighth iteration without ever being promoted. The repository is alive — last commit
2026-07-16, titled "Update maintainers" — with 363 open issues.

It vendors its own libgit2 fork at 1.9.1 plus patches. Prebuilds come from a private S3
bucket via `node-pre-gyp` with `--fallback-to-build`, which means a missing prebuild
silently starts compiling libgit2, OpenSSL and libssh2 on the user's machine. Enumerating
that bucket shows `0.28.0-alpha.38` carrying Node ABIs 115/127/137 and exactly one Electron
ABI, `electron-v41.3`. This app is on Electron 33. There is no prebuild for it, and the
escape hatch is a source build on every install.

It is also still NAN-bound rather than context-aware: issue #1774, "Make nodegit
context-aware for compatibility with Electron 9 and beyond", has been open since
2020-05-24. Its own Electron install guide still uses `target = 1.2.8` as the example, an
Electron released in 2016.

nodegit has by far the most complete API of anything here, including `read-tree`, reset,
worktrees, submodules, gitattributes and signatures. None of that matters. It is ruled out
on the ABI and prebuild story alone.

### es-git

Latest `0.7.0`, published 2026-05-17. napi-rs binding, Node-API v6, so the same `.node`
loads in Node 20/22/24 and in Electron with no rebuild and no `electron-rebuild` step.
libgit2 ~1.9.3, statically vendored. Ten platform triples including musl. 327 stars,
20 open issues.

The maintenance signal is mixed and worth stating plainly: `main` has not moved since the
0.7.0 release three months ago, while pull requests are still arriving as recently as
today, including one to automate the release process. Contributions are coming in; merges
and releases are not. If that stays true through the end of 2026 it should be treated as
at-risk.

Its API is the most complete of the N-API options: `Index.writeTree`, `addAll` with
pathspecs, `statuses`, `commit` with `updateRef` and a pre-computed signature,
`isPathIgnored`, `getAttr`, worktrees, submodules, stash, rebase. It does not expose
`read-tree` and it does not expose reset. `Index.read(force)` reads the index from disk, not
a tree into the index. That is the blocker named in the recommendation: `Git.applyTree`
is `read-tree <from>` followed by `read-tree -u --reset <to>`, and the nearest
reconstruction available is `setHead` plus `checkoutTree` with force, which is a different
operation with different behaviour for files that exist in `from` and not in `to`.

Its documentation never mentions Electron and its issue tracker contains no Electron
issues. It should work by construction; it is untested territory.

### @napi-rs/simple-git

Latest `1.1.0`, published 2026-07-07, last commit 2026-08-10, one open issue, ~362k
downloads a week — thirty times es-git's. libgit2 1.9.4, the newest here. Fifteen platform
triples, the widest coverage of anything evaluated, including musl, FreeBSD and win32-ia32.
Node-API v6, so the same no-rebuild story as es-git. Maintained by napi-rs's own author,
which means the toolchain and the binding move together.

The API is roughly half of es-git's. It has `Index.writeTree`, `addAll`, `statuses` with an
async and cancellable variant, `commit`, `checkoutTree`, `Config` read and write. It has no
`read-tree`, no reset, no worktrees, no submodules, no `isPathIgnored`, no gitattributes
access, and no way to pass a signature to a commit. It cannot do the undo restore path
either, and it additionally cannot answer the ignore and attribute questions.

Note that it is unrelated to `simple-git`, which is a subprocess wrapper of the same name.

### isomorphic-git

Pure JavaScript, no native code, no ABI, no prebuilds, no packaging consequences at all.
`1.41.9` published 2026-08-23, two days ago, and currently the fastest-moving project in
this list: seventeen releases in August 2026 alone after a quiet 2024. 1.8M downloads a
week.

It is the only candidate that covers the whole plumbing set: `writeTree`, `readTree`,
`hashBlob`, `resetIndex`, `updateIndex`, and a `statusMatrix` that is a better shape for
this code than porcelain parsing. It reads `core.autocrlf` and applies it. It supports
signing through an `onSign` callback.

Three things count against it here. Its `add` takes paths and directories but no glob or
magic pathspecs, so `':(exclude)vngen/build'` has no equivalent and `UNDO_PATHS` would have
to be reimplemented as an explicit traversal with exclusions applied in JavaScript, which
is the same divergence risk as the restore path applied to the snapshot path. It has no
`.gitattributes` support whatsoever, discussed in section 4. And its cache is unbounded by
design; its own documentation describes this as a memory leak in long-running processes,
and an Electron main process holding a workspace open for hours is one.

### wasm-git

libgit2 1.9.4 via Emscripten, `0.0.17` published 2026-07-17, actively maintained after a
long gap. No ABI and no prebuild concerns.

It is disqualified on shape rather than status. It exposes libgit2's *examples* CLI through
`callMain(argv)` — string arrays in, stdout out — and that example program implements no
`write-tree`, no `read-tree`, no `hash-object`, no reset, and no `status --porcelain`. It
also operates on an Emscripten virtual filesystem, so reaching real repository paths means
a NODEFS mount and re-setting the working directory before each call. For a desktop app
operating on real paths this is the wrong tool.

### dugite, and the bundled-git option

`3.2.3`, published 2026-08-11, nine open issues, `engines: node >= 20`. It is a subprocess
wrapper like `@vn/git`, but it bundles its own git — 2.53.0 in the current release, fetched
by a postinstall script and checksum-pinned — across eight platforms. It is what GitHub
Desktop uses, so it is proven in exactly this scenario.

It does nothing for latency. It spawns the same processes at the same cost. What it does
is remove the missing-git failure mode and pin the git version, which eliminates every
correctness risk in section 4 at once, because the semantics are real git's by
construction. The price is roughly 50 MB in the image, a postinstall network download, and
`extraResources` plus `GIT_EXEC_PATH` wiring — which is the cost the comment in
`apps/desktop/src/main/doctor.ts` already weighed and declined.

It is listed here because it is the correct answer to a different question. If the
missing-git failure mode ever becomes the pain rather than the latency, this is the option,
and it is a much smaller change than a library migration.

### What is not out there

There is no gitoxide binding for Node worth considering. Every plausible npm name is
unclaimed, and the npm keyword `gitoxide` has zero packages. The one real find,
`@hologit/holo-tree` (a napi-rs binding to `gix`, first published 2026-06-29), is bare-repo
only — no index, no working directory, no status — and gets about 97 downloads a month.
Gitoxide itself is thriving, but its own `crate-status.md` lists "tree from index" as
unimplemented, so even a binding written tomorrow would not cover the operation this
codebase leans on hardest. Gitoxide closed its WASM support issue as `not_planned` on
2026-07-22.

No new libgit2 N-API binding has appeared since es-git.

### Coverage against the inventory

Operations are the ones from section 1 that the hot path actually uses.

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

The `read-tree` row is the decisive one. The two candidates that clear the Electron
constraint fail the operation the undo journal is built from.

## 4. Correctness and compatibility risks

Every risk in this section is a correctness risk, not a performance one. A subprocess
calling the author's own `git` binary agrees with the author's own `git` binary by
definition. Anything else agrees only as far as it has reimplemented git's behaviour, and
where it diverges, the symptom in this codebase is not a crash — it is a tree hash that
does not match, which surfaces as the undo journal refusing a valid undo with "the
workspace has changed… since that command ran".

### Line endings, and why they move a tree hash

`initRepoAt` sets `core.autocrlf false` on repositories the app creates, with the comment
that the branch editor patches scene prose byte-exactly. It does not, and cannot, control
repositories the author already had. This machine's global `core.autocrlf` is `true`, which
is the Windows default from Git for Windows' installer, so an author who runs
`git init` themselves and then opens the directory in the app gets a repository where the
setting is on.

libgit2 implements the CRLF filter and reads `core.autocrlf`, and isomorphic-git reads it
too, so this is not an outright hole. It is a divergence surface: any disagreement between
git's filter and a library's filter changes the blob hash, which changes the tree hash,
which makes `UndoJournal.check` compare a tree the library wrote against a tree git wrote
and conclude the workspace drifted. The failure is silent, intermittent, and looks like a
bug in undo rather than a bug in hashing.

This is the risk that most deserves the differential harness in section 5.

### The index and the lockfile

The author is expected to use git themselves — the whole design assumes it, and the agent
tools expose `commit`, `revert` and `restore` for the author to drive. Two processes
writing `.git/index.lock` contend, and git's retry behaviour and a library's are not the
same. `withScratchIndex` already keeps the app off the author's index for snapshots, which
is the right shape and should survive any migration; `Committer.commit` and the agent's
`commit` tool do use the real index and would be the contention points.

A library also writes an index git then has to read. libgit2 writes V2/V3 indexes with the
TREE and EOIE extensions, which git reads, but git also maintains extensions libgit2 does
not write, and the practical effect is that git's next command may find a cache it cannot
use and quietly do more work. That is a performance consequence rather than a correctness
one, and it cuts against the migration's own case.

### fsmonitor and the untracked cache

`core.fsmonitor` is `true` in this monorepo. libgit2 does not implement fsmonitor and
isomorphic-git does not either, so a status call through a library ignores a cache the
author's git is maintaining. In a repository where fsmonitor is doing real work, the
in-process status can be slower than the subprocess it replaced, spawn overhead included.
This should be measured before it is assumed away.

### Signing

libgit2 does not invoke GPG. es-git accepts a pre-computed signature string; the other
N-API option accepts nothing; isomorphic-git takes an `onSign` callback the caller has to
implement. An author with `commit.gpgsign=true` in their global config would get unsigned
commits from the app and signed ones from their own terminal, in the same repository, with
no error and no notice. Nothing in this repository sets `commit.gpgsign` and it is unset on
this machine, so the exposure is entirely to the author's own configuration — which is
exactly the configuration the app cannot see coming.

### Hooks

libgit2 declined hooks in 2012 and again in 2015; neither N-API binding runs them, and
isomorphic-git does not either. Nothing in this repository installs hooks — no `.husky`, no
`core.hooksPath`, no non-sample file in `.git/hooks` — so the risk is not to this codebase.
It is to an author whose project repository has a `pre-commit` hook, which would stop
running the moment the app started committing in-process. The impact is low and the
detection is zero.

### .gitignore and .gitattributes

libgit2 implements both. isomorphic-git implements `.gitignore` and has no
`.gitattributes` support at all. The app writes `.gitattributes` blocks that matter:
`vngen/state/notifications.jsonl merge=union`, and `-merge` on
`vngen/state/threads/*.native.jsonl`, `vngen/work/graphs/*.json`,
`vngen/work/graphs/lib/*.json` and `.vnstudio/layouts/*.json`. Under isomorphic-git those
marks would be written and then ignored by the library that wrote them.

The severity is lower than it first looks, and the last subsection below explains why. The
failure is still the dangerous kind, because a policy that is silently not applied produces
no error at the moment it stops working, and that is enough on its own to rule
isomorphic-git out for a codebase whose merge policy is expressed entirely in attributes.

### Submodules

`vendor/path.ux` carries submodules of its own and `vendor/nstructjs` is a third. This is a
risk to development in this repository rather than to an author's project, since a
generated VN project has no submodules. `es-git` and nodegit expose submodules;
`@napi-rs/simple-git` and isomorphic-git do not. Since nothing in `@vn/git` touches
submodules today, the exposure is limited to `status` reporting a submodule's state
differently from git's, which would only show up if someone opened this repository as a
workspace.

### Failures are returned here, not thrown

`Git.run` never throws, and every caller in the codebase reads `{ok, stdout, stderr}`. Every
library here throws. That is a mechanical change but a pervasive one: it touches every
method in `packages/git/src/git.ts`, and the failure mode of getting it wrong is an
exception escaping into a command's `catch` and being recorded as a failed command rather
than handled. Preserving the value-returning contract at the `@vn/git` boundary is what
would keep the sixteen test files honest, and it should be treated as a hard requirement of
any migration rather than a refactor to do afterwards.

### Risks that turn out not to apply

**Custom merge drivers.** No library exposes `git_merge_driver_register`, and this is
usually listed as a hazard. It is not one here. Nothing in this codebase ever merges. The
`-merge` and `merge=union` marks are instructions to the author's own git, which runs the
merge; the app only ever *reads* the result through porcelain status codes
(`isConflictCode`, covering `DD AU UD UA DU AA UU`). docs/reference/repos-and-commits.md
records that a custom merge driver was considered and rejected for exactly this reason. So
the merge-driver column in section 3's table is irrelevant to the decision, and the
`.gitattributes` risk reduces to whether the library *writes and preserves* the attributes
file, not whether it acts on it.

**Network operations.** There are none, as established in section 1. libgit2's credential
handling, SSH support and wire protocol version support — normally the largest source of
migration pain — do not apply.

**`git worktree`.** The app never runs it. The worktree workflows in the development
guidance are a human's, driven by the real `git` binary, and no migration touches them.

## 5. The recommendation, sized

### Stage 0, which is the whole recommendation

Four changes, none of which adds a dependency:

1. **Seed the scratch index in `withScratchIndex`**, removing entries outside the pathspec
   before staging. Prove it by asserting that `writeTree` returns the same hash as the
   current implementation on a project with `vngen/build` and `vngen/state` populated.
2. **Memoize `isRepo`, `topLevel` and the absolute git directory** on the `Git` handle.
3. **Memoize `git.status()` for the duration of one `listGraphs` pass**, by resolving
   `conflictedGraphs` once and passing the set down rather than calling it per graph.
4. **Pass the `head` that `gitState()` already read into both `capture` calls.**

This is about a day's work, most of it on item 1's exclusion handling and on the tree-hash
assertions. The risk is low and bounded by the existing suite, since every one of these
changes preserves behaviour by construction and the tree hash is the thing under test.

The fixtures predict that one mutating command drops from ~976 ms to ~595 ms at 200
documents, and from ~2740 ms to ~605 ms at 2000. Re-measure with the deferral plan's own
harness afterwards, because that is the number that has to move.

### If stage 0 is not enough

The residual is about 430 ms per edit across ten spawns, and it is genuinely only
addressable in-process. If it still matters after stage 0, the next step is narrower than a
migration:

- Add `es-git` behind the existing `@vn/git` interface for the snapshot path only, meaning
  `writeTree`, `commitTree`, `updateRef`, `listRefs` and `head`. Keep `applyTree`,
  `commit`, `status` and everything the agent touches on the subprocess. That is where the
  spawns are, and it is the part es-git covers completely.
- Draw the seam inside `packages/git/src/git.ts`, preserving the value-returning contract,
  so no caller changes and all sixteen test files run unmodified against both backends.
- Gate everything else on one proof. Run the full suite against both backends and assert
  identical tree hashes on every snapshot, on repositories with `core.autocrlf` both
  `true` and `false`. If the hashes ever diverge, stop. That single assertion covers the
  CRLF risk, the index-format risk and the pathspec risk at once.
- Only then consider `applyTree`, and only with a stated plan for reconstructing
  `read-tree -u --reset` from `checkoutTree`, tested against file deletions specifically.

That stage costs three to five days for the seam and the differential harness, plus the
packaging work (`EXTERNAL`, the scratch `package.json`, `asarUnpack: ["**/*.node"]`, a
fourth `pnpm smoke` check, and adding `node` back to jest's `moduleFileExtensions`). Call
it a week, and note that it buys perhaps 300 of the 430 ms, because `status` and the commit
path would stay on the subprocess.

### What would change the recommendation

- **Stage 0 does not deliver the measured drop.** If the seeded index cannot be made to
  produce identical trees under `UNDO_PATHS`' exclusions, the largest cheap win evaporates
  and the library case gets much stronger.
- **`es-git` or `@napi-rs/simple-git` exposes `read-tree` or reset.** es-git's tracker is
  taking contributions today; this is a plausible near-term change. It would make a full
  migration coherent rather than partial.
- **An author reports the missing-git failure in the wild.** That is dugite's case, not a
  library's, and it is a smaller change than either.
- **The app starts pushing.** It does not today, and the moment it does, libgit2's
  transport and credential handling become the dominant risk and the recommendation should
  harden against migrating rather than soften.
- **macOS packaging.** Notarization makes a native addon meaningfully more expensive and
  makes the pure-JS and subprocess options relatively cheaper.
- **es-git's `main` stays frozen through Q4 2026.** Then the only Electron-safe native
  option with an adequate API is unmaintained, and the answer is subprocess indefinitely.

## How this was measured

Three throwaway scripts, written outside the repository and not committed. Each takes a
repository path and an iteration count and reports the mean.

- **Spawn floor and scan cost.** `execFile` in a loop, one warm-up call discarded, 30
  iterations, over `git --version`, `rev-parse --show-toplevel`, `rev-parse HEAD`,
  `status --porcelain`, `status --porcelain -- docs` and `hash-object README.md`. Run
  against this monorepo and against a 200-file fixture.
- **Snapshot cost.** A replay of `UndoJournal.capture()`'s exact sequence with the same
  `execFile` options `Git.run` uses, the same `UNDO_PATHS` pathspec, and the same
  `GIT_INDEX_FILE` handling, timing each spawn separately. 10 to 20 iterations.
- **The cheap fixes.** The same replay with the two repo-invariant probes hoisted out of
  the loop, and with an optional `copyFile` of `.git/index` into the scratch path before
  `add -A`. The tree hash is printed on every run and compared between modes.

Fixtures. `tiny` is 200 committed files shaped like a project. `big` is 1000
`wiki/*.md` plus 1000 `scenes/*.fountain`, all committed. Both are created with
`core.autocrlf false`, since this machine's global setting is `true` and would otherwise
add filter cost to every hash.

Environment. Windows 11 Pro 26200, git 2.53.0.windows.1, Node v24.14.0, on the repository's
own disk. Absolute numbers are machine-specific; the ratios are the finding. The
2026-08-25 measurements are not directly comparable to the deferral plan's, which used git
2.51 and a different fixture, so the two are reported separately rather than merged.

Repository facts — the operation inventory, the spawn counts, the call sites, the Electron
version, the packaging and jest configuration, the absence of hooks, signing, network git
and `git worktree` usage — were read from the source on 2026-08-25 and are cited by file
above.

## Unverified items

- **N-API stability across Electron is inferred, not published.** It follows from N-API's
  ABI stability and Electron embedding Node, and napi-rs's CI exercises it, but neither
  Node's nor Electron's documentation states the exemption. It should be proved by loading
  the module in a packaged build before it is relied on.
- **es-git in Electron is unattested.** Its documentation never mentions Electron and its
  tracker holds no Electron issues.
- **libgit2 version for es-git is inferred** from the `git2 = "=0.20.4"` pin and the
  release date, giving ~1.9.3. It is not stated in the project's own documentation.
- **The seeded-index tree equality was proved only on fixtures with no `:(exclude)`
  terms.** Under the real `UNDO_PATHS` it is expected to require removing out-of-pathspec
  entries first, and that has not been implemented or tested.
- **fsmonitor's effect on a library-backed status was not measured**, only reasoned about.
- **The ~430 ms residual is arithmetic** over per-spawn measurements, not an end-to-end
  measurement of a patched app.

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
