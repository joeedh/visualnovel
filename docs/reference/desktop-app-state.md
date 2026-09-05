# The desktop app: session state and project lifecycle

<!-- toc -->

- [Remembered UI state (two `session.json` files)](#remembered-ui-state-two-sessionjson-files)
- [Which project is open](#which-project-is-open)
- [Seeded workspace (`examples/mySampleRepo`)](#seeded-workspace-examplesmysamplerepo)

<!-- tocstop -->

This page is part of [`desktop-app.md`](desktop-app.md). It covers what the shell remembers between
runs, which project opens at launch, and the seeded sample workspace.

## Remembered UI state (two `session.json` files)

The state the shell persists lives in flat key/value files owned by the main process
(`apps/desktop/src/main/sessionstore.ts`), split by what each piece of state describes. One
`SessionState` (`sessionstate.ts`) routes every read and write, and `isProjectKey` alone decides
which file a key is stored in. The full write-up is in [`desktopAppState.md`](desktopAppState.md).

- **The project's own file** is `<root>/.vnstudio/session.json`, which holds every `pathux.` key:
  each window's mesh, its selection, the template it has applied, and the list of open windows with
  their bounds. It sits beside the layout templates and is gitignored, so an arrangement stays in
  the clone it was made in. `UNDO_EXCLUDES` names it as well, so `UndoJournal.check` does not count
  a debounced write mid-command as worktree drift.
- **Per-install state.** `<userConfigDir()>/desktop/session.json` holds the state that is
  specific to this machine: `agent.budget`, the notification filter, and the recents list.
  `@vn/config` stores API keys in that same directory (`%LOCALAPPDATA%\vnauthor` on Windows), so
  user-level state lives at one address rather than two. `VN_DESKTOP_HOME` relocates it, which is
  how a test gets its own directory. A development run shares the installed app's directory
  deliberately, because a second directory splits the recents list in two. The store must not sit
  under the bundle: a packaged app's `__dirname` is inside `app.asar`, which is a file, so a store
  derived from it fails `ENOTDIR` before the first window opens and the app hangs with nothing on
  screen.

- **Three keys per window, debounced.** `pathux.window.<n>.layout` holds the nstructjs-serialized
  screen (JSON, magic `VNSC`, written through path.ux's own `simple.saveFile`, which stamps the
  struct schema into the blob so a layout written before path.ux changed a `STRUCT` still reads
  back). `pathux.window.<n>.selection` holds six ids: scene, shot, character, document, asset and
  task. `pathux.window.<n>.template` holds the applied layout template. All flush 400 ms after the
  last change and again on `beforeunload`, since a quit does not run the debounce.
- **A restored selection may name something that no longer exists.** `settleSelection` checks the
  selection once, after the first paint. `asset.info` repairs a hash that a later render replaced,
  and clears a hash the manifest no longer holds. A scene or character the workspace index does not
  list is cleared, and clearing a scene also clears the shot. Each write back is guarded on the
  field still holding what restore put there.
- **Nothing here may block boot.** A layout that will not load (because it is corrupt or because
  it names an editor this build does not include) is discarded with a warning, and the default
  screen takes its place. A missing or unreadable file reads back as `{}`. A hand-edited file with
  a UTF-8 BOM reads back the same way and reports nothing, so do not debug through one. A project
  whose `.vnstudio` cannot be written keeps no arrangement at all. Writes are dropped and reads
  return the default.
- **Synchronous first read.** The preload makes one `sendSync('session:snapshot:sync')` call and
  receives both files as one map, so the remembered layout is painted first, instead of the default
  being painted and then replaced.
- A workspace switch reloads every window, which re-runs the boot path against the new project's
  file. A window that has not reloaded yet stamps its writes with the scope it was loaded for, so
  its last flush cannot land in the project just opened.
- **Multi-instance by construction.** Two app instances can share a file, so a flush takes a
  `mkdir` lock (breaking a stale lock older than 5s), re-reads the file inside the lock, and
  applies only its dirty keys over what it finds. Different keys from different instances both
  survive. The same key is last-flush-wins.

## Which project is open

The app opens one workspace at a time. The workspace resolves in `app.whenReady()` before the asset
protocol or any session exists, and that resolution is no longer permanent. Plan:
[`../plans/archive/INDEX.md#project-bootstrap-and-workspace-picker`](../plans/archive/INDEX.md#project-bootstrap-and-workspace-picker).

**Precedence at launch.** The first match takes precedence:

1. `--project <dir>` / `VN_PROJECT`.
2. The most recent remembered project that still exists.
3. 3. **The directory picker** — implements the requirement's own "the app requests the user to
   pick a directory". It appears only on a genuine first run. `VN_NO_PICKER=1` skips it.
4. 4. The seeded sample below. Cancelling the picker produces the same sample.

Every project that is opened is recorded, including the sample, so the picker asks once per install
rather than once per launch. The list is stored at `workspace.recent` in the global session store.
It must be readable before any project is open, so it is kept per install rather than per project.

- **Opening another project** uses `workspace.pick` (the dialog) or `workspace.open(path='…')`
  (the scriptable form). A directory that is not a project yet becomes one: `openWorkspace` writes
  a one-line `project.yaml`, where `title` is the only key without a default and a new project
  starts empty rather than as a copy of the sample. `ensureRepo` then initializes a repo and
  commits whatever was already there. A `project.yaml` that will not parse is refused rather than
  opened.
  - `workspace.open`'s check reports which of the two is about to happen ("Opens *The Transfer
    Student*" vs "Creates a new project at …"). It refuses the root that is already open, a path
    that is not a directory, and a switch while a pipeline run or agent turn is in flight
    (`WorkspaceSession.busy()`).
- **`workspace.create(path='…' title='…' newFolder=false)` creates a project, and it scaffolds
  where opening does not.** The two deliberately promise different things: opening a directory the
  author already has must not litter it, whereas "create a new project here" is an explicit request
  for a project, and a project whose model will not build is a worse answer than three files. So
  `createWorkspace` writes a skeleton — `project.yaml` (`title` + `start: opening`),
  `scenes/opening.md` (a Fountain slug line and two lines to write over), `wiki/index.md` (an empty
  story-bible page) — then `ensureRepo` commits it as `New project`, and only then opens it through
  the same `host.openWorkspace` every other path takes. The skeleton is not a copy of
  `templates/basic`, which holds somebody else's story and would leave the author spending their
  first ten minutes deleting a cast. One assertion sizes the skeleton: the created project builds a
  model with no error diagnostics, so the header's first count is zero rather than red.
- **`newFolder` lets an OS directory chooser stand in for a save dialog.** Off is the default,
  and is what `workspace.create(path='/x/y')` has always meant: the project goes at `path`. On, the
  project goes in `slug(title)` inside `path`, so the author picks a parent directory in the
  chooser and types a name in a textbox. The rule is `createRoot(path, title, newFolder)`, and
  every sentence `wouldCreate` produces names the root it resolved, so the author reads where the
  project lands rather than applying the rule themselves. Turning it on with a title that slugs to
  nothing is refused, because there is no root yet to take a `basename` from.
- `inspectCreate` refuses a path that is a file, and refuses a directory with anything in it ("…
  already contains files — open it with workspace.open instead"). It never merges and never
  overwrites. Sitting inside a larger git repo is a fact appended to the accept rather than a
  refusal, and it is no longer a warning: creating a project initializes a repository at its own
  root whatever encloses it (`initRepoAt`, the deliberate opposite of `ensureRepo`), so the accept
  says the new project will be a repository nested inside the one that already owns the path
  ([`repos-and-commits.md`](repos-and-commits.md)). Like every mutator, `run` re-runs the check
  rather than trusting the one the form showed.
- The app menu holds all three.
  - **New Project…** opens `workspace.create`'s own dialog with `newFolder` checked. That dialog
    holds a `path` field with a **Browse…** button beside it, a title, the checkbox that turns the
    path and title into a directory no chooser could have named, and Cancel beside the button.
  - **Open Project…** runs `workspace.pick` outright, since the chooser it raises already
    collects what a form would. (A dialog serves a command with something to collect or something
    to confirm. An entry with neither (this one and **Reindex Project**) would draw an empty form
    the author dismisses with the same click that opened it.)
  - **Recent Projects** is a submenu built from `workspace.recent`. Each remembered root gets one
    entry, labelled by its last path segment, carrying the full path as the tooltip, and invoking
    `workspace.open(path=…)`. The renderer keeps no list of its own. It refetches once for each
    project it runs in, and leaves the open project out rather than checking it, because
    `workspace.open` refuses that root by name.
  - Browsing calls `workspace.chooseDirectory`, which is non-mutating, takes no props, and
    returns the chosen absolute path in `data` (or `Cancelled.` when there is none). The Browse
    button is therefore an invocation like every other button in the app rather than a
    renderer-only capability, and CDP can invoke the same command.
- **Set Up API Keys…** is in the same menu, and it is the one entry that opens a pane rather than
  a dialog: `view.open(editor='onboarding', where='elsewhere')`. It used to raise the bare form of
  `project.setKey`, which offered a provider dropdown and the key field. That form is still in the
  palette, but it is no use to someone who does not have a key yet, and
  [Setup](desktop-app-editors-misc.md#setup) shows the same form with the steps for getting one
  above it. The pane is also where the key field is finally masked. The pane owns a shadow root, so
  a `type="password"` input is an ordinary element there rather than the one raw widget placed
  inside a path.ux form.
  - `project.setKey` writes `keys/<gemini.txt|claude.txt>` wherever it is invoked from, and that
    filename is the first one `resolveKeys` looks for, so the file written is the file read. At
    `scope=project` that directory sits inside the project, and `keys` is added to `.gitignore`
    before the write, because commit-on-save runs `git commit -A` and commits a key that git tracks
    within the second. At `scope=user` it is the user-level directory, which no repository
    contains, so no snapshot captures it. The key is a `secret` prop, so the history records
    `<secret>`, and the command is deliberately not undoable: creating an undo point takes a git
    snapshot, and the command exists to keep credentials out of snapshots. When the provider's
    environment variable is set, both the check and the result say so, because the environment
    variable takes precedence and the file would go unused.
- **Switching workspaces tears the session down rather than refreshing it.** The session (with
  its agent conversation), the command stack, its undo journal, the repo map and the undo revision
  are all rebuilt against the new root. Undo never crosses a workspace boundary, and the renderer
  remounts when it receives the `command:ui` effect (`{ type: 'workspace' }`). Nothing may cache
  the root across a switch — the `vnasset://` handler resolves `ProjectPaths` per request for
  exactly that reason.

## Seeded workspace (`examples/mySampleRepo`)

When no project is stored and `VN_PROJECT` is unset, the app seeds `examples/mySampleRepo` from
`templates/basic` (apps/desktop/src/main/workspace.ts).

- **Why**: a real run writes ~100 MB into `vngen/`, and doing that in the source tree floods `git
  status` and makes it hard to tell the sample we ship from the copy you have edited. The whole of
  `examples/` is gitignored, so a seeded workspace's own git repo is invisible to the parent. There
  is no submodule, no `gitlink`, and no `--recursive` clone. The committed template lives in
  `templates/`, which is a different tree on purpose.
- **Seeding copies inputs only.** It copies everything in the template except `vngen/` (a fresh
  workspace has not been run) and `keys/` (secrets), then runs `git init` and commits them as
  `Sample project inputs`. A local `user.*` is set only when git has no committer identity already
  configured; `core.autocrlf false` is always set, because the branch editor patches scene prose
  byte-exactly.
- **An existing directory is opened untouched.** The directory is the user's working copy, so it
  is never re-copied and never overwritten. Resetting it is `rm -rf examples/mySampleRepo`, which
  needs no code and cannot misfire. A copy seeded before the template became one file per scene
  therefore still holds the `screenplay/` form, which no longer loads. Run `workspace.import` on
  it, or delete the directory to get the current template.
- **The template directory marks a source checkout.** `examples/` is ignored and a fresh clone
  has none, so `seedSample` probes for `templates/basic` instead. A packaged build has neither, so
  it falls back to `app.getPath('userData')/mySampleRepo` and then fails by name.
