# New Project, Open Project, Recent Projects

Status: **shipped**

## Context

`todos.md`:

> create main menu entries to open a project repo, as well as a command to create a new repo.
> creating a new repo should also open it.

Most of the machinery is already here, from
[`project-bootstrap-and-workspace-picker.md`](project-bootstrap-and-workspace-picker.md):

- `workspace.open` / `workspace.pick` open a directory, and **already create a project in it** if
  it is not one — `openWorkspace` writes the shortest honest `project.yaml` and `ensureRepo` does
  `git init` plus a commit of whatever was there. `wouldOpen` even says so ahead of time:
  *"Creates a new project at {root}: writes project.yaml and initializes a git repo."*
- `workspace.recent` returns the remembered list, capped at ten, stored globally so it is readable
  before any project is open.
- The app menu has one entry: `['Open Project…', () => openPalette('workspace.pick'), undefined]`.

So three things are missing, and only one of them is interesting.

1. **The menu is one entry where the todo asks for a set.** No New, no Recents.
2. **There is no command that creates a directory.** Every path in goes through a dialog on a
   folder that already exists; making one is the OS dialog's job, which works but cannot be
   scripted, tested or reached from the palette.
3. **A newly created project is empty, and an empty project is broken-looking.** With no `start:`
   and no scenes, `modelFromInputs` reports an error diagnostic, the branches pane is blank, the
   script pane has nothing to open, and the author's first impression of the app is a red count in
   the header. That is the one real design question here.

## Decisions this plan settles

- **`workspace.create` scaffolds; `workspace.open` still does not.** The comment on
  `openWorkspace` — *"Not a copy of the template — an empty project is empty"* — is right for the
  case it was written for: opening a directory the author already has, possibly full of their own
  files, must not litter it. But "create a new project here" is an explicit request for a project,
  and handing back one that cannot build a model is a worse answer than a two-file skeleton.
  The split keeps both promises.
- **The skeleton is three files, and it is not `templates/basic`.** `project.yaml` (title +
  `start: opening`), `scenes/opening.md` (front-matter `scene: opening` over a one-heading, two-
  line Fountain body), and `wiki/index.md` (an empty story-bible page with a heading). No cast, no
  locations, no art style. `templates/basic` is a *story* — seeding it would give every new
  project someone else's characters, and the author would spend their first ten minutes deleting
  them. Character and location sheets are created by `doc.create`, which already puts them in
  their conventional homes.
- **`workspace.create` refuses a directory that already has contents.** Not "merges", not
  "overwrites". A non-empty target is either an existing project (use `workspace.open`) or
  somebody's files (do not touch them). The refusal names which.
- **It warns, and proceeds, when the target sits inside an existing git repo.** `RepoResolver`
  already reports a project merely sitting inside a larger repo and refuses to commit in it
  ([`repos-and-commits.md`](../../repos-and-commits.md)) — so a project created three levels down in
  a monorepo will silently get no commit-on-save. The `check` sentence must say that before the
  directory exists, because afterwards the symptom is "my edits aren't being committed" with no
  visible cause.

  > **Superseded** by
  > [`new-project-as-its-own-dialog-and-its-own-repo.md`](new-project-as-its-own-dialog-and-its-own-repo.md).
  > It now proceeds with a repository of its **own** — `initRepoAt` rather than `ensureRepo` — so
  > commit-on-save works and there is nothing left to warn about. The sentence survives as a fact
  > appended to the accept, saying the new project will be a repository nested inside the one that
  > already owns the path.
- **Creating opens.** The command ends with the same `host.openWorkspace` call `workspace.open`
  uses, so the teardown-and-rebuild contract (session, command stack and undo journal rebuilt
  against the new root) is exercised by one code path, not two.
- **Recents are a submenu built from the command, not from `localStorage` in the renderer.**
  `workspace.recent` is already the answer; the menu calls it and builds entries that invoke
  `workspace.open(path=…)`. The renderer must not learn a second way to know which projects exist.

## Stage 1 — `workspace.create`

`apps/desktop/src/main/workspace.ts`:

```ts
export interface CreateInspection {
  root: string;
  exists: boolean;
  empty: boolean;
  /** The repo that already owns this path, if any — commit-on-save will not run here. */
  insideRepo?: string;
}
export async function inspectCreate(root: string): Promise<CreateInspection>;
export async function createWorkspace(root: string, title: string): Promise<OpenResult>;
```

`createWorkspace` does, in order: `mkdir -p`, write the three skeleton files, then
`openWorkspace(root)` — which writes `project.yaml` only if the skeleton did not (it did), and
runs `ensureRepo`, so the first commit contains the skeleton rather than an empty tree.

`apps/desktop/src/main/commands/workspace.ts`:

```
workspace.create(path='…' title='…')
```

mutating, `check: wouldCreate` returning the sentence for each case — *"Creates a new project at
{root}: a starter scene, a story bible page, project.yaml and a git repo."* / *"{root} already
contains files — open it with workspace.open instead."* / the inside-a-repo warning appended to
the accept. `title` defaults to the directory's basename, matching `openWorkspace`.

A `workspace.createPick` is **not** added: the OS dialog for "choose a parent and type a name" is
a save-dialog, which is a different Electron API and a different set of platform behaviours. The
menu entry opens the palette on `workspace.create` with `path` empty, and the author types or
pastes a path — the same way every other path-taking command is reached today.

> **Superseded** by
> [`new-project-dialog-with-folder-browse.md`](new-project-dialog-with-folder-browse.md). The
> save-dialog reasoning holds; the conclusion does not. Splitting the path into a browsed folder
> and a `newFolder` checkbox makes each half something a chooser or a textbox can say on its own,
> so the palette's form became the dialog rather than a place to type a path.

Tests: `apps/desktop/src/main/tests/workspace.test.ts` gains `inspectCreate` cases (missing dir,
empty dir, non-empty dir, dir inside a repo) and a `createWorkspace` round-trip asserting that the
created project loads a model with one scene and **zero error diagnostics** — that assertion is
the whole point of the skeleton.

## Stage 2 — the menu

`apps/desktop/renderer/pathux/editors/header.ts`, `appMenu()`:

```ts
['New Project…',  () => openPalette('workspace.create'), undefined],
['Open Project…', () => openPalette('workspace.pick'),   undefined],
recentMenu(),                                   // a Menu built from workspace.recent
['Reindex Project', () => openPalette('workspace.reindex'), undefined],
```

`recentMenu()` builds a submenu (`createMenu` returns a `Menu`, and a `Menu` is a valid template
item) from the recents already in `ShellState` if they are there, or from a `workspace.recent`
call at menu-build time otherwise. The project that is open is shown with a check or omitted —
one of the two, decided when the entries are first seen on screen. An empty list renders a single
disabled-looking `(none)` entry rather than an empty submenu.

## Stage 3 — documentation

- `docs/desktop-app.md`, the "which project is open" section: `workspace.create`, the skeleton,
  and the menu set.
- `docs/repos-and-commits.md`: one sentence that creating inside an existing repo is allowed and
  warned about, pointing at the `owned: false` behaviour it leads to.
- `CLAUDE.md`: the workspace bullet gains *creating* beside opening.

## Acceptance

- `pnpm check`, `pnpm test`, `pnpm lint` green.
- **New Project…** on a fresh path creates the directory, the skeleton and a git repo with one
  commit, and the app is open on it when the command returns.
- The new project shows **no error diagnostics** and the branches pane draws one scene.
- **New Project…** on a directory with files in it refuses with a sentence naming
  `workspace.open`.
- The recents submenu lists previously opened projects and opening one from it works.

All four were verified live over CDP against the running app: `workspace.create` on a fresh path
produced `project.yaml` + `scenes/opening.md` + `wiki/index.md` under one `New project` commit and
the app came back open on it; `workspace.index` on the result reported one scene, the mined
location `a_room`, `entry: opening` and `diagnostics: []`; the same command on `templates/basic`
refused by naming `workspace.open`, and on a fresh path inside this repo accepted with the
inside-a-repo warning appended; the recents submenu held one entry per remembered root, labelled by
basename, with the open project absent — and refetched itself when another was opened from it.

## Shipped deviations

- **`CreateInspection` also carries `directory`.** The plan's four fields cannot tell "the path is
  a file" from "the directory has files in it", and those want different sentences.
- **`ensureRepo` runs before `openWorkspace`, and `created: true` is set afterwards.** The plan had
  `openWorkspace` do the `ensureRepo`, which would have committed under its own subject; creating
  the repo first gets the honest `New project`, and `openWorkspace` then finds a `project.yaml`
  already there and only reads it — so the returned `created` flag has to be re-asserted to keep
  its documented meaning.
- **The recents list is cached on the header, keyed by `projectTitle`.** The plan left "from
  `ShellState` if they are there, or a call at menu-build time" open. `ShellState` does not carry
  them, and fetching per menu build would fetch on every `rebuild`; the title is the cheap signal
  that the project changed, so one fetch per project is the guard.
- **The open project is omitted rather than checked.** The plan allowed either. `workspace.open`
  refuses that root by name, and an entry that cannot be taken is worse than one not offered.
- **Later correction: only `New Project…` opens the palette.** The plan's Stage 2 snippet had all
  four entries do it, and the app shipped that way — but `workspace.pick` and `workspace.reindex`
  take no argument and ask for no confirmation, so the palette was an empty form dismissed with the
  same click that opened it. Both now run from the menu and report what they answered; `New
  Project…` keeps the palette because `workspace.create` needs a path no chooser can express.
- **Later correction: `New Project…` browses.** The paragraph refusing a `workspace.createPick` is
  superseded by
  [`new-project-dialog-with-folder-browse.md`](new-project-dialog-with-folder-browse.md): `path` is
  a `prop.directory` with a Browse… button beside it, and a `newFolder` checkbox decides whether the
  project lands in the browsed folder or in a `slug(title)` child of it.
