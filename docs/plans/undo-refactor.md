# Undo refactor: drop git as the undo mechanism

Status: **planned**

## What this builds

Today's undo (`packages/commands/src/undo.ts`) works by taking shadow snapshots of the
document tree as detached git commits under `refs/vn/undo/<seq>/{pre,post}`. This plan
replaces that mechanism with a small in-memory content-addressed store, modeled on git's
blob/tree idea but with no dependency on an actual `.git` repository, no on-disk
persistence, and no use of the `git` binary or `@vn/git`.

Alongside that, this plan also routes the desktop app's own file I/O (in the main process)
through a cache backed by the same content-addressed store, so undo snapshot capture stops
requiring a fresh walk-and-hash of the document tree on every act.

This is scoped to `apps/desktop` and `packages/commands`. It does not touch `@vn/git`,
`packages/authoring`, `apps/authoring` (vnauthor), the CLI, or the generative pipeline —
none of those depend on `@vn/commands`, and vnauthor's own git usage (one commit per
approved plan) is a separate, independent design that this plan leaves alone.

## Why

`@vn/commands`'s `UndoJournal` and `Committer` are already independent, optional
dependencies of `CommandStack` (`packages/commands/src/stack.ts`) — a stack with neither
wired behaves exactly as it did before either existed. Undo is being pulled out and
replaced; commit-on-save is not being touched. The two were already designed to compose
without ordering constraints, which is what makes this separable.

## What changes

### 1. The undo store

Replace `UndoJournal`'s git-shadow-commit mechanism with a content-addressed blob/tree
store, in memory only (no persistence across an app restart — confirmed acceptable; a
future, separate feature may reintroduce periodic git commits, but not for undo).

- **Blob**: `sha256(bytes) → bytes`. Reuse `sha256` from `@vn/util` — it is already the
  hash used by `@vn/store`'s asset store and `docfile`'s save token, so this does not
  introduce a second hash primitive.
- **Tree**: a sorted `{name, hash, kind}[]` per directory, itself hashed, so two
  identical directory states produce the same tree hash. This is what makes `undo.changed`
  a single hash comparison rather than a walk.
- **Snapshot**: one tree hash per root (project root, and any other root the document
  class currently spans). Multi-repo, as a concept, goes away — a root only needs to be a
  directory, not a git repository, which removes today's repo-boundary detection
  entirely for undo's purposes.
- **Capture**: walk the document-class pathspec (the same paths `UndoJournal` scopes to
  today — excluding `vngen/build`, `vngen/state`), hash bottom-up, short-circuit unchanged
  files by `(path, mtime, size)` before re-hashing.
- **Drift check**: hash the current tree and compare to the recorded tree hash — same
  complexity as today's git-based check, same refuse-rather-than-guess behavior when the
  worktree has moved since the snapshot was taken.
- **Restore**: diff the target tree against the current tree by hash; write only the
  files that differ; delete paths present on disk but absent from the target tree. Leave
  everything else untouched, which avoids the mtime churn a full-tree rewrite would cause.
- **GC (`keep`)**: mark-and-sweep over the blobs/trees referenced by the last `keep`
  snapshots; drop the rest. Since this store is in-memory and process-lifetime only, this
  is bookkeeping to bound memory, not disk reclamation.

`UndoPoint.pre`/`.post` change from git commit shas to tree hashes from this store. The
external shape (`CommandRecord.undo: {pre, post, changed}`) stays the same; only what the
strings identify changes.

### 2. The file I/O cache

A cache living in `apps/desktop/src/main`, backed by the same content-addressed store,
covering two distinct cases:

- **Generated assets** (`assets/objects/<hash>.<ext>`, `vngen/build/assets/<hash>.<ext>`).
  These are already content-addressed at the filename level (`AssetStore.write`,
  `packages/store/src/assetstore.ts`), so a given hash's bytes never change. Cache these
  by hash in an LRU bounded by total bytes — no invalidation logic is needed, since the
  hash is the identity. Wire this into the `vnasset://` protocol handler
  (`apps/desktop/src/main/index.ts:858`), which today re-reads from disk on every request.

- **Documents** (the same document-class paths the undo store snapshots — character
  docs, screenplay, locations, wiki, layouts, `project.yaml`). These are mutable, so the
  cache needs a freshness check: before serving a cached entry, compare `(mtime, size)`
  against what was recorded; on a mismatch, re-read and re-hash from disk. Writes are
  write-through — bytes still land on disk via `writeFileAtomic` as they do today, with
  the cache entry updated in the same call, so nothing is ever durable only in memory.

  Because this cache is kept live by ordinary reads and writes, undo capture becomes
  "read the cache's current tree hash for the document-class paths" instead of a fresh
  disk walk, for anything the cache already has current entries for.

**Scope boundary**: this cache lives in `apps/desktop/src/main`, wrapping calls made by
desktop command handlers into `@vn/store`. It does **not** change `@vn/store`'s API or
behavior, so the CLI, the generative pipeline, and `vnauthor` are unaffected.

**Known gap, accepted for now**: the desktop app's own embedded conversational agent
(`apps/desktop/src/main/session.ts`, built on `packages/authoring`'s `Workspace`) reads
and writes through `@vn/util`'s `readText`/`writeFileAtomic` and `@vn/store`'s loaders
directly — the same code path `vnauthor` uses — not through the desktop's command
handlers. Its writes therefore do not proactively update the cache. This does not cause
incorrect behavior: the document cache's freshness check means the next read of a
path the agent touched detects the stale `(mtime, size)` and re-reads it. It does mean
the agent's edits do not get the performance benefit of a warm cache. Wiring the agent
into the cache would mean threading an injectable cache backend into `packages/authoring`'s
`Workspace` (a package shared with `vnauthor`), defaulting to plain disk I/O so `vnauthor`
and the CLI are unaffected. **Deferred** — not part of this plan.

### 3. Kept as-is (unrelated to undo)

These all currently use git, and none of them are undo's mechanism — they stay exactly as
they are:

- Workspace bootstrap auto-init and auto-commit (`apps/desktop/src/main/workspace.ts`:
  `ensureRepo`, `initRepoAt`, `seedWorkspace`, `commitScaffolding`, `ownsRepo`).
- The open-time "Changes made outside the app" checkpoint
  (`apps/desktop/src/main/index.ts:387`, `committer().checkpoint(...)`).
- `doctor.ts`'s `gitHealth()` check and the `askAboutGit()` onboarding prompt.
- `.gitattributes`/`.gitignore` scaffolding (`ensureGitAttributes`, `ensureIgnored`,
  `core.autocrlf false`).
- The GitHub Pages publish command (`apps/desktop/src/main/commands/project.ts`), which
  is inherently git/GitHub-based.
- `CommandRecord.commits` / the `Committer`'s per-act commit-on-save — unchanged, since it
  was already independent of `UndoJournal`.

### 4. Deleted

Merge-conflict-aware reads: `conflictedGraphs`/`conflictedPaths` and the `git?: Git`
parameter on `readGraph`/`listGraphs` (`apps/desktop/src/main/graphs.ts`) and
`readLayout`/`listLayouts` (`apps/desktop/src/main/layouts.ts`), along with their call
sites in `apps/desktop/src/main/commands/gengraph.ts`, `apps/desktop/src/main/commands/view.ts`,
and `apps/desktop/src/main/session.ts` (the `readGraph(..., openGit(this.dir))` calls).
This behavior — refusing to open a file that's mid-merge, per `git status`, with a message
telling the author to `git checkout --ours/--theirs` — only makes sense for an author
running their own external git workflow on the project. It is deferred to a future,
better-designed approach to merge conflicts, not replaced.

Remove the corresponding assertions in `apps/desktop/src/main/commands/tests/gengraph.test.ts`
and `apps/desktop/src/main/tests/layouts.test.ts:237-238`.

### 5. Thread provenance

`apps/desktop/src/main/session.ts`'s `beginThread` currently stamps a new conversation
thread with `openGit(this.dir).head()` (the git HEAD sha at thread creation), stored as an
optional `commit` field. Drop this call and the field entirely. Every thread already
carries `startedAt: now.toISOString()` unconditionally (`apps/desktop/src/main/threads.ts:280`),
which already serves as the thread's creation-time provenance; this field is not
surfaced anywhere in the renderer, so nothing downstream needs to change.

This is unrelated to `commitThread`'s `archived: {commit, at}[]` list
(`apps/desktop/src/main/threads.ts:376-377`), which records real commit shas from actual
saves via the (retained) `Committer` — that stays as it is, since it rides on the kept
commit-on-save machinery, not on undo.

## Not in scope

- Persisting undo history across an app restart.
- Any change to `@vn/git`, `@vn/store`, `packages/authoring`, `apps/authoring`, the CLI,
  or the generative pipeline.
- A replacement for git-based merge-conflict detection (item 4, above) — explicitly
  deferred.
- Wiring the desktop's embedded agent into the file I/O cache — explicitly deferred.
- Any change to commit-on-save, workspace bootstrap, the doctor/onboarding flow, or
  GitHub Pages publishing.

## Review

Not pressure-tested. This plan reflects a single design conversation and has not been
attacked by a fresh-context reviewer.
