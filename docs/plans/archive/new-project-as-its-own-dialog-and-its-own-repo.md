# New Project as its own dialog, and its own repository

Status: **shipped**

## Context

The author, on the dialog that
[`new-project-dialog-with-folder-browse.md`](new-project-dialog-with-folder-browse.md) shipped:

> It should pop up an independent dialog not one inside the command palette. also looks like it
> didn't initialize a git repo for the project;

Two separate faults, and they are unrelated to each other.

### The form is inside the palette

That plan decided *"the palette form **is** the dialog. No second overlay."* The reasoning — one
place where a command states its intent, shows its verdict and takes its arguments — is still
right about not writing a bespoke New Project window. It was wrong about what the palette is.

The palette is a **finder**: a search box over eighty-three commands and a scrolling list of them,
with the chosen one's form appended underneath. An author who picked **New Project…** off a menu
has already found the command. What they get is a search box they must not type in, a list of
eighty-two commands they did not ask for, and their three fields at the bottom of it.

The fix is not a second form renderer. It is noticing that the palette does two jobs and only one
of them is wanted here.

### The project got no git repository

`workspace.create` says, in its description and in its own accept sentence, that it makes *"a
starter scene, a story bible page, project.yaml and a git repository"*. It made three of the four.

`createWorkspace` ends at `ensureRepo`, whose first question is `git.isRepo()` — which is
`git rev-parse --is-inside-work-tree`, and that walks **up**. The author created
`C:\dev\visualnovel\examples\testrepo2`, which is inside this repo, so `ensureRepo` returned a
handle on the *outer* repo and initialized nothing. Verified: `testrepo2` has `project.yaml`,
`scenes/`, `wiki/` and `vngen/`, and no `.git`.

That behaviour is deliberate and documented — `ensureRepo`'s comment says *"a directory that is
already in a work tree is left entirely alone"*, and `wouldCreate` appends a warning saying edits
there will not be committed. It is right for **opening**: a directory the author already has,
sitting in somebody's monorepo, must not silently grow a nested repository. It is wrong for
**creating**, where the author asked for a project and was promised a repository.

## Decisions this plan settles

- **The palette keeps finding; a dialog does filling-in.** `openPalette()` with no argument is
  unchanged — that is the finder, and `/` still opens it. Every call that names a command
  (`openPalette(id, overrides)`) becomes `openCommandDialog(id, overrides)`: a popup holding that
  one command's title, its description, its fields, its verdict and its buttons, and nothing else.
  There are six such callers today — New Project…, Run Pipeline…, Upload Files…, the gate approval
  in the graph editor, the run button in the tasks editor, and every context-menu entry that needs
  an argument — and all six wanted a dialog rather than a search.

- **One form renderer, two hosts.** The fields, the live verdict and the run button move out of
  `Palette` into a `CommandForm` that renders into any container. The palette's detail column
  becomes one host and the dialog the other. Two renderers that disagreed about how a `directory`
  prop draws, or when `confirm` needs a second click, would be a bug in both.

- **The dialog is a screen popup, not an OS window.** A real `BrowserWindow` would need its own
  HTML entry, its own bundle and its own IPC, and would sit outside the path.ux screen mesh that
  every other surface in this app lives in. A centred popup with a heading, a Cancel and a
  command-titled action button is independent in every way the author meant.

- **Cancel is a button, because a dialog has one.** The palette closes on Escape and on a click
  outside and offers no button, which is right for a finder. A dialog that asks for three fields
  and then writes to disk says how to leave without writing.

- **Creating a project always initializes a repository at its root** — including inside an
  existing work tree. `ensureRepo` keeps its meaning for `workspace.open` and for `openRepos`;
  `createWorkspace` gets `initRepoAt`, which asks whether *this directory* is a repository root
  rather than whether it is inside one. A nested repository is a thing this codebase already
  understands: `RepoResolver`'s own comment notes that git does not descend into one, and
  `Workspace.repos()` computes `owned: root === resolve(dir)` — so a project with its own `.git`
  is owned, and commit-on-save works, which is exactly what the warning said it would not.

- **The inside-a-repo sentence changes from a warning to a fact.** It currently says edits will not
  be committed for the author. After this it is *"{outer} already owns this path, so the new
  project will be a repository nested inside it."* — still worth saying, because git will call it
  an embedded repository the first time the outer one is asked to add it, but no longer a
  prediction of lost commits.

## Stage 1 — `CommandForm`

New `apps/desktop/renderer/pathux/commandform.ts`, holding what `Palette` currently does between
`field()` and `run()`:

```ts
export interface FormHost {
  /** What to do when the command ran and the surface should go away. */
  done(): void;
}

export class CommandForm {
  constructor(col: Container, entry: CatalogEntry, host: FormHost, overrides?: Record<string, PropValue>);
  render(): void;
  recheck(): Promise<void>;
}
```

It owns `values`, `check`, `confirming`, `verdictCol` and `firstField`, and moves `field()`,
`browse()`, `renderVerdict()` and `run()` across unchanged. `focusFirst()` is exposed so a host can
land the caret in the first blank.

`palette.ts` keeps the search box, the list, `select()` and `filterCommands`, and builds a
`CommandForm` into `detailCol` on every selection. Its `done()` closes the palette.

## Stage 2 — the dialog

`openCommandDialog(id, overrides?)` in a new `apps/desktop/renderer/pathux/dialog.ts`:

- `screen.popup` centred horizontally, a fixed width, and a top a little above centre.
- The command's **title** as the heading, its description under it, then the `CommandForm`.
- A row with **Cancel** and an action button labelled by the command's title.
- Escape and a click outside close it, the same as the palette; idempotent per open dialog.

Callers changed: `editors/header.ts` (three entries), `editors/graph.ts`, `editors/tasks.ts`,
`showmenu.ts`. `bridge.ts`, `keymap.ts` and `editors/convo.ts` call `openPalette()` with no
argument and are untouched.

## Stage 3 — the repository

`apps/desktop/src/main/workspace.ts`:

```ts
/** Initialize a repository *at* `root`, whatever encloses it. `ensureRepo`'s deliberate opposite. */
export async function initRepoAt(root: string, message: string): Promise<Git>;
```

The identity and `core.autocrlf` handling is shared with `ensureRepo` rather than copied.
`createWorkspace` calls it instead of `ensureRepo`.

`commands/workspace.ts`: `wouldCreate`'s `insideRepo` sentence is reworded as above.

Tests: `apps/desktop/src/main/tests/workspace.test.ts` gains a case that `createWorkspace` inside an
existing repository leaves a `.git` **at the new root**, and that the outer repository is not the
one that answers for it.

## Stage 4 — documentation

- [`new-project-dialog-with-folder-browse.md`](new-project-dialog-with-folder-browse.md): the
  "palette form _is_ the dialog" decision is superseded, with a pointer here.
- [`new-and-open-project.md`](new-and-open-project.md): the "warns, and proceeds" decision now
  proceeds with a repository of its own.
- [`../../reference/desktop-app.md`](../../reference/desktop-app.md) and [`command-system.md`](command-system.md): the
  palette-versus-dialog split, and where a menu entry needing an argument goes.
- [`../../reference/repos-and-commits.md`](../../reference/repos-and-commits.md): creating a project inside a repo nests one.
- `CLAUDE.md`: the two bullets that state the old behaviour.

## Acceptance

- `pnpm check`, `pnpm test`, `pnpm lint` green.
- **New Project…** opens a dialog with a heading, `path` + Browse…, `title`, the `newFolder`
  checkbox, a live verdict, Cancel and a **New project** button — and no command list or search box.
- Cancel closes it without writing; Escape does the same.
- The palette (`/`) is unchanged, and selecting a command in it still shows the same form.
- A project created inside this repository has its own `.git` with one `New project` commit, and
  the app reports it as an owned repo rather than warning about the enclosing one.

All met, and both halves were verified live over CDP against the built app rather than only in
tests. Driving the real **VN STUDIO → New Project…** produced exactly a heading, the description,
`path *` with a **Browse…** button, `title`, `newFolder` checked, the refusal *"✕ Choose a folder
for the new project."*, **Cancel** and **New project** — no search box and no `COMMANDS · 83` list.
The palette still finds: `view.palette(open=true)` listed 83 commands, and selecting
`workspace.reindex` showed its id, *"✓ Writes a new map."* and a `run` button with no Cancel.

For the repository half, a real git repo was made at a temp path and the dialog pointed at it with
`newFolder` ticked. The verdict read *"✓ Creates a new project at …\nested_story: a starter scene, a
story bible page, project.yaml and a git repo. …\vn-outer already owns this path, so the new project
will be a repository nested inside it."* Clicking **New project** left `nested_story/.git` whose
`git rev-parse --show-toplevel` is itself, with one `New project` commit; the outer repo still had
only its own commit, and the app opened on the new project with **no** `[vnstudio] … sits inside …
not committing there` line.

## Shipped deviations

- **`FormHost` became `FormOptions`, and it is three fields rather than one method.** The two hosts
  differ in more than what closing means: a dialog labels its button with the command's title and
  puts Cancel beside it, and the palette does neither. So the interface is `{ onRan, runLabel?,
  buttons? }` — `buttons` being a callback handed the button row, which is how Cancel gets in front
  of the action without `CommandForm` knowing what a dialog is.

- **`CommandForm` gained `detach()`, which the plan did not anticipate.** `recheck` is asynchronous
  and the palette rebuilds its form on every selection, so an answer could land on a column that had
  already been cleared — or on a popup that had been dismissed. `detach()` sets a `live` flag that
  `recheck` consults before it redraws, and both hosts call it: the palette when it selects a
  different command, and both when the popup ends.

- **`ensureRepo` delegates to `initRepoAt` rather than sharing a private helper.** The plan said the
  identity and `core.autocrlf` handling would be "shared rather than copied"; the smaller shape is
  that `ensureRepo` is now literally *"if it is already in a work tree, hand that back; otherwise
  `initRepoAt`"*, so there is one body and no third function.

- **The context-menu entries were already routed through `showmenu.ts`'s one `form` branch**, so
  Stage 2's "every context-menu entry that needs an argument" was a single line, not a sweep.
