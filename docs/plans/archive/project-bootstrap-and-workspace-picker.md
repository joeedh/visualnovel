# Project bootstrap and the workspace picker

Item 10 of [`refactorTaskList.md`](../refactorTaskList.md). The requirement, in full
([`designRequirementsEtc.md`](../../designRequirementsEtc.md)):

> The user starts with an empty project. The app requests the user to pick a directory for the
> project. The app initializes a git repository if necessary. It will automatically commit
> existing files.

Status: **shipped** (deviations in [As shipped](#as-shipped)); the as-shipped page is
[`desktop-app.md` § Which project is open](../../desktop-app.md#which-project-is-open).

<!-- toc -->

<!-- tocstop -->

## What is already shipped

`ensureRepo(root)` ([`repo-map-and-commit-on-save.md`](repo-map-and-commit-on-save.md)) is the
second half of that sentence: it initializes a repo when the directory is not already in a work
tree, fills a committer identity only when git cannot answer for itself, and commits `-A` once.
`seedWorkspace(template, target)` is how a first launch gets *something* to open — a scratch copy
of `templates/basic`, because the template is read-only.

What is missing is the first half: a user cannot choose a directory, and the app cannot open one
after launch. `workspaceRoot` is resolved once in `main/index.ts` and every consumer is a
module-level singleton built around it.

## The shape

Four pieces, smallest first.

### 1. `openWorkspace(root)` — the bootstrap, in `main/workspace.ts`

One function beside `seedWorkspace`, doing what "pick a directory" implies and nothing more:

```ts
export interface OpenResult {
  root: string;
  /** True when this call wrote `project.yaml` — the directory was not a project yet. */
  created: boolean;
}
export async function openWorkspace(root: string): Promise<OpenResult>;
```

- No `project.yaml` → write one: `title: <basename>\n`, and nothing else. `title` is the only
  required key in `projectConfig`; every other field has a default, so the shortest honest config
  is one line. It is emphatically **not** a copy of the sample — an empty project is empty.
- A `project.yaml` that will not parse → **throw**, naming the file. Switching into a project whose
  config is broken would fail later, further from the cause.
- Then `ensureRepo(root)`, unchanged.

`inspectWorkspace(root)` is its read-only twin — exists / is a directory / has a config / config
parses — so `check` can answer without writing anything. That split is what lets the refusal be
declared before the command runs.

### 2. Two commands, in `main/commands/workspace.ts`

| Command | Props | What it does |
| ------- | ----- | ------------ |
| `workspace.open` | `path` (required) | Validate, bootstrap, switch. The scriptable one. |
| `workspace.pick` | — | Native directory dialog, then the same path. Cancel is a no-op. |
| `workspace.recent` | — | Non-mutating: the current root and the remembered list. |

`workspace.open`'s `check` reports which of the two things is about to happen — *"Opens the project
at …"* or *"Creates a new project at …: writes project.yaml and initializes a git repo"* — and
refuses a path that is not a directory, a config that will not parse, the root that is already
open, and a switch while a pipeline or agent turn is in flight. `workspace.pick` delegates to the
same code, so the dialog is a five-line shell over a tested function; it refuses when there is no
window to parent the dialog to, which is also what keeps it out of a headless CDP script.

Both are `mutating`, neither is `undoable`. A workspace switch is not a document edit, and the
bootstrap writes into a *different* tree than the one the undo journal snapshots — a shadow ref in
the old repo could not restore it, and pretending otherwise is worse than not offering it.

### 3. The switch, in `main/index.ts`

Everything workspace-shaped in main is a module singleton: `workspaceRoot`, `session`, `stack`,
`ownedRepos`, `undoRevision`, and the `vnasset://` handler's `ProjectPaths`. Switching in place
means one function that drops all of them:

```ts
async function switchWorkspace(root: string): Promise<void>;
// workspaceRoot = root; session = null; stack = null;
// ownedRepos.length = 0; undoRevision = 0;
// await openRepos();            // ensureRepo + repo map + checkpoint, as at launch
// host.ui({ type: 'workspace', root, name });
```

The alternative — `app.relaunch()` with `--project` — cannot leave stale state, but it throws away
the window and every renderer-side thing an editor is expected to keep. In-place is ~20 lines and
the only thing it demands is that nothing cache the root: **`registerAssetProtocol` must resolve
`ProjectPaths` per request rather than at registration**, which it does not today and which would
otherwise serve the previous project's bytes. That is a real bug the switch surfaces, not a cost of
it.

Dropping the session drops the agent conversation, the loaded model, and the command history's
undo stack. All three are about the project that was open; carrying them across would be the
mistake.

### 4. Recents and startup precedence

`SessionStore` is already "global per install, not per workspace" — exactly the scope a recents
list wants. One key:

- `workspace.recent`: `string[]`, most-recent-first, deduped, capped at 10. Written on every
  successful open, including the seeded sample.

Startup precedence becomes:

1. `--project` / `VN_PROJECT` — unchanged, and still wins over everything.
2. The most recent remembered root that still exists.
3. **The picker**, on a genuine first run (nothing remembered). Cancelling seeds and opens the
   sample, exactly as today.

Rung 3 is the requirement's own sentence, and it costs no new UI: `dialog.showOpenDialog` is
available once the app is ready and needs no parent window. `VN_NO_PICKER=1` skips straight to the
sample for any automation that wants the old behaviour; the dev loop does not set it, so a fresh
checkout is asked once and remembers the answer.

## Contracts

- **A picked directory is a project or becomes one.** Opening an empty directory writes the
  one-line config and a first commit; opening a directory that is already a project touches
  nothing but the recents list. There is no third outcome and no "partially opened" state.
- **The refusal is declared before the switch.** `workspace.open`'s `check` distinguishes *open*
  from *create* in the sentence it returns, so the shell can put "this will create a new project
  here" in front of a user before anything is written.
- **A switch is a full teardown.** Session, command stack, undo journal, repo map and revision
  counter are all rebuilt against the new root. Undo never crosses a workspace boundary.
- **Nothing caches the root.** Every consumer reaches through `workspace()`; the asset protocol
  handler is fixed to do the same.
- **Remembered state is per install, not per project.** Panel widths follow the app, which is right
  for geometry. Anything that is genuinely about *a* project (tree expansion keyed by node id, for
  instance) has to be keyed by root when it arrives — noted here so the first such key does not
  quietly land global.

## Steps

1. `openWorkspace` / `inspectWorkspace` in `main/workspace.ts`, with tests in the existing
   `main/tests/workspace.test.ts` over real temp directories: empty dir → config + repo + one
   commit; existing project → untouched; unparseable config → throws naming the file; idempotent on
   a second call.
2. `WorkspaceSession.busy()` — a flag set around `runPipeline` and `runAgent`, so the switch has a
   real answer to refuse with rather than a guess.
3. `switchWorkspace` in `main/index.ts`, the `vnasset://` per-request fix, and the
   `{ type: 'workspace' }` `UiEffect` in `shared/ipc.ts`.
4. The three commands, plus the recents helpers on top of `SessionStore`.
5. Startup precedence in `resolveWorkspace()`, including the first-run picker and `VN_NO_PICKER`.
6. Regenerate `apps/desktop/dist/commands.json` (`pnpm --filter @vn/desktop build:catalog`);
   `commands.test.ts` pins the catalog against the live registry.
7. Docs: a `## Workspaces` section in [`desktop-app.md`](../../desktop-app.md) (precedence, recents,
   what a switch tears down), the bootstrap paragraph in
   [`repos-and-commits.md`](../../repos-and-commits.md) updated to point at `openWorkspace`, the two
   new command rows in [`command-system.md`](../archive/command-system.md) and its count, and the trackers
   ([`refactorTaskList.md`](../refactorTaskList.md) row 10, [`index.md`](../index.md)).

## As shipped

Five things the code decided that the plan above did not.

1. **`inspectWorkspace` became its own exported function, and the check calls it twice over.**
   The plan named it in passing; it turned out to be the whole of `workspace.open`'s `check`
   *and* the first thing `openWorkspace` does, which is what keeps "what would happen" and "what
   happened" from being two implementations. `workspace.pick` re-runs the same verdict on the
   picked path before opening it: the dialog is not a permission, so a folder the command would
   refuse is refused after the pick too.
2. **`busy()` names the work rather than returning a boolean**, and it wraps the *whole* of
   `runPipeline` — loads included — rather than just the scheduler call. A flag set after two
   awaits leaves a gap a switch can land in, and a refusal that can say "a pipeline run is still
   running" is worth the extra string.
3. **The recents helpers take a `RecentStore`, not a `SessionStore`.** Two methods (`get`, `set`)
   is all they use, and naming only those makes them testable against a plain object — including
   the case that matters, a corrupt list, which reads as empty rather than blocking a launch.
4. **The renderer got a branch after all.** The plan treated the shell as out of scope, but
   `UiEffect` is a discriminated union the renderer exhausts, so `{ type: 'workspace' }` had to be
   handled somewhere. It clears the conversation, reloads the index and bumps the revision — three
   lines in `App.tsx`, using affordances that already existed.
5. **The first-run picker is opt-out, not opt-in.** `VN_NO_PICKER=1` skips it; nothing sets that
   by default, including the dev loop. What makes this safe is that *every* open is remembered,
   the seeded sample included — so cancelling the picker is answered once per install rather than
   at every launch, and the documented "sample workspace by default" behaviour survives from the
   second launch onward.

One bug fell out of the work rather than being planned: `registerAssetProtocol` captured
`ProjectPaths` at registration, which was invisible while the root never changed and would have
served the previous project's bytes at the new project's hashes the first time it did.

## Deliberately absent

- **A launcher window / "no workspace open" state.** The app always has a workspace, which is what
  keeps every existing channel's precondition true. A launcher is the
  [path.ux rewrite](pathux-desktop-rewrite.md)'s to design if it wants one.
- **Multi-window, one workspace each.** `win` is a singleton and the session hangs off the module,
  not the window. Nothing here forecloses it; it is simply not this item.
- **A "recent projects" menu.** The data ships (`workspace.recent`); the menu is shell.
- **Templates beyond the bundled sample.** "New project from template" is a different feature from
  "open a directory".
- **Watching for a workspace that disappears under the app.** A deleted root fails at the next
  read, as it does now.
