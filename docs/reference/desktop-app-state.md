# The desktop app: session state and project lifecycle

<!-- toc -->

- [Remembered UI state (two `session.json` files)](#remembered-ui-state-two-sessionjson-files)
- [Which project is open](#which-project-is-open)
- [Seeded workspace (`examples/mySampleRepo`)](#seeded-workspace-examplesmysamplerepo)

<!-- tocstop -->

Part of [`desktop-app.md`](desktop-app.md) — what the shell remembers between runs, which project
opens at launch, and the seeded sample workspace.

## Remembered UI state (two `session.json` files)

Everything the shell should remember lives in flat key/value files the main process owns
(`apps/desktop/src/main/sessionstore.ts`), split by what the state is about. One `SessionState`
(`sessionstate.ts`) routes every read and write, and `isProjectKey` is the only thing that decides
which file a key lands in. Full write-up: [`desktopAppState.md`](desktopAppState.md).

- **The project's own file**, `<root>/.vnstudio/session.json`, holds every `pathux.` key: each
  window's mesh, its selection, the template it has applied, and the list of open windows with
  their bounds. It sits beside the layout templates, and it is gitignored — an arrangement stays in
  the clone it was made in. `UNDO_EXCLUDES` names it as well, so a debounced write mid-command does
  not read as worktree drift to `UndoJournal.check`.
- **The install's file**, `<userConfigDir()>/desktop/session.json`, holds what is about this
  machine: `agent.budget`, the notification filter, and the recents list. That is the same home
  `@vn/config` gives API keys (`%LOCALAPPDATA%\vnauthor` on Windows), so user-level state has one
  address rather than two. `VN_DESKTOP_HOME` relocates it, which is how a test gets its own; a
  development run deliberately shares the installed app's, because a second home is how a recents
  list quietly forks in two. It is emphatically **not** a path under the bundle: a packaged app's
  `__dirname` is inside `app.asar`, which is a *file*, so a store derived from it fails `ENOTDIR`
  before the first window and the app hangs with nothing on screen.

- **Three keys per window, debounced.** `pathux.window.<n>.layout` is the nstructjs-serialized
  screen (JSON, magic `VNSC`, written through path.ux's own `simple.saveFile`, which stamps the
  struct schema into the blob so a layout written before path.ux changed a `STRUCT` still reads
  back). `pathux.window.<n>.selection` is six ids — scene, shot, character, document, asset and
  task. `pathux.window.<n>.template` is the applied layout template. All flush 400 ms after the
  last change and again on `beforeunload`, since a quit does not run the debounce.
- **What a restored selection names may be gone.** `settleSelection` checks it once, after the
  first paint: `asset.info` repairs a hash a later render replaced and clears one the manifest no
  longer holds, and a scene or character the workspace index does not list is cleared, taking the
  shot with the scene. Each write back is guarded on the field still holding what restore put
  there.
- **Nothing here may block boot.** A layout that will not load — corrupt, or naming an editor this
  build has not got — is discarded with a warning and the default screen takes its place. A missing
  or unreadable file reads back as `{}`, which is also how a hand-edited file with a UTF-8 BOM
  behaves; quietly, so do not debug through one. A project whose `.vnstudio` cannot be written
  keeps no arrangement at all: writes are dropped and reads answer the default.
- **Synchronous first read.** The preload does one `sendSync('session:snapshot:sync')` and gets
  both files as one map, so the remembered layout is the first thing painted rather than a jump
  away from the default.
- **A workspace switch reloads every window**, which re-runs the boot path against the new
  project's file. A window that has not reloaded yet stamps its writes with the scope it was
  loaded for, so its last flush cannot land in the project just opened.
- **Multi-instance by construction.** Nothing stops two app instances sharing a file, so a
  flush takes a `mkdir` lock (stale ones, >5s, are broken), re-reads the file _inside_ the lock,
  and applies **only its dirty keys** over what it finds. Different keys from different
  instances both survive; the same key is last-flush-wins.

## Which project is open

One workspace at a time, resolved in `app.whenReady()` before the asset protocol or any session
exists — but no longer resolved *forever*. Plan:
[`../plans/archive/INDEX.md#project-bootstrap-and-workspace-picker`](../plans/archive/INDEX.md#project-bootstrap-and-workspace-picker).

**Precedence at launch**, first hit wins:

1. `--project <dir>` / `VN_PROJECT`.
2. The most recent remembered project that still exists.
3. **The directory picker** — the requirement's own "the app requests the user to pick a
   directory", shown on a genuine first run only. `VN_NO_PICKER=1` skips it.
4. The seeded sample below, which is also what cancelling the picker gets you.

Whatever is opened is remembered, the sample included, so the picker asks once per install and
not once per launch. The list lives at `workspace.recent` in the global session store — it has to
be readable before any project is open, which is why it is per install rather than per project.

- **Opening another project** is `workspace.pick` (the dialog) or `workspace.open(path='…')` (the
  scriptable one). A directory that is not a project yet *becomes* one: `openWorkspace` writes a
  one-line `project.yaml` — `title` is the only key without a default, and an empty project is
  empty, not a copy of the sample — then `ensureRepo` initializes a repo and commits whatever was
  already there. A `project.yaml` that will not parse is refused rather than opened.
  - `workspace.open`'s check says which of the two is about to happen ("Opens *The Transfer
    Student*" vs "Creates a new project at …"), and refuses the root that is already open, a path
    that is not a directory, and a switch while a pipeline run or agent turn is in flight
    (`WorkspaceSession.busy()`).
- **Creating one is `workspace.create(path='…' title='…' newFolder=false)`, and it scaffolds where
  opening does not.** The two are deliberately different promises: opening a directory the author
  already has must not litter it, whereas "create a new project here" is an explicit request for a
  project, and one whose model will not build is a worse answer than three files. So
  `createWorkspace` writes a skeleton — `project.yaml` (`title` + `start: opening`),
  `scenes/opening.md` (a Fountain slug line and two lines to write over), `wiki/index.md` (an empty
  story-bible page) — then `ensureRepo` commits it as `New project`, and only then opens it through
  the same `host.openWorkspace` every other path takes. The skeleton is not a copy of
  `templates/basic`: that is somebody else's story, and the author would spend their first ten
  minutes deleting a cast. It is sized by one assertion — the created project builds a model with
  **no error diagnostics**, so the header's first count is zero rather than red.
- **`newFolder` is what makes an OS chooser enough.** Off — the default, and what
  `workspace.create(path='/x/y')` has always meant — the project goes at `path`. On, it goes in
  `slug(title)` **inside** `path`, so "choose a parent and type a name" becomes a folder the
  chooser can answer and a textbox the author can, instead of a save-dialog. The rule is
  `createRoot(path, title, newFolder)` and every sentence `wouldCreate` produces names the root it
  resolved, so the author reads where the project lands rather than applying the rule themselves.
  On with a title that slugs to nothing is a refusal: there is no root yet to take a `basename`
  from.
- **The refusals are `inspectCreate`'s**: a path that is a file, and a directory with anything in
  it (*"… already contains files — open it with workspace.open instead"*) — never a merge, never
  an overwrite. Sitting inside a larger git repo is a **fact appended to the accept**, not a
  refusal and no longer a warning: creating a project initializes a repository **at** its own root
  whatever encloses it (`initRepoAt`, the deliberate opposite of `ensureRepo`), so the accept says
  the new project will be a repository nested inside the one that already owns the path
  ([`repos-and-commits.md`](repos-and-commits.md)). Like every mutator, `run` re-runs the check
  rather than trusting the one the form showed.
- **The app menu is where all three live.**
  - **New Project…** opens `workspace.create`'s **own dialog** with `newFolder` checked — a
    `path` field with a **Browse…** button beside it, a title, the checkbox that turns the two
    into a directory no chooser could have named, and Cancel beside the button.
  - **Open Project…** runs `workspace.pick` outright, since the chooser it raises is the form. (A
    dialog is for a command with something to collect or something to confirm — an entry with
    neither, like this one and **Reindex Project**, would draw an empty form the author dismisses
    with the same click that opened it.)
  - **Recent Projects** is a submenu built from `workspace.recent` — one entry per remembered
    root, labelled by its last path segment with the full path as the tooltip, each invoking
    `workspace.open(path=…)`. The renderer keeps no list of its own; it refetches once per project
    it finds itself in, and leaves the open project out rather than checking it, because
    `workspace.open` refuses that root by name.
  - Browsing is `workspace.chooseDirectory` — non-mutating, no props, the chosen absolute path in
    `data` and `Cancelled.` when there is none — so the Browse button is an invocation like every
    other button in the app rather than a renderer-only capability, and CDP can reach the same act.
- **Set Up API Keys…** is in the same menu, and it is the one entry that opens a **pane** rather
  than a dialog: `view.open(editor='onboarding', where='elsewhere')`. It used to raise
  `project.setKey`'s bare form — a provider dropdown and the key itself — and that form is still
  in the palette, but a box asking for a credential is no use to someone who does not have one
  yet, and [Setup](desktop-app-editors-misc.md#setup) is the same box with the steps for getting
  there above it. It is also where the key field is finally **masked**: the pane owns a shadow
  root, so a `type="password"` input is an ordinary element there rather than the one raw widget
  smuggled into a path.ux form.
  - Wherever it is invoked from, `project.setKey` writes `keys/<gemini.txt|claude.txt>` — the
    first filename `resolveKeys` looks for, so what is written is what is read. At `scope=project`
    that is inside the project, and `keys` is added to `.gitignore` **before** the write, because
    commit-on-save runs `git commit -A` and a key git can see is committed within the second; at
    `scope=user` it is the user-level directory, which no repository contains and which therefore
    has no snapshot to worry about. The key is a `secret` prop, so the history records `<secret>`,
    and the command is deliberately **not undoable** — an undo point is a git snapshot, and
    snapshotting a credential is the one thing it exists to avoid. When the provider's environment
    variable is set, the check and the result both say so — the variable wins, so the file would
    go unused.
- **A switch is a teardown, not a refresh.** The session (with its agent conversation), the
  command stack, its undo journal, the repo map and the undo revision are all rebuilt against the
  new root: undo never crosses a workspace boundary, and the `command:ui` effect the renderer
  receives (`{ type: 'workspace' }`) is a remount. Nothing may cache the root across it — the
  `vnasset://` handler resolves `ProjectPaths` per request for exactly that reason.

## Seeded workspace (`examples/mySampleRepo`)

With nothing remembered and no `VN_PROJECT`, the app seeds **`examples/mySampleRepo`** from
`templates/basic` (`apps/desktop/src/main/workspace.ts`).

- **Why**: a real run writes ~100 MB into `vngen/`, and doing that in the source tree buries
  `git status` and erases the line between the sample we ship and the copy you've been messing
  with. The whole of `examples/` is **gitignored**, so a seeded workspace's own git repo is
  invisible to the parent — no submodule, no `gitlink`, no `--recursive` clone. The committed
  template lives in `templates/`, which is a different tree on purpose.
- **Seeding copies inputs only** — everything in the template except `vngen/` (a fresh
  workspace has not been run) and `keys/` (secrets) — then `git init`s and commits them as
  `Sample project inputs`. A local `user.*` is set only when git can't already answer who the
  committer is; `core.autocrlf false` is always set, since the branch editor patches scene
  prose byte-exactly.
- **An existing directory is opened untouched.** Never re-copied, never overwritten: it is the
  user's working copy. Resetting it is `rm -rf examples/mySampleRepo`, which needs no code and
  cannot misfire. A copy seeded before the template became one file per scene therefore still
  holds the `screenplay/` form, which no longer loads: run `workspace.import` on it, or delete
  the directory to get the current template.
- **The template is what says this is a source checkout.** `examples/` is ignored and a fresh
  clone has none, so `seedSample` probes for `templates/basic` instead; a packaged build, having
  neither, falls back to `app.getPath('userData')/mySampleRepo` and then fails by name.
