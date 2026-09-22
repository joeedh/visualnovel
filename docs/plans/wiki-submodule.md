# The story bible as a git submodule

<!-- toc -->

- [Scope](#scope)
- [What already works](#what-already-works)
- [What breaks](#what-breaks)
- [Decisions](#decisions)
- [Ordering against the History pane](#ordering-against-the-history-pane)
- [Stages](#stages)
    - [Stage 1 — Nested repos commit first; `.git` and `.gitmodules` leave the undo scope](#stage-1--nested-repos-commit-first-git-and-gitmodules-leave-the-undo-scope)
    - [Stage 2 — Open-time submodule checks](#stage-2--open-time-submodule-checks)
    - [Stage 3 — `vnauthor`'s commit spans the project's repos](#stage-3--vnauthors-commit-spans-the-projects-repos)
    - [Stage 4 — Docs](#stage-4--docs)
- [What the History pane needs to know](#what-the-history-pane-needs-to-know)
- [Out of scope](#out-of-scope)
- [What it costs to undo](#what-it-costs-to-undo)
- [Pressure test](#pressure-test)

<!-- tocstop -->

Status: planned. Written 2026-09-21; pressure-tested the same day, and the findings and
what became of each are in [Pressure test](#pressure-test).

An author wants `wiki/` to be a git submodule of the project: one bible shared by several
projects, or a bible with a history of its own. The repo map
([`../reference/repos-and-commits.md`](../reference/repos-and-commits.md)) was built so
that `wiki/` could be its own repository, and a submodule is one. This plan covers the
places where a submodule differs from a plain nested repository, and two gaps that apply
to both.

## Scope

- In: commit ordering across the project's repos, the open-time checks a submodule needs
  (detached HEAD, not checked out), `vnauthor`'s `git_commit` spanning repos, the undo
  walk's treatment of `.git` files and `.gitmodules`, and the docs.
- Out: adding or removing a submodule from inside the app (`git submodule add` stays a
  terminal act); a base-assets submodule beyond what the same code covers for free; sync
  of the parent's gitlink with a remote, which is the History pane's sync work and is
  handed to it in
  [What the History pane needs to know](#what-the-history-pane-needs-to-know).

## What already works

Verified against the code on 2026-09-21 (twice: once by the author, once by the pressure
test in scratch repositories on git 2.55). Nothing here is planned work.

- `RepoResolver.rootOf` (`packages/git/src/repos.ts:50`) asks
  `git rev-parse --show-toplevel`, which reads a submodule's `.git` _file_ the same as a
  `.git` directory. Nothing declares the map, so nothing needs configuring.
- `Workspace.repos()` (`packages/authoring/src/workspace.ts:175`) reports
  `{ role: 'wiki', root, owned: true }` when `wiki/` resolves to its own root. A submodule
  does. An empty `wiki/` resolves to the project root and is deduped away.
- `openRepos` (`apps/desktop/src/main/runtime/workspacelifecycle.ts:199`) opens one `Git`
  per owned repo, and `Committer.run` (`packages/commands/src/commit.ts:151`) commits `-A`
  in each, in the order given. A `doc.write` under `wiki/` lands as a commit in the
  submodule, and the open-time sweep runs there too.
- `git add -A` in the parent creates the gitlink (mode `160000`) the first time the nested
  repo has a commit, bumps it whenever the nested HEAD moves, and never stages the nested
  contents. So the parent's history records which bible save each project save saw. That
  is the right relationship and it costs nothing.
- `openBible` takes a directory and accepts a missing or empty one as an empty bible.
- `ensureRepo`, `ensureGitAttributes`, `ensureLayouts` and `commitScaffolding` act on the
  project root only and never descend; `commitScaffolding` checks `ownsRepo` itself
  (`apps/desktop/src/main/workspace/workspace.ts:88`, `:159`).
- `packages/git/src/tests/repos.test.ts:26` and `:66` cover a nested `wiki/` repository
  and `RepoResolver.group`, though not a submodule.
- `git submodule add` from a local path needs `-c protocol.file.allow=always`; a recursive
  clone and `submodule update --init` leave the submodule detached, and `submodule add`
  leaves it on a branch.

## What breaks

1. **The parent's gitlink lags one act behind.** `repos()` yields `[project, wiki, base]`
   and `Committer.run` commits in that order, so the parent's `add -A` runs before the
   wiki's new commit exists and stages the previous sha. The last act before quit is never
   recorded in the parent at all; the next session's sweep files it under "Changes made
   outside the app".
2. **A nested repo with files but no commit fails every act.** `git add -A` in the parent
   refuses with
   `error: 'wiki/' does not have a commit checked out … fatal: adding files failed`;
   `ok()` throws, the project is never committed, and the wiki never gets the first commit
   that would end the state. Deepest-first (Stage 1) ends it: the wiki commits first, then
   the parent succeeds.
3. **A submodule checks out detached.** After a recursive clone or
   `submodule update --init`, commit-on-save works, and the parent's gitlink keeps every
   commit reachable once (1) is fixed, but nothing is on a branch: the wiki cannot be
   pushed, and `Git.branch()` answers `HEAD`. Local `main` exists (a recursive clone
   creates it) and falls further behind with every save.
4. **A submodule that was never checked out loses wiki edits silently.** A clone without
   `--recurse-submodules` leaves `wiki/` as an empty directory with no `.git`. `openBible`
   accepts that; `repos()` dedupes `wiki/` into the project; the parent's index still
   holds the gitlink, so `git add -A` exits 0 and ignores every file the author writes
   under it (`git add wiki/x.md` is refused outright:
   `Pathspec 'wiki/x.md' is in submodule 'wiki'`). The notes are on disk and in no
   history, and nothing says so. `packages/store/src/assetstore.ts:486-499` already
   handles this shape for a base-assets submodule (`unavailable`).
5. **`vnauthor`'s one-commit-per-plan does not span repos, and fails once a gitlink
   exists.** `git_commit` is path-scoped: `loop.ts:1039-1043` unions `editedPaths` with
   the tool's `paths`, and `Git.commit` runs `git add <paths>` in `ctx.git.root`, the
   project (`apps/authoring/src/agent.ts:131`). With no gitlink yet, `git add wiki/x.md`
   exits 0 and stages the gitlink rather than the file, so the wiki edit is silently left
   out and the reply says "Committed". With a gitlink, the same `add` fatals and the whole
   plan's commit fails, project edits included. True of any nested wiki repo, submodule or
   not.
6. **The undo walk hashes a submodule's `.git` file and `.gitmodules`.** `ContentStore`'s
   walk skips a directory named `.git` (`packages/commands/src/content.ts:263`) and takes
   a file of that name as a blob; `.gitmodules` is an ordinary root-level file to it. A
   snapshot taken before a mid-session `submodule add` would, on restore, delete both, and
   leave the gitlink with no mapping, which is the state (Stage 2's `gitlinks()` has to
   tolerate anyway) that `git submodule` commands refuse to work in.

## Decisions

| Decision                                                                                             | Where it binds                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The wiki leads and the parent records                                                                | The wiki's worktree follows its own branch; the parent's gitlink follows the wiki's HEAD through ordinary `add -A`. The app never runs `git submodule update` and never moves the wiki to match the parent                                                                       |
| Nested repos commit before the repo that contains them                                               | `byDepth(roots)` in `packages/git/src/repos.ts`, deepest first; `Committer.run` and `git_commit` both order by it                                                                                                                                                                |
| A detached submodule is put on a branch at open only when that loses nothing, and the author is told | `checkout -B <branch>` when `<branch>` is an ancestor of HEAD (or absent); a notification and no checkout when they diverged. Never a plain `checkout`. Branch: `submodule.<name>.branch` from `.gitmodules`, else the remote branch containing HEAD, else `main`, else `master` |
| A submodule that is not checked out is reported, not initialized                                     | The app does not run `git submodule update --init`: it is a network act in a checkout the author may not own. A durable notification names the command                                                                                                                           |
| Submodules are found from the index, not from `git submodule`                                        | `git ls-files -s` (mode `160000`) is the list; `.gitmodules` is read only for the branch name and is optional. `git submodule status` fatals on a gitlink `.gitmodules` does not map, which is what a plain `git init` in `wiki/` plus the parent's `add -A` produces            |
| Ownership is still discovered, never declared                                                        | `.gitmodules` is not a second repo map                                                                                                                                                                                                                                           |
| `vnauthor`'s `git_commit` partitions its paths by owning repo and commits each, nested first         | `packages/authoring/src/tools/git.ts`; the parent's pathspec gains each nested repo's own path so its gitlink is bumped                                                                                                                                                          |
| `.git` is skipped by name, whatever it is, and `.gitmodules` joins `UNDO_EXCLUDES`                   | `ContentStore` walk; `apps/desktop/src/shared/affects.ts:26`                                                                                                                                                                                                                     |

## Ordering against the History pane

`docs/plans/archive/history-pane.md` (branch `git-editor`, shipped 2026-09-21) has stages
1–3 committed, which add `packages/git/src/parse.ts`, `Git.inProgress()`,
`Git.branchStatus()` and `Git.catBlob()`. Stage 2 here reads `inProgress()` (a rebase also
detaches HEAD, and that case is the pane's, not this plan's) and adds its parser to
`parse.ts`. So:

- Stage 1 is independent and can land now.
- Stages 2 and 3 land after history-pane stages 1–3 are on `master`. If that order flips,
  Stage 2 checks `rev-parse --git-path rebase-merge` and `rebase-apply` itself and
  `parse.ts` is created here; the History pane then merges rather than creates it.

## Stages

Each stage is one commit, green under `pnpm check`, `pnpm test`, `pnpm lint` and
`pnpm build`, and lands on `master` by fast-forward.

### Stage 1 — Nested repos commit first; `.git` and `.gitmodules` leave the undo scope

- `packages/git/src/repos.ts` exports `byDepth<T>(items, root: (t) => string)`: a stable
  sort by path depth descending. It lives here because the committer (`@vn/commands`) and
  `git_commit` (`@vn/authoring`) both order by it and both already import `@vn/git`.
- `Committer.run` (`packages/commands/src/commit.ts:151`) sorts the repos it is given with
  `byDepth` before the loop. The sort is in the committer rather than in
  `Workspace.repos()` because the committer is the one place the order matters for
  commit-on-save, and `commit.test.ts` can prove it with two temp repos while nothing
  tests `workspacelifecycle.ts` (it imports `electron`).
- Tests in `packages/commands/src/tests/commit.test.ts`:
    - A project repo with a nested `wiki/` repo, a file written in each, one committer
      run: the parent's `git ls-tree HEAD wiki` is mode `160000` at the wiki's new HEAD.
    - The nested repo has files and no commit (the state of `git init` in `wiki/` a moment
      ago): the run succeeds, the wiki gets its first commit, and the parent's gitlink
      points at it. Before this stage the parent's `add -A` threw.
    - A nested repo that is empty and unborn is not tested and not tolerated: the parent's
      `add -A` fails with git's own sentence, as today. The first file written under
      `wiki/` ends the state at the next act, since the wiki now commits first.
- `packages/commands/src/content.ts`: move the `SKIP_DIRS` check above the `isDirectory()`
  branch so a `.git` file is skipped too. Test: a directory holding a `.git` file hashes
  the same as one without it.
- `apps/desktop/src/shared/affects.ts`: `.gitmodules` joins `UNDO_EXCLUDES`. It is
  repository structure rather than a document, like `.git`. The affects test that
  enumerates the excludes learns it.

### Stage 2 — Open-time submodule checks

- `packages/git/src/git.ts` gains:
    - `gitlinks()`: `ls-files -s`, filtered to mode `160000`, as `{ path, sha }[]`. One
      spawn; a repo with no gitlinks answers `[]`.
    - `submoduleBranch(path)`:
      `config -f .gitmodules --get-regexp '^submodule\..*\.path$'` to map the path to its
      name (the keys are by name, not path), then `submodule.<name>.branch`; `null` when
      `.gitmodules` is absent or has no entry.
    - `detached()`: true when `rev-parse --abbrev-ref HEAD` answers `HEAD` and
      `inProgress()` reports nothing.
    - `isAncestor(a, b)`: `merge-base --is-ancestor`, by exit code.
    - `remoteBranchesContaining(sha)`:
      `branch -r --contains <sha> --format=%(refname:short)`, skipping the
      `origin/HEAD -> …` line.
    - `checkoutBranch(name)`: `checkout -B <name>`. The caller has already proven the
      branch is an ancestor of HEAD or absent, and the method says so.
    - The parsers are pure functions in `parse.ts` with tests; the methods are tested in
      `tests/reads.test.ts` against a temp repository with a real `git submodule add` from
      a sibling path (`-c protocol.file.allow=always`), plus a plain nested `git init`
      with no `.gitmodules`, which must answer the same shape.
- `adoptSubmodules(root)` in `apps/desktop/src/main/workspace/workspace.ts` beside
  `ensureRepo`, tested in `apps/desktop/src/main/tests/workspace.test.ts`. It spawns git
  and may check out a branch, so it is not pure; it returns the notices to post rather
  than posting them, so the test needs no notification store. For each gitlink of the
  project repo:
    - No `<path>/.git` (file or directory): a notice at level `warn`: "`<path>/` is a
      submodule that is not checked out, so nothing written there is saved. Run
      `git submodule update --init` in the project and reopen it."
    - Present and detached: choose the branch per the decisions table. If the branch is
      absent locally or is an ancestor of HEAD, `checkoutBranch` and a notice at level
      `info`: "`<path>/` was on no branch; its saves now go to `<branch>`.
      `git checkout --detach` in `<path>/` undoes this." If the branch and HEAD have
      diverged, no checkout and a notice at level `warn` naming both shas: "`<path>/` is
      on no branch, and `<branch>` has moved on without it; pick one in a terminal." The
      app cannot tell a deliberate detach from a clone's default, so the notice is the
      tell and the undo is one command.
    - Present, on a branch, or mid-rebase: nothing.
- `openRepos` calls `adoptSubmodules(root)` after `ensureRepo` and before `repos()`, only
  when `ownsRepo(root)`, and posts each notice through `notifications().post` (category
  `workspace`, source `main`), deduped by message the way `noticeMissingGit` does. A
  project inside a larger repo is skipped for the reason `commitScaffolding` skips it.
- `Workspace.repos()` also reports a gitlink with no `.git` as
  `{ role: 'wiki', root: <path>, owned: false, missing: true }`, so `WorkspaceIndex.repos`
  and the History pane's strip can say why there is no wiki history. `RepoRef` gains the
  optional `missing` flag, and the one reader that branches on `owned: false` — the
  `console.warn` at `workspacelifecycle.ts:202` — learns to say "is a submodule that is
  not checked out" for a `missing` ref rather than "sits inside <root>".

### Stage 3 — `vnauthor`'s commit spans the project's repos

- `packages/authoring/src/tools/git.ts`, `git_commit`, given the workspace-relative paths
  the loop assembled:
    1. Partition them with `RepoResolver.group` (already tested, `repos.test.ts:66`) over
       the absolute paths. A group under `null` (no repo) is dropped with a line in the
       reply.
    2. Order the groups with `byDepth`. For each nested root, add its own path, relative
       to the parent, to the parent's group, so the parent's `add` bumps the gitlink.
    3. Commit each group in its own repo with paths made relative to that root, same
       message, nested first. `Git.commit` is unchanged.
    4. Reply "Committed abc12345 (project), def67890 (wiki): <message>", or "Nothing to
       commit." when no repo moved. A repo whose commit throws stops the loop and the
       reply names it and the repos that did commit.
- `packages/authoring/src/loop.ts:1050`: `editedPaths` is cleared only of the paths whose
  repo committed. `result.data` becomes the list of `{ root, sha, paths }`, and the loop
  removes those paths; a partial failure leaves the rest for the retry.
- `ctx.git` stays bound to the project for the reads. The History pane's Stage 6 rewrites
  `git_log`, `git_show`, `git_diff` and `git_status` and takes `repo` there; this stage
  does not touch them.
- Test in `packages/authoring/src/tests/`: a project with a nested wiki repo, an edit in
  each, one `git_commit`: two shas, the parent's gitlink at the wiki's new HEAD, and
  `editedPaths` empty. A second case with the wiki edit only: one sha in the wiki, and the
  parent commits the gitlink bump alone.

### Stage 4 — Docs

- `docs/reference/repos-and-commits.md`: a "Submodules" subsection under Multi-repo
  stating the decisions table above, the commit order, and what a missing submodule looks
  like from the app. The Bootstrap section's paragraph about `adoptGitAttributes`
  (`:252-257`) names a function the code does not have — `writeScaffolding` runs before
  `ensureRepo` and `commitScaffolding` checks `ownsRepo` itself — so it is rewritten to
  the code, and `adoptSubmodules` is named beside them. `RepoRef.role` at `:57` gains
  `'base'`.
- `docs/reference/story-bible.md:152`: the last bullet under "What it is not" still says
  the bible is "Not yet versioned separately" and points at item 4, which shipped. Replace
  it with one sentence pointing at the subsection above.
- `docs/reference/vnauthor.md:196`: `git_commit`'s new reply shape and the per-repo
  partition.
- `docs/plans/index.md` row.
- Finishing checklist per
  [`../reference/conventions.md`](../reference/conventions.md#finishing-a-plan).

## What the History pane needs to know

`docs/plans/archive/history-pane.md` was built in parallel on branch `git-editor`, in its
own worktree, and is not on `master` yet, so it is named here rather than linked. These
are the places where a submodule crosses its design; each is also recorded in that plan so
its implementing session sees them. None changes a command id or a refname.

- **Detached HEAD is in its non-goals, and a submodule is detached after a clone.** Stage
  2 here puts the wiki on a branch at open, so the pane never sees a detached wiki repo in
  the ordinary case. Until this plan lands, a wiki submodule shows the pane's
  detached-HEAD refusal; that refusal's sentence should say what to do ("check out a
  branch in `wiki/`") rather than only what is wrong.
- **A gitlink is a change of its own kind.** `diff-tree --raw` prints a submodule bump as
  `:160000 160000 <commit> <commit> M wiki`; `parseChanges` discards the modes, and
  `git.blob`/`catBlob` on that sha fails. `diffPath` for it is the two-line
  `-Subproject commit a…`/`+Subproject commit b…`. The change view needs a sixth `Diff`
  kind (or a `Change.status` of its own) that says "the story bible moved from save X to
  save Y" and opens the wiki repo's history at Y.
- **`kindOf('wiki')` and `kindOf('.gitmodules')`** need answers; today `wiki/**` is a wiki
  document and a bare `wiki` path has no kind.
- **The parent's status shows the wiki as modified whenever it moved or is dirty.**
  `status --porcelain=v2` prints a submodule as an ordinary entry with `S<C><M><U>` in the
  sub field, which `parseStatusV2` drops. After Stage 1 here the parent is clean between
  acts, but during a deferral, an autosave countdown, or any dirty wiki worktree,
  `statusCause` on the project would say "changed outside the app" about `wiki`. Keep the
  sub field and either skip submodule entries in the project's status or attribute them to
  the wiki role.
- **"Show history" on a wiki node must ask the wiki repo.** `git.history(path=…)` against
  the project returns nothing for a path under a submodule. Resolve the node's path to a
  role through the owned-repo roots (longest root that prefixes the path) before choosing
  `repo=`; the same for `git.restoreFile` and `git.diff` on a path.
- **`git.goBack` on the project does not move the wiki.** `read-tree -u --reset` changes
  the gitlink in the index and leaves the submodule's worktree alone. After Stage 1 here
  the next act's `add -A` re-stages the wiki's real HEAD, so the go-back commit's gitlink
  is overwritten one act later. Say so in the confirm text for a project with a wiki repo:
  "The story bible keeps its own history; go back there separately."
- **A checkpoint on the project pins a wiki sha through the gitlink** but does not tag the
  wiki. Either tag both repos when the project has one (simplest; two tags, one slug), or
  say in the checkpoint's tooltip that it covers the project only.
- **Sync order.** Pushing the parent before the wiki publishes a gitlink to a commit the
  remote does not have. Push nested repos first (`byDepth` from `@vn/git`, Stage 1 here),
  and refuse to push the parent while the wiki has unsent saves. Pulling the parent brings
  a gitlink the wiki's worktree may not match; the wiki's own pull, along its branch, is
  what catches it up, and the parent's gitlink follows at the next act. `git.pull` on the
  project therefore never runs `submodule update`.
- **A collaborator's clone needs `--recurse-submodules`.** The collaborating guide
  (Stage 7) should say so, and name Stage 2's notification as what a clone without it
  looks like.
- **The `missing` flag on `RepoRef`** (Stage 2 here) is what the strip reads to show a
  wiki entry with no history and the reason.

## Out of scope

- Adding a submodule from the app. `git submodule add` needs a URL and a network, and the
  author who wants a shared bible has a terminal.
- A `git submodule update --init` the app runs. It is a network act, and running it in a
  checkout the app does not own (a project inside a larger repo) would fetch into somebody
  else's `.git`.
- `push.recurseSubmodules=on-demand` as a config the app sets. It would make the parent's
  push carry the wiki's, but it fails on a detached submodule and interacts with the
  History pane's push ordering, which is the better place to decide it.
- An empty, unborn nested repo (finding 6). The next file written there ends the state.

## What it costs to undo

- Stage 1: the order change alters which repo's commit lands first, which was observable
  only as the lagging gitlink and the unborn-repo failure; both are things nobody wants
  back. `.gitmodules` in `UNDO_EXCLUDES` is one line.
- Stage 2: additive methods. The branch checkout is a real change to an author's checkout
  (a submodule that was detached is now on a branch); it runs only when it discards
  nothing, the notification says how to reverse it, and the reverse is one command.
  `RepoRef.missing` is an optional field.
- Stage 3: `git_commit`'s reply text changes shape; a skill that parses it (none is known
  to) would need the new form. `result.data`'s shape changes, and `loop.ts` is its only
  reader.
- Stage 4: docs.

## Pressure test

A fresh-context agent reviewed the first draft against `master`, the `git-editor` worktree
and scratch repositories (git 2.55) on 2026-09-21. Nine findings; what became of each:

1. **Stage 3 was designed against a commit path that does not exist.** `git_commit` is
   path-scoped through `editedPaths` (`loop.ts:1039-1043`), and a workspace-relative
   `git add wiki/x.md` in the project either stages the gitlink silently (no gitlink yet)
   or fatals (gitlink present). Fixed: Stage 3 partitions the paths with
   `RepoResolver.group`, re-roots each group, adds the nested repo's path to the parent's
   pathspec, and clears `editedPaths` per committed repo. Item 5 of "What breaks" is
   rewritten to the real shape.
2. **`git submodule status` fatals on a gitlink `.gitmodules` does not map**, which is
   what every existing nested-wiki project has. Fixed: gitlinks come from `ls-files -s`;
   `.gitmodules` is optional and read only for the branch name.
3. **A plain `checkout <branch>` on a detached submodule whose branch is behind orphans
   the saves.** Fixed: `checkout -B` only when the branch is an ancestor of HEAD or
   absent; a notice and no checkout on divergence; the info notice names the undo.
4. **Stage 2 depends on `inProgress()` and `parse.ts`, which exist only on `git-editor`.**
   Fixed: the [ordering section](#ordering-against-the-history-pane) states that Stages 2
   and 3 land after history-pane stages 1–3, with the fallback if the order flips.
5. **`adoptGitAttributes` does not exist.** The doc names it; the code has
   `writeScaffolding` and `commitScaffolding`, the latter checking `ownsRepo`. Fixed
   throughout, and Stage 4 rewrites the doc paragraph and adds `'base'` to `RepoRef.role`
   there.
6. **"The order was never observable" was false; a nested repo with files and no commit
   fails every act today.** Fixed: the case is in Stage 1's tests and in "What breaks";
   the empty-unborn case is recorded as out of scope with the reason.
7. **`RepoRef.missing` would make `openRepos` log "sits inside itself".** Fixed: the one
   `owned: false` reader learns the flag.
8. **`.gitmodules` in an undo snapshot.** Fixed: it joins `UNDO_EXCLUDES` in Stage 1.
9. **Small git facts** — `.gitmodules` keys are by name; `branch -r --contains` prints
   `origin/HEAD -> …`; `submodule add` leaves a branch checked out; `adoptSubmodules` is
   not pure; `byDepth` had two homes. All fixed in the text.
