# The command system

<!-- toc -->

- [Why it exists](#why-it-exists)
- [Two halves](#two-halves)
- [Properties are declarative specs, not zod](#properties-are-declarative-specs-not-zod)
    - [`coerceProps` is the single validation authority](#coerceprops-is-the-single-validation-authority)
- [The DSL](#the-dsl)
- [The stack](#the-stack)
    - [`CommandRecord`](#commandrecord)
    - [Undo is opt-in, and rests on content-addressed snapshots](#undo-is-opt-in-and-rests-on-content-addressed-snapshots)
    - [Checkpoints group several commands into one undo point](#checkpoints-group-several-commands-into-one-undo-point)
    - [Commit-on-save is the journal's sibling](#commit-on-save-is-the-journals-sibling)
- [The registered commands](#the-registered-commands)
    - [The `window.` namespace](#the-window-namespace)
    - [`origin` — which window asked](#origin--which-window-asked)
    - [The `doc.` namespace](#the-doc-namespace)
    - [The `prompt.` namespace](#the-prompt-namespace)
    - [Interactions: the gesture surface](#interactions-the-gesture-surface)
    - [Preconditions: asking before acting](#preconditions-asking-before-acting)
- [Reaching the commands](#reaching-the-commands)
    - [From the renderer](#from-the-renderer)
    - [From the palette, or from a command's own dialog](#from-the-palette-or-from-a-commands-own-dialog)
    - [From a right-click](#from-a-right-click)
    - [From DevTools or CDP](#from-devtools-or-cdp)
    - [From the agent](#from-the-agent)
- [The catalog](#the-catalog)
- [Testing](#testing)
- [Follow-ons](#follow-ons)

<!-- tocstop -->

The desktop shell takes every action through a registered command, which is a named,
described, typed shim over a function that already exists. The palette, the menu bar, the
document tree's right-click menus, and an external CDP client all reach the same registry
through the same execution path, and every execution is recorded with the document repo's
git HEAD. The authoring agent deliberately does not reach the registry. Its tools share
the commands' decisions and never the registry itself — see
[From the agent](#from-the-agent).

This document describes what shipped. The implementation plan (including the deviations
from it and the follow-ons deliberately left out) is
[`../plans/archive/INDEX.md#command-system`](../plans/archive/INDEX.md#command-system).
Undo/redo landed later, on top of this. The strategy survey is
[`../history/gitUndoOptions.md`](../history/gitUndoOptions.md), and the plan that carried
out its recommendation is
[`../plans/archive/INDEX.md#command-undo-redo`](../plans/archive/INDEX.md#command-undo-redo).

---

## Why it exists

Before this, every desktop action was a bespoke IPC channel hand-registered in
`apps/desktop/src/main/index.ts` and hand-wired to a React handler: `gate:approve`,
`pipeline:run`, `agent:setMode`. That design provided no discovery (the palette was a
static mockup), no history, no provenance tying an action to the state of the repo when it
ran, and no way to control the app from outside for scripting or debugging.

The command system replaces that with one registry, one execution path, and one catalog.

---

## Two halves

The boundaries lint rule enforces the split.

**`packages/commands` (`@vn/commands`) is the framework.** It holds prop specs, the
registry, the DSL, the execution stack, and the catalog projection. It is domain-agnostic
(it knows nothing about visual novels) and depends only on `types`, `util`, and `git`,
which supplies the `Git` type it uses to read HEAD.

`apps/desktop/src/main/commands/` holds the actual commands. The commands need the
`WorkspaceSession`, and `apps/desktop` is already the sanctioned join point above both the
pipeline and authoring branches. Each definition is a thin wrapper over a session method
that already existed, so registering a command required moving no logic.

`@vn/commands` deliberately mirrors `@vn/authoring`'s `Tool` registry. The two serve
different purposes. A `Tool` is advertised to an LLM and is gated by the agent's
plan/execute mode. A `Command` belongs to the app's own vocabulary and is recorded on a
stack with provenance. They stay separate because their gating rules differ.

---

## Properties are declarative specs, not zod

```ts
export interface Prop<T extends PropValue = PropValue, Req extends boolean = boolean> {
    kind: "string" | "directory" | "secret" | "number" | "boolean" | "enum" | "string[]";
    description: string;
    required: Req;
    default?: T;
    values?: readonly string[]; // enum only
    min?: number; // number only
    max?: number;
    digest?: boolean; // bulk content: recorded as a fingerprint, drawn as a size label
    multiline?: boolean; // free text of more than a line: drawn as a box to write in
    hint?: string; // the hover sentence, where `description` is drawn as a label instead
}
```

A command's props have to serialize into the build-time JSON catalog, coerce the loose
values arriving from the DSL and CDP, and (later) drive a properties panel. One
introspectable spec serves all three uses. A zod schema serves none of the three without a
second hand-rolled walker — the repo is on zod 3, so there is no `z.toJSONSchema`, and
`@vn/authoring` already had to hand-roll `describeToolParams` for the same reason.

Builders cover the kinds `prop.string`, `prop.directory`, `prop.secret`, `prop.number`,
`prop.boolean`, `prop.oneOf`, and `prop.stringList`. Each is overloaded so that passing a
`default` narrows `required` to `false`:

```ts
props: {
  characterId: prop.string('the character to approve'),                 // required
  mock: prop.boolean('dry run: preview only', { default: true }),       // optional
  mode: prop.oneOf(['plan', 'execute'] as const, 'the mode to switch to'),
}
```

`directory` is a string type that marks a field the OS can fill in. It coerces, serializes
and schematizes exactly as `string`, because it is one, and exists only so a form can
offer a folder chooser beside the field. The alternative is a form that draws a Browse
button for any property spelled `path`, which makes a widget depend on spelling.

`secret` is a string that must never be written down. It uses the same mechanism for the
opposite reason: it coerces and schematizes as a string, and `digestProps` replaces its
value with the literal `<secret>`. `digestProps` is the single record-time projection, so
one seam covers `record.props`, the formatted `invocation` and the commit trailer built
from it. Do not reach for `digest` here, which is the near miss: it records
`<sha256:…+len>`, a fingerprint of a live credential and its exact length. `run` still
receives the real value, and nothing downstream of the record ever does.

`multiline` and `hint` control how a prop is drawn and change nothing about its value.
`multiline` marks a string that should be drawn as a box rather than a field, such as a
note or a paragraph of prose; unlike `digest`, the value is still typed, sent and recorded
in full. `hint` exists because a checkbox draws its `description` as its label, which
leaves nowhere for the tooltip every control owes the author. A prop whose label and
explanation are different sentences states both, and `hint` defaults to `description`, so
the ordinary case declares nothing.

`PropsOf<M>` maps the spec to the object `run` receives, and every key is present.
`coerceProps` has already applied the defaults, so optionality belongs to the raw input
rather than to the runtime object. `required` still matters, because the catalog reads it
off the spec to build the JSON-Schema `required` list, but it has no effect at the type
level.

### `coerceProps` is the single validation authority

```ts
coerceProps(specs, raw): { ok: true; value } | { ok: false; errors: string[] }
```

It applies defaults, coerces loose values (`'42'` → `42`, `'true'` → `true`, a bare string
→ a one-element `string[]`), range-checks numbers against `min`/`max`, rejects out-of-set
enum values, and rejects unknown keys. Nothing else validates props. `Agent.dispatch`'s
`safeParse` plays the same role for authoring tools.

---

## The DSL

```
namespace.command(prop1='bleh' prop2=1)
```

`src/dsl.ts` holds a hand-rolled tokenizer and recursive-descent parser. It is small
enough to keep "pure" and exhaustively testable, and its errors carry a column so the
palette can point at the offending character.

```
invocation := path '(' args? ')'
path       := ident ('.' ident)+          // at least two segments
args       := arg ((',' | ws) arg)*       // commas optional, whitespace suffices
arg        := ident '=' value
value      := quoted | number | 'true' | 'false' | array | bareword
```

Two choices are deliberate:

- **Barewords parse as strings**, so `agent.setMode(mode=execute)` reads naturally. `true`
  and `false` are the only exceptions; `coerceProps` handles every other value.
- **Arrays are string-only** (`[a, 'b c']`). Commands take no other kind of list.

`formatCommand(id, props)` is the inverse, used for the history display and the
`invocation` field of every record. A round-trip test pins
`parseCommand(formatCommand(x)) ≡ x`.

A command id matches `/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/`. Each id has at least
two dot-separated segments, and each segment starts with a lowercase letter. A segment may
use camelCase so that ids can mirror the IPC channels they wrap (`agent.setMode`). The
registry throws on a malformed or duplicate id, because each is an authoring bug rather
than a runtime state.

---

## The stack

`CommandStack` is the only execution path, and it orders its steps to match
`Agent.dispatch`:

1.  1. **Resolve** the id in the registry. Reports `unknown command "…"` if the id is
       absent.
2.  2. **Coerce and validate** props. Reports `invalid props for "…": …`, listing every
       error.
3.  3. **Confirm**, if the command is flagged `confirm: true`. If no gate is wired into
       the context, the command refuses rather than assuming consent. Tools follow the
       same rule.
4.  **Capture git state** — `gitHead` and `gitDirty`.
5.  5. Run, then record.

A command that throws still produces a record with `status: 'error'` and the error's
message. `exec` never throws for command-level failure; it returns a `CommandOutcome`
discriminated on `ok`.

Git state is recorded for provenance and does not affect control flow. A project need not
be a repo, so any failure reading it degrades to `{ head: null, dirty: false }` rather
than failing the command.

### `CommandRecord`

```ts
interface CommandRecord {
    seq: number; // total order within the session
    id: string;
    props: Record<string, PropValue>;
    invocation: string; // the DSL rendering — a copy-pasteable repro line
    source: "ui" | "menu" | "dsl" | "cdp" | "agent";
    mutating: boolean;
    gitHead: string | null; // document-repo HEAD at exec time; null outside a repo
    gitDirty: boolean; // whether the worktree was dirty when it ran
    startedAt: string;
    finishedAt: string;
    status: "ok" | "error";
    message: string;
    written?: string[]; // workspace-relative paths the command wrote
    error?: string;
    undo?: { pre: string; post: string; changed: boolean }; // tree hashes; absent ⇒ not an undo point
    stack?: "undo" | "redo"; // set on the stack's own entries, which are history, not undo points
    commits?: { repo: string; sha: string }[]; // what commit-on-save wrote; absent ⇒ nothing was
    commitDeferred?: true; // the commit joined a batch, so `commits` is absent for that reason
}
```

`onRecord` is a hook rather than a hardcoded write. The desktop app wires it to
`appendJsonl` at `vngen/state/commands.jsonl`, next to the pipeline's own `tasks.jsonl`.
Both are append-only logs that can be replayed and diffed.

### Undo is opt-in, and rests on content-addressed snapshots

v1 shipped without undo on purpose, because a half-working undo on an author's only copy
of their screenplay is worse than none. Undo landed once the story editors made
destructive edits reachable from a gesture. Its shape comes from
[`../history/gitUndoOptions.md`](../history/gitUndoOptions.md) §8: it snapshots the
document tree, splits the snapshots by data class, and refuses rather than guesses when
the worktree moved. The mechanism underneath was git shadow commits until
[`../plans/archive/undo-refactor.md`](../plans/archive/undo-refactor.md) replaced it with
an in-memory store of the same shape; the three properties above are unchanged. The
original is written up in full in
[`../plans/archive/INDEX.md#command-undo-redo`](../plans/archive/INDEX.md#command-undo-redo).

- **Opt-in per command.** `Command.undoable` widened from `?: false` to `?: boolean`, and
  only document mutators set it. Those are every `story.*` command (the branch and
  coverage commands it shipped for, the prose edits, `moveShot` and the two outfit
  commands), plus `doc.write`, `doc.create` and `doc.rename`, which write documents by the
  same right. The authored-input writers that followed set it too: `art.setNotes`,
  `project.setArtStyle` and the `prompt.*` chunk editors. A command whose writes are
  generated output stays out, as does one that straddles both classes. The `↺` column in
  the table below lists the full set. Read it there rather than counting here, because the
  set grows.
- **The store is `ContentStore` (`@vn/commands/snapshot`).** Files hash to blobs and
  directories hash to sorted entry lists, so identical directory states share a tree hash
  and comparing them compares one string. It holds bytes in memory and touches disk only
  to walk, read and restore. It uses no repository, no `git` binary and no object
  database. `apps/desktop`'s own file reads and writes go through the same store
  (main/filecache.ts), so a document the app just wrote is already hashed by the time the
  next snapshot reaches that path.
- **Bracketing.** With an `UndoJournal` wired, the stack captures the worktree before and
  after an undoable command and keeps the two tree hashes on the record. Snapshots are
  scoped to the document class: `UNDO_EXCLUDES` leaves out `vngen/build`, `vngen/state`,
  `assets/objects`, `keys/` and the session file, and the store leaves out media in every
  location it is stored in. That scoping is why a `pipeline.run` between two edits is not
  drift, and why the cost of a capture does not grow with the size of a project's art. A
  capture re-reads only the files whose `(mtime, size)` changed.
- **History lasts the session.** Nothing is written to disk to make a snapshot, so closing
  the app ends the undo history. Snapshots older than `keep` (50 commands) are dropped,
  and further snapshots are dropped while the store is over its byte ceiling. Undo then
  reports the missing snapshot instead of restoring an approximation.
- **`undo.changed` comes from a measurement, not from a command's report.** `undo.changed`
  compares the two trees, while `written` records what a command said it wrote. Two equal
  tree hashes prove that nothing changed. A `changed: false` record is walked past, so a
  no-op edit never becomes the undo point.
- **Undo refuses on drift.** Undo hashes the worktree first. If that tree is not the
  candidate's `post` tree, something changed since the command ran, and undo declines by
  name rather than discarding it.
- Redo restores the post state and never replays `invocation`. A replay is a re-run, not a
  redo.
- **A stack without a journal behaves exactly as before.** `undo()` / `.redo()` refuse.

A restore writes only the files whose hashes differ and deletes only the paths the
snapshot recorded. A generated asset in a directory that undo empties is therefore left in
place, and a file that nobody edited keeps its mtime.

Undo and redo each append their own `CommandRecord` tagged `stack`, so `commands.jsonl`
records every command that touched the worktree.

### Checkpoints group several commands into one undo point

A gesture that dispatches several mutating commands (path.ux's node editor deleting or
duplicating a multi-node selection, one command per node) would otherwise leave one undo
entry per node. `CommandStack.beginCheckpoint(shortLabel, message, scope)` /
`.endCheckpoint(handle)` bracket such a run so it lands as a single undo entry. The full
design and the five review rounds behind it are in
[`../plans/archive/undo-checkpoints.md`](../plans/archive/undo-checkpoints.md).

- **`scope` is a subtree declared by the caller, not a fact about a command namespace.**
  The checkpoint's snapshot (`UndoJournal.captureScoped`/`restoreScoped`) is confined to
  `scope`, which whoever opens the checkpoint decides. The caller is asserting that its
  commands write only within that subtree, and a successful command's own `written` is
  checked against `scope` after the fact; a mismatch is logged rather than refused. This
  sidesteps the general drift problem rather than solving it. A scoped snapshot does not
  record an edit outside `scope` (an authoring-agent write to a scene file, say), so its
  rollback has nothing to reconcile against such an edit. The cost is that one checkpoint
  can safely group edits only within one declared subtree.
- **One handle, one open checkpoint.** `CommandStack` is shared by every window, the
  agent, CDP and the DSL, and `beginCheckpoint` throws if a checkpoint is already open.
  `exec()` and `execDsl()` take an optional `CheckpointHandle`. A call tagged with the
  current handle chains onto the checkpoint's own serialized `tail` instead of
  `this.chain`. A call tagged with a stale handle (wrong seq, or no checkpoint open) is
  refused immediately. An untagged call made while a checkpoint is open queues behind it
  like any other in-flight mutation. That last case is the fallback for a caller that
  forgot to pass the handle; it is correct but unbatched. `CheckpointHandle` is
  deliberately just `{ seq }`, so it round-trips over IPC unchanged.
- **A failure rolls back the whole checkpoint**, not just the command that failed. An
  inner command's own catch and a `CHECKPOINT_TIMEOUT_MS` (120 s) timeout both call the
  same `failCheckpoint`, which restores `scope` to the checkpoint's `pre` tree, drops any
  still-pending deferred-commit record the checkpoint produced, and records a synthetic
  `stack.checkpointRollback` command so the reason lands in `commands.jsonl` rather than
  appearing as an unexplained clean-after-dirty worktree. No aggregate undo record is
  appended on failure, because from the author's perspective the checkpoint changed
  nothing.
- A successful close appends one aggregate `stack.checkpoint` record. Its `undo` spans
  `pre` to a pinning `captureScoped` of `post`. The capture pins rather than using
  `currentTreeScoped` so that the next `prune()` cannot collect the checkpoint's own
  `post` tree before anything reads it.
- **The renderer opens and closes a checkpoint from a widened, async delegate hook.**
  path.ux's `NodeGraphDelegate.undoStepBegin`/`undoStepEnd` (vendor/path.ux) take
  `Promise<void>` and `(shortLabel, message)`, so `apps/desktop`'s
  `GenGraphEditor.delegate()` can `await beginCheckpoint(...)` and `endCheckpoint(...)`
  there. `deleteSelected`, `duplicateSelected` and `singleUndoStep` are `async` for the
  same reason. An `AsyncGateOp` locks input for the span, so a second gesture cannot open
  a competing checkpoint before the first closes.

### Commit-on-save is the journal's sibling

`Committer` is a constructor option on the stack, absent by default, the same way
`UndoJournal` is. A stack without one moves no ref at all. With one, every mutating
command that left something on disk produces a commit in each repo it touched. The commit
subject comes from `CommandRecord.message`, and provenance goes in `Vn-*` trailers. The
resulting shas are recorded on `record.commits`.

The committer and the journal are independent. A commit changes no file in the worktree,
so it cannot perturb a snapshot tree taken either side of it, and the two keep different
scopes on purpose. The committer takes the whole worktree (`git add -A`), while the
journal takes only the document class. A command whose implementation already commits
declares `commitsItself: true`, and the committer leaves it alone; that is how
`vnauthor`'s one-commit-per-approved-plan survives.
[`repos-and-commits.md`](repos-and-commits.md) covers which repos are involved, what the
message looks like, and why the CLI stays out of it.

A command that a gesture sends once per frame declares `defersCommit: true` instead. Its
commit joins a batch. The next non-deferring mutating command, an undo, a redo, a
workspace switch, a quit, or 1500 ms of idleness commits that batch as one. The record is
written as usual with `commitDeferred: true` and no `commits`. The flush runs before the
next command's `run` rather than before its commit, so that command's commit holds only
its own files. Mutating commands are serialized end to end so a commit still holds only
its own files when two arrive at once.

---

## The registered commands

The full list, generated from the live registry, is
[`command-table.md`](command-table.md); the same commands grouped by namespace are
[`command-namespaces.md`](command-namespaces.md). `pnpm gen:command-table` regenerates
both, and `pnpm lint` checks them for staleness, so neither can drift from the live
registry as a hand-maintained count would.

Every write goes through a command. The `story.*` branch mutators go through
`session.editBranches(decide)` → `planMarkerEdit` → `applyMarkerPlan` → reload, and the
scene editors through `session.editScene(decide)`, so no surface writes scene prose by
another route. Shot decompositions work the same way: outside the planner,
`work/shots/<sceneId>.json` is written by `story.newShot` and `story.deleteShot`,
`story.setCoverage`, `story.setOutfit`, `art.setNotes` (a shot "rung"), the `prompt.*`
chunk editors, `editScene` (which carries a shot's coverage across a split, merge or
delete rather than stranding it) and `story.decomposeAll`. Two of those create a
storyboard where there was none: `story.decomposeAll` asks the model, and `story.newShot`
creates one by hand. Once the file is written, it takes precedence from then on.
`vnauthor`'s `set_outfit` and its shot tools add no further routes: they run the same
`@vn/scriptedit` rules and get the same refusals.

**Only what a snapshot of the worktree can restore is undoable** — the eighteen `story.*`
ones plus `doc.write`, `doc.create`, `doc.rename`, `art.setNotes`, the eight `prompt.*`
writers, `project.setArtStyle`, and the two `view.*` commands that write layout templates.
Those last two are the only undoable commands that are not document edits, and they
qualify for exactly the same reason: a template is an ordinary file in the project, inside
the class a snapshot covers, so undo puts the author's back. Which panes are open is _not_
— that is a window fact remembered per install, which is why `view.applyLayout` is neither
mutating nor undoable. `asset.accept` and `asset.regenerate` write into the generated
class instead (a manifest, a status log), so neither is undoable and neither needs to be:
accepting again and regenerating again are both ordinary acts. `asset.upload` is the same
class — bytes and a manifest row in the base store — and an upload nothing points at costs
nothing, so it is not undoable either. `art.generate` and `art.redraw` are the same shape
— bytes and a manifest row, and undoing an image you paid for by deleting it is not an
improvement (a redraw files a _new_ sketch and leaves the original where it is, so there
is nothing to undo). `art.promote` writes across _both_ classes at once (a location sheet,
a manifest row, and a `done` record in the task log), which is exactly what a document
snapshot cannot restore, so it asks for confirmation instead of offering undo.
`asset.adopt` and `asset.replace` are that same act with the sheet write dropped — the
`done` record `tasks.jsonl` has no un-appending for is reason enough on its own, and
superseding is recoverable the honest way instead, by adopting the earlier hash back.
`gate.approve` straddles both data classes — undoing `character.md` would leave
`manifest.json` still marking the asset `accepted` — `story.export`, `story.screenplay`
and `pipeline.run` write only generated output, and `agent.run` owns its own commits, one
per approved plan. `workspace.import` restructures the whole worktree, which is what a
whole-tree snapshot is worst at, and the `<name>.fountain.imported` it leaves behind is a
reversal the author can perform; `workspace.reindex` writes one derived file, and undoing
it means running it again; `project.setKey` writes into `keys/`, which `UNDO_EXCLUDES`
keeps outside the snapshot on purpose, so no undo can write over or delete a credential;
`upload.files`/`upload.pick` copy bytes in from outside the tree _and_ close the
conversation that was open, which `vngen/state` being outside the snapshot means undo
could not put back; and `workspace.open`/`workspace.pick`/`workspace.create` write into a
_different_ tree than the one a snapshot covers, and switching workspaces drops the
journal along with the stack. The reasoning is in
[`../plans/archive/INDEX.md#command-undo-redo`](../plans/archive/INDEX.md#command-undo-redo).

`view.*` commands run in the main process and push a `command:ui` effect that the renderer
applies (`applyView` moves the panes, `openPalette`/`closePalette` handle the palette).
The alternative would be a second, renderer-side registry, which would be one more thing
to keep in sync and which CDP could not reach.

An effect names an editor, never a room. The shell arranges panes in a mesh, so the whole
vocabulary is one flat list of editors in `apps/desktop/src/shared/editors.ts`, which is
browser-safe and imported by both halves. `prop.oneOf(EDITOR_IDS, …)` builds the props,
the header's View menu builds its items from the same array, and a stored layout names an
area by the same id. `checkEditorNames()` warns at boot if the renderer has not registered
an editor that a command offers. Main cannot see the editor registry, so without that
check a command would fail only when someone picked it.

**Main assumes the command will succeed, and the mesh corrects it.** `view.*` returns its
sentence (`Showing Coverage below.`) without waiting, because only the renderer tracks how
many panes exist. When the mesh cannot apply the view, `applyView` returns a different
sentence — `No pane is showing Inspector.`,
`This is the only pane — closing it would leave nothing.` — and the bridge reports that
sentence as an error. The `CommandRecord` still reads `ok`, because nothing was refused.
The command asked for something the layout had no room for.

`subject` names what the editor should show, in that editor's own vocabulary.
`view.open`/`view.focus` take it and publish it into the selection field the named editor
watches (`ui.docPath` for `wiki`/`documents`, `ui.assetHash` for `asset`), but only when
the mesh could show the editor at all, because a subject set on a pane that never opened
would move every other editor on that field instead. Routing per editor rather than always
writing `docPath` keeps an asset hash from arriving as a file path the wiki pane would try
to `doc.read`. `subject` is one optional prop rather than a second command, so "show me
her sheet" stays one act.

`where=elsewhere` means the pane is not placed on top of the one the author is looking at.
If a pane already shows the editor, that pane is focused. Otherwise the placement goes to
the biggest non-chrome pane other than the requesting pane. Only when the mesh has nowhere
else to put it does it split the requesting pane to the right. This exists because a click
in the documents tree opens the Asset editor, and a sidebar that replaced itself with the
asset it named would leave the author nothing to click next.

`where=window` is the one value that never reaches the mesh. It short-circuits in main
into `host.newWindow({editor, subject})` and returns the new window's index, because there
is no pane to split. The new window opens with whatever arrangement that window index last
had, with the named editor put in front of it. `where=window` is a `view.*` value rather
than a fourth `window.*` command so that "open the Asset editor over there" stays one
action however far away that window is.

### The `window.` namespace

The three commands are listed in
[`command-namespaces.md#window`](command-namespaces.md#window).

None of the three is `mutating`: a window holds a mesh of panes and nothing else, so there
is nothing to write, undo or commit. Both `close` and `quit` declare a `check` anyway. The
`check` does not refuse the command; it carries a note that a menu entry shows, so the
reader sees the consequence before pressing. `window.close` closes the window named by
`ctx.origin`. If `ctx.origin` names no window, `window.close` closes the focused window.

### `origin` — which window asked

`exec`, `execDsl` and `check` all take an optional trailing `origin: number`, an opaque
value that the framework never interprets; the desktop app happens to pass a window index.
It reaches a command as `ctx.origin`, and it lets `window.close` close the right window,
`view.*` push its effect into the requesting mesh, and `view.applyLayout` write the
requesting window's template key. `undefined` means that no caller (the agent, CDP, or
main itself) supplied one, and every consumer treats that as the focused window, because
that is where an unaddressed effect would land anyway.

It is applied as a shallow overlay on the context for each execution, and is never
assigned to the shared context. Commands still overlap. The stack serializes mutating
commands over the whole span from the commit flush through `run` to the commit, and leaves
non-mutating commands concurrent, so a non-mutating command can run alongside any other
command. A mutable `context.origin` set before `run` reads correctly until two windows
dispatch at once. The second write then lands while the first command is still awaiting,
and that command's effect goes to the wrong window. The bug is invisible in a
single-window app, and cannot be reproduced by hand in a multi-window app.
`packages/commands/src/tests/origin.test.ts` parks one command inside `run` while another
runs, and asserts both reads.

`origin` is deliberately absent from `CommandRecord`. The journal records what was done to
the project, not which window an author was looking at. Including the window would make
two identical acts diff differently, and windows do not exist on replay. `source` already
carries the distinction that matters: `ui`, `agent`, and `cdp`.

The `story.*` mutators follow the same rule one level down. Each mutator is one authorial
act, so a drag in the branch editor or the coverage timeline produces a single command and
a single `CommandRecord` rather than a stream of commands.

### The `doc.` namespace

`doc.*` lets a surface read and write a workspace document as text. The story editors work
in scenes, lines and shots; a character sheet or a wiki note has no such structure, so the
only interface to it is its bytes. The editors built on top are written up in full at
[`desktop-app-editors-misc.md`](desktop-app-editors-misc.md#wiki).

The rule governs bytes, not documents. A sheet's bytes move only through `doc.*`. A named
field inside one may also be set by a command that round-trips through `@vn/model`'s
`apply*Edit` serializers, which rewrite the key they were given and leave every other byte
— including the author's YAML comments — where it was. `art.setNotes` is the first such
command and `art.promote` the second (it adds one variant to a location's `variants:`
list), and both take the same write path that `vnauthor`'s
`edit_character`/`edit_location` take, so one authorial act still runs through one write
path. `scenes/**` still has exactly one write path, and it is `story.*`.

- **Reads are bounded and text-only.** `doc.read` answers `{ path, text, hash, bytes }`
  for a file under the workspace, and refuses a path outside it, a file that is too large,
  and a file that is not text. It is deliberately not `@vn/bible`'s `query`. The bible is
  reached by ranked excerpt so it never floods a context window, whereas a human editor
  needs the whole file in one read.
- **`doc.write` refuses a save by comparing content, not modification time.** It takes
  `seenHash`, the hash `doc.read` answered with, and refuses when the file on disk no
  longer hashes to it. Comparing mtime would refuse a file that was rewritten identically
  (an undo followed by a save) and would miss a write that landed inside the same second.
  An empty `seenHash` means the caller did not read the file first, which is only allowed
  when the file does not exist.
- **A write to `scenes/**`is refused outright.** A scene has exactly one write
  path,`session.editScene`, and a text overwrite would bypass every rule in
  `@vn/scriptedit`.
- **The document is logged as a digest.** `prop.string(…, { digest: true })` marks a value
  that the `CommandRecord` must not carry verbatim. `formatCommand` and the record store
  `<sha256:bcded73b562b+566>` (twelve hex digits and the byte length), so `commands.jsonl`
  records which commands ran rather than holding a second copy of the author's prose. The
  value the command runs with is untouched. A digested invocation cannot be re-executed,
  and the record should not imply that a whole-file overwrite can be replayed out of a
  log. **The form uses the same flag.** `digest` is carried through `toCatalog` onto
  `CatalogProp`, and `CommandForm` draws a filled digest prop as a summary line
  (`21 KB — the arrangement, as the renderer serialized it`) rather than a textbox. A text
  field over bulk content composed by the caller is unreadable, and a single keystroke can
  corrupt that content.
- **A save reads only the front-matter.** Front-matter that will not parse is refused, and
  so is a save that drops a `type:` tag the file had, because dropping it deletes an
  entity. Front-matter that parses but fails the entity schema is saved, with the
  diagnostic recorded beside it, so that an author mid-thought is not trapped by a
  half-typed field.
- **`doc.create` scaffolds and does not compose.** The command takes a kind and a name and
  writes a sheet to the conventional path for that kind. `newCharacterTemplate` and
  `newLocationDoc` write `characters/<id>/character.md` and `locations/<id>.md`, the same
  scaffolds `vnauthor`'s create tools use. A note is written to `wiki/<id>.md` and holds a
  heading and nothing else, because `wiki/` is free-form and an empty front-matter block
  would be a shape the author has to delete. `newSkillTemplate` writes a skill to
  `.aiagent/skills/<id>/SKILL.md`. The command refuses an existing path rather than
  merging into one.

    The skill kind is the one place where the author's scaffold and the agent's write
    refuse under different conditions, and that difference is deliberate. `create_skill`
    goes through `writeSkill`, which refuses an existing directory, because the directory
    is the unit a skill occupies and the agent may not rewrite one that already holds a
    vetted `run.mjs`. `doc.create` goes through `checkDocWrite` with an empty `seenHash`
    and refuses an existing file. A directory a human put a script in therefore accepts
    the human's `SKILL.md` and rejects the agent's. That ordering is the intended one.

### The `prompt.` namespace

`prompt.*` edits the composition an image is generated from. The prompt itself is still
derived (every builder assembles a `PromptChunk[]` and `renderPrompt` collapses it
byte-identically to the flat string it always produced), so these commands write an
override stored beside the authored input, and a project that runs none of them keeps
every task hash it had. The full statement is in
[`../plans/archive/INDEX.md#chunked-prompts`](../plans/archive/INDEX.md#chunked-prompts).

- **Each asset resolves to one rung.** Every command takes the asset `hash`, and the
  session resolves it to the rung that names the whole picture. A portrait resolves to the
  character, a sheet to the outfit entry, a plate to the variant, and a frame to the shot.
  An override can live in exactly one place, which keeps `prompt.info` and the pane from
  disagreeing.
- **`prompt.info` is the projection that both an agent and the pane read.** It reports the
  derived clauses, what the author did to each, and the single string that gets sent — the
  same `PromptView` the Asset editor draws, so the agent and the pane share one
  description of what a picture was asked for.
- **It costs money, on purpose.** Like `art.setNotes` and unlike a scene edit, an override
  sits in the prompt, so it re-keys exactly the tasks that rung reaches.
  `project.setArtStyle` applies the same rule at its limit, reaching every image task,
  which is why it is the one of these that confirms.
- **A condensation is stored and reused rather than recomputed.** `prompt.condense` stores
  the model's rewrite along with the chunks it condensed. When those chunks move, the
  stored text is still what gets sent, and the pane reports that the chunks have moved.
  `prompt.check` measures a hand-written or condensed prompt against the clauses by word
  overlap and reports the clauses it cannot find, so the reader knows where to look; it
  does not pass a verdict on the prompt.
- **`prompt.clear` removes overrides by part.** It accepts `chunks`, `order`, `custom`,
  `agent` or `all`, and the builders derive whatever remains. `mode` alone is not an
  override. Every mode falls back to the derived chunks when the shape it names is empty,
  so clearing the last edit clears the key rather than leaving an inert `prompt_override:`
  in the author's file.
- **A reference attaches to a clause, not to the prompt.** `prompt.addRef` marks a picture
  as evidence for one sentence, so muting that clause drops its references too. `ref` is
  either an asset hash or a slot address (`plate:cafe/night`). The address is the same
  string the pane prints, so an author can type the address shown on screen.
- **A linked reference stores a hash pin and the slot separately.** The task hashes over
  the pin, so approving a new plate upstream does not re-render the references that point
  at it. Those references are suspended instead. Suspension is transitive, derived by
  walking the graph on read rather than stored as a flag, and `asset.suspended` enumerates
  suspended assets in dependency order. `prompt.repin` clears suspension, and passing
  `regenerate=false` clears it without regenerating.
- **The graph is kept acyclic at write time, over slots rather than hashes.**
  `prompt.addRef`'s precondition refuses a reference that would close a cycle and names
  the whole path. A cycle raises no error; instead the scheduler stops making progress and
  reports nothing.

### Interactions: the gesture surface

A command names one thing the app can do. On the direct-manipulation surfaces, those names
leave out most of the interface. Nothing in `commands.json` says that `story.spliceScene`
is normally reached by dropping a card on a wire, that most wires would refuse that card,
or why they would refuse it.

An interaction names the gesture and offers a query rather than a list:
`targets(state, carried)` returns every candidate marked accept (with the invocation the
drop would run) or refuse (with the sentence the command itself would have given). An
interaction has no write path of its own. Every gesture terminates in a registered
command, and `InteractionRegistry.verify` fails the build if an interaction names a
command that does not exist.

Eight gestures are declared in `apps/desktop/src/shared/interactions.ts`: the branch
editor's `branch.connect`, `branch.splice` and `branch.unwire`, the coverage timeline's
`timeline.cover`, `timeline.create` and `timeline.reorder`, the script's
`script.moveLine`, and the asset pane's `prompt.reorder`. The file sits beside
`branchops.ts` and delegates to `@vn/scriptedit`'s `lineops`, `coverage` and `shotcreate`
modules, and it is shared for the same reason those modules are. `BranchEditor` runs
`branchSplice.targets` to draw its mid-drag verdict overlay, the `Timeline` evaluates
`timelineCover.targets` once per grab for its notice, and `interaction.targets` runs the
same call in main, so an author and an agent are told the same thing about the same drop.

`script.moveLine` was declared and tested with no surface. The layer is worth having on
its own: an agent can ask which insertion points in a scene would reorder anything and get
each one along with the `story.moveLine` call it would run, and could do so before any
drag existed to make it. STUDIO's script column is now the first consumer, and becoming
one required no new decision. The column's targets are insertion points, so there is one
more target than there are lines (`top`, then one after each line). A drop that would
reorder nothing is left out rather than reported as an accept, so the column shows no
insertion rule where a drop would change nothing.

```sh
node scripts/vn-cdp.mjs "interaction.targets(interaction='branch.splice' carried='arrival')"
#  0 of 5 target(s) would accept arrival.
#  refuse · arrival#choice:0 · arrival cannot be spliced into its own edge.
#  refuse · greet#next · arrival already forks into 2 choice(s), and a scene's next is only
#    followed when it has none — the spliced edge would never be taken.
```

The full design (including what is deliberately not an interaction) is in
[`../plans/archive/INDEX.md#interaction-model`](../plans/archive/INDEX.md#interaction-model).

`CommandHost` bundles the app-specific services every command receives:
`{ session: WorkspaceSession; state: SessionStore; ui(effect: UiEffect): void; check(id, props) }`.
`state` holds persisted UI state. It is deliberately not called `session`, because
`session` is already the backend session. `check` queries the stack's own preconditions,
and commands reach it through the host because a command cannot import the stack that runs
it.

Four state types now pass through `targets`, so `interaction.targets` builds the state
each named gesture is judged against. A `timeline.*` gesture is judged against one scene
and takes a `scene` prop. A `prompt.*` gesture is judged against one asset's composition
and takes an `asset` prop. A `script.*` gesture receives every scene as its chunk parses,
because a line id names its own scene and a `scene` prop would be redundant. Every other
gesture receives the branch graph. The registry is untyped in its state
(`InteractionRegistry`, `State = any`) for the same reason. The carried value is always a
string. An interaction with structure encodes it (`arrival__beat1#end`) and parses it in
`targets`, refusing a token that names nothing against the `UNRESOLVED` target.

### Preconditions: asking before acting

An interaction reports whether a drop would work for a gesture. `check` reports whether a
command would work:

```ts
type CheckResult = { ok: true; note: string } | { ok: false; reason: string };
interface Command<M, Host> {
  check?(props: PropsOf<M>, ctx: CommandContext<Host>): Promise<CheckResult>;
}
stack.check(id, props): Promise<{ state: 'accept' | 'refuse' | 'undeclared'; message: string }>
```

There are four rules, and the third state matters most:

1.  1. **Absence maps to `undeclared`, never to `accept`.** Reporting "nobody wrote a
       check" as "would succeed" is the only way the report can be wrong, and it would be
       wrong by default for every command nobody has covered.
2.  2. **A check reports the state at the time it runs.** The workspace can change between
       check and exec, and `run` re-decides each time and is the only authority. `exec`
       does not call `check`.
3.  3. **A check reads and does not write** — each check performs a load and then a pure
       decision, so repeating a check is safe.
4.  4. **Only mutating commands declare one.** A read has nothing to prevent. A test
       asserts the list.

The `story.*` checks run the same pure decision the command runs (`branchops`,
`setCoverage`, `@vn/scriptedit`'s `lineops`), taken against a freshly read graph and then
discarded. A check therefore shows the refusal the command itself would produce, and the
mid-drag overlays follow the same rule. For the nine prose editors this extends past
refusals to cost: a check reports the same storyboard fallout the run reports
(`1 shot(s) lose 3 line(s) of coverage, 1 already rendered`), because both read it off the
same plan. `gate.approve` checks whether the character exists and whether the hash is
among its candidates. An already-approved hash produces a note rather than a refusal,
because re-approving is how an author changes their mind. `pipeline.run` refuses only when
`mock: false` and no key resolves. That condition is certain and is expensive to discover
by running. It reports pending work and the gate as its note, because answering "is
anything plannable" requires planning, which would write.

`checkable` on each catalog entry marks the commands that have a precondition to ask.

```sh
node scripts/vn-cdp.mjs "command.check(invocation=\"story.setNext(scene='arrival')\")"
#  story.setNext: refuse — arrival has no next scene to clear.
node scripts/vn-cdp.mjs --raw "window.vn.check('pipeline.run', {mock: false})"
```

The full design (and why this is not the same function as `targets`) is in
[`../plans/archive/INDEX.md#preconditions-and-timeline-interaction`](../plans/archive/INDEX.md#preconditions-and-timeline-interaction).

---

## Reaching the commands

### From the renderer

These invoke channels go on the existing typed IPC map (`apps/desktop/src/shared/ipc.ts`)
along with one event channel:

```ts
'command:catalog': () => CommandCatalog;
'command:exec':    (r: { id?; props?; dsl?; source? }) => CommandOutcome;
'command:check':   (r: { id; props? }) => CommandCheck;
'command:history': (limit?: number) => CommandRecord[];
'command:undo' / 'command:redo': () => CommandOutcome;
// event:
'command:ui': UiEffect;
```

The pre-existing channels (`gate:approve`, `pipeline:run`, …) still work, so the renderer
can migrate to commands incrementally rather than all at once.

`UiEffect` also carries an `{ type: 'undo'; state; revision }` member, pushed from
`onRecord` after every command. The topbar's undo/redo affordances therefore stay current
whichever caller ran the command, and never poll. `revision` counts undo/redo moves only,
and the shell remounts the room when `revision` changes, because a room does not make
undo/redo writes itself.

While wiring this up, `registerIpc()` gained a typed `handle<C>()` wrapper that registers
against `InvokeChannels`, so a handler's signature must match its declared channel. The
old hand-annotated `ipcMain.handle` calls allowed a mismatch, and some handlers did
diverge.

### From the palette, or from a command's own dialog

The Ctrl+Shift+P palette (`renderer/pathux/chrome/palette.ts`) reads the catalog rather
than a hand-kept list. It fetches `command:catalog` once from the live registry (never
`dist/commands.json`) and lists the entries that match the query. A newly registered
command therefore appears in the palette with no palette edit at all, which is why the
claim at the top of this document ("the palette … reaches the same registry") holds.

Finding a command and filling it in are separate jobs, and only one surface does both. The
palette finds commands. A caller that already knows which command it wants (a menu entry,
the gate bar, or a right-click that needs an argument) calls
`openCommandDialog(id, props)` and gets that command on its own: its title, what it does,
its fields, its verdict, Cancel, and a button labelled with the command. The dialog has no
search box and no list of eighty-odd other commands to scroll past. Both are
`Screen.popup`s inside the path.ux mesh rather than OS windows, and both host the same
`renderer/pathux/commands/commandform.ts`, so every rule below holds in either.

- **The form is generated from `props`.** Each `CatalogProp` becomes a checkbox
  (`boolean`), a path.ux dropdown (`enum`, options from `values`) or a text/number input;
  a list is edited as comma-separated text. `blankProps` seeds the form from each prop's
  `default`, so the submitted values match what `coerceProps` would accept. A command with
  no props runs directly from its row.
- **A `directory` prop gets a Browse… button and can still be typed into.** The button
  `exec`s `workspace.chooseDirectory` (a non-mutating command with no props that returns
  the chosen absolute path, or `Cancelled.`) and writes the result into the field. The
  chooser sits beside the field rather than blocking access to it, and it is a command
  rather than an IPC channel so that CDP and the agent reach the same act.
  `workspace.create` can therefore collect a folder, a title and a checkbox in one form
  rather than requiring a path to be typed.
- **A `multiline` prop gets a plain `<textarea>`, shared across the app.**
  `renderer/pathux/widgets/writingbox.ts` is the one writing surface, and it is
  deliberately not path.ux's `textarea()`. That widget is a `contentEditable` rich-text
  editor with a formatting toolbar and `innerHTML` for a value, so it stores markup where
  a command expects a string. `writingbox.ts` stops its own keydown (as every other text
  surface in the app does), and the report preview draws the same widget.
- **A `string` prop whose values the project already holds gets a dropdown.**
  `FormOptions.choices` is a function of the current values that returns rows per prop
  name, so the rows it offers may depend on the values already filled in. The efforts a
  model supports, for example, depend on the model chosen in the same form. Choices are
  not `enum`, which bakes its `values` into the build-time catalog, and a list of the
  scenes in this project is not part of a command's vocabulary. Each row carries its own
  tooltip, so a reader sees what a choice costs before making it rather than only in the
  verdict afterwards.

    Every form receives one of these lists by default. `renderer/rules/vocabulary.ts` maps
    prop names to what they name: `scene` and `goto` to the project's scenes, `character`
    and `characterId` to its cast, `thread` (and `id`, on the three thread commands alone)
    to its conversations, and `model` and `effort` to what the API takes.
    `renderer/pathux/commands/vocabulary.ts` reads the snapshot behind it when the palette
    or a dialog opens. If a caller supplies its own `choices`, that list is merged over
    the top and takes precedence.

    A prop is only listed when every value the command accepts is in the list: `into` on
    `story.splitScene` names a scene that does not exist yet, so it stays a field. A list
    may be wider than the accepted set (`character` offers the whole cast where
    `story.setOutfit` takes one of the shot's subjects) because the form already draws the
    command's own refusal for the rest. A list of more than twelve rows opens in the
    dropdown's `searchMenuMode`. A value none of the rows carry gets a row of its own
    saying so, since showing the first option instead would report a value the author
    never chose. An empty list draws no row at all, so effort disappears for a model with
    no reasoning setting rather than inviting an unsupported value.

- **A prop that holds an asset shows the gallery beside it.** `hash` and `ref` draw a
  Pick… button that opens path.ux's `pickAssetPopup` over the form, using a snapshot of
  `asset.list` ([`asset-picker.md`](asset-picker.md)). The field stays typeable, as the
  `directory` field does: `ref` also takes a slot address, and a hash can be pasted. This
  popup opens over the form's own popup, and it handles both the press that dismisses it
  and Escape, so neither closes the form beneath it.
- **A toggle does not rebuild the form.** A `boolean` is a `check-x` that carries its own
  state, so flipping it rechecks and redraws nothing else. Rebuilding the form under a
  widget would take away the focus that widget just received.
- **`mutating` is marked `writes`; `confirm` takes a second click.** The main process
  still auto-approves `confirm` for other callers (that half of follow-on 2 is still
  open), but from the palette, `pipeline.run` requires two steps.
- **`checkable` entries show their verdict, re-asked on every keystroke.** The verdict
  comes from `command:check`, so it has the same three states the command declares:
  `accept` and `refuse` render inline (✓ / ✕ with the sentence the command supplies), and
  `undeclared` renders nothing at all, since a command that states no precondition
  supplies no verdict to show. The verdict never gates the run; a refusal surfaces as the
  execution error from the stack, which decides again on its own. The verdict is also
  re-asked after every run, since running a command can change what its own precondition
  evaluates to.
- **The verdict redraws by itself.** The verdict occupies its own strip inside the form,
  because a recheck runs on every keystroke and rebuilding the whole form would tear out
  the field being typed into. A field that survives one character and then vanishes leaves
  the command with no way to take an argument at all.
- **A form opened on a command lands in its first text field.** In the palette, focus
  belongs to the search box only while the author is searching, and a dialog has no search
  box at all. An author who picked the command off a menu means to fill its first field,
  and text typed into a filter instead looks the same as a broken entry.
- **Focus and hover do not navigate to a row.** They only arm the check, so the verdict
  can be read before the click that opens the form or runs the command.
- **Execution runs through `command:exec` with `source: 'ui'`** — the same stack that
  `window.vn.exec` and CDP reach, so provenance, history and undo are identical no matter
  who ran the command. When a `mutating` command lands, the shell re-reads the workspace
  index and remounts the room, exactly as it does for undo, because a room did not make
  those writes itself.

`renderer/rules/catalog.ts` handles filtering, blank values and field coercion, and
`renderer/rules/vocabulary.ts` records which prop takes which list. Both have `tests/`
siblings. `commandform.ts`, `palette.ts` and `dialog.ts` stay thin rendering code.

### From a right-click

The document tree's context menus make the same case as the palette: they are a third view
of the catalog, and the view where `check` does the most work. An entry is an invocation
(a command id and its props) rather than a callback, and the menu resolves it twice:
through `command:check` before it is drawn, and through `command:exec` when it is clicked.
Three bespoke `contextmenu` handlers that call `exec` without checking first would offer
actions the command would refuse.

- **A refused entry stays visible and reports its reason.** path.ux's menu template has no
  per-item disabled state, so a refused entry draws as `⃠ Accept`, and clicking it reports
  the command's own sentence in the message line instead of executing. Hiding the entry
  would leave the author guessing why the option they remember is gone. `check` exists to
  produce that sentence, and the sentence should reach the surface that invoked the
  command.
- **`undeclared` does not grant permission.** A command with no check draws enabled (the
  same three-state contract) but nothing synthesizes an `accept` for it. A missing check
  carries no information, in a menu as anywhere else.
- **Checks are awaited before the menu opens.** `startMenu` is synchronous, so the handler
  gathers every verdict first. Each check is a read-only preview over state main already
  holds. If a check ever becomes slow enough to notice, fix that check rather than opening
  the menu before its verdict arrives.
- An entry needing an argument opens that command's dialog pre-filled, and so does every
  entry marked `confirm: true`. A form is where the author types a command's arguments and
  where the form shows what the command is about to do, and the author has already found
  the command by right-clicking, so they get the one command rather than the finder. Such
  an entry is deliberately not checked, because its props are incomplete by design and a
  check would refuse only over the blank the author is on their way to filling in.

`renderer/pathux/doctree/doctree.ts` holds a pure table of the entries each node offers.
`renderer/pathux/chrome/contextmenu.ts` resolves a verdict to a menu item; it is pure and
testable under node because it imports no `pathux`. `renderer/pathux/chrome/showmenu.ts`
is the half that opens the menu, and it is verified live over CDP as every other surface
is. The tables are in [`document-tree.md`](document-tree.md#right-click-menus).

The menu bar does not work this way. `header.ts` builds the app and View menus with the
bar, synchronously, and half their entries are shell actions rather than commands: Quit,
Split Area, Undo and Plan ⇄ Execute reach no registry, because no registry exists for them
to reach. Those menus therefore run the entry and then report the result, so `exec` states
the refusal after the click instead of showing it beforehand, and the reader gets the same
message one step later. They do keep one rule from the right-click menu. An entry opens
the command's own dialog when the command has something to collect (`workspace.create`'s
folder, title and checkbox) or something to confirm (`pipeline.run`, `upload.pick`), and
runs outright when it has neither (`workspace.pick`, `workspace.reindex`), because an
empty form is friction rather than a safeguard. Command Palette… is the one entry that
opens the finder, since that entry exists to find a command.

### From DevTools or CDP

The preload exposes a second bridge (`window.vn`) over that same IPC:

```js
await vn.catalog();
await vn.exec("view.open(editor='timeline' where='below')"); // DSL form
await vn.exec("gate.approve", { characterId: "aiko", hash: "9e0a1b" }); // id + props form
await vn.check("gate.approve", { characterId: "aiko", hash: "9e0a1b" }); // would it run?
await vn.history(5);
```

It lives in the preload rather than in React so that it exists before the app mounts.
Scripting depends on it being available that early.

**CDP is opt-in in the app, and on by default in the developer launchers.** Setting
`VN_CDP_PORT` makes the app open Chrome's own remote-debugging port, bound to `127.0.0.1`.
The port grants full control of the renderer, so `src/main/index.ts` never opens one
unless asked, and nothing sets the variable in a packaged app. The two ways a developer
starts the app default it to `9222` instead: `scripts/dev.desktop.mjs`

`scripts/vn-cdp.mjs` is the driver. It fetches `/json/list`, picks the page target, and
evaluates against `window.vn`:

```sh
node scripts/vn-cdp.mjs "workspace.index()"
node scripts/vn-cdp.mjs "view.open(editor=play)"   # visibly opens a pane
node scripts/vn-cdp.mjs --catalog
node scripts/vn-cdp.mjs --history 5
node scripts/vn-cdp.mjs --undo                     # and --redo
```

A failed or refused command exits non-zero, so a shell can compose it with other commands.

### From the agent

`CommandSource` includes `'agent'`, so the supporting code is in place. Wiring the
authoring agent's tool loop to the registry is a follow-on and has not shipped.

The agent and the commands share the decisions rather than the transport, and the shared
decisions matter more than the transport does. `vnauthor`'s `edit_scene` tool takes an
`op` named after the `story.*` command it mirrors and calls the same `@vn/scriptedit`
rule, so the agent gets back the same refusal sentence the author reads mid-drag, and the
storyboard fallout is accounted for once, in one place. `set_outfit` uses the same
arrangement over `story.setSceneOutfit` / `story.setOut

---

## The catalog

`toCatalog(registry, source, interactions?)` projects the registry into a serializable
shape. The optional third argument adds an `interactions` array, which holds everything
about a gesture except `targets`, because `targets` is meaningful only against live state.
The array is additive, so a consumer that knows only about commands reads the same file
unchanged. Each command entry carries the metadata, a `props` array, a ready-to-paste
`usage` template (`gate.approve(characterId='' hash='')`, built by formatting
type-appropriate placeholders), and a JSON Schema for the props object.

```jsonc
{
    "id"       : "view.focus",
    "title"    : "Focus an editor",
    "mutating" : false,
    "confirm"  : false,
    "undoable" : false,
    "checkable": false,
    "props": [
        {
            "name"    : "editor",
            "kind"    : "enum",
            "required": true,
            "values"  : ["branches", "script", "…"],
        },
    ],
    "usage"    : "view.focus(editor='branches')",
    "schema": {
        "type"                : "object",
        "properties": {
            "editor": {
                "type"       : "string",
                "enum"       : ["branches", "script", "…"],
                "description": "…",
            },
        },
        "required"            : ["editor"],
        "additionalProperties": false,
    },
}
```

`pnpm build` writes it to `apps/desktop/dist/commands.json` via
`scripts/gen-command-catalog.mjs`, which esbuild-bundles a tiny `catalog-entry.ts` and
`require`s the result. That entry point is kept separate from `commands/index.ts` so the
generator never pulls in Electron. Keeping Electron out also lets jest construct the
registry in a plain Node process, because the command modules reach the session only
through a type-only import.

The `command:catalog` IPC channel serves the live registry rather than the file, so the
app never reads a stale catalog. The file exists for external tooling, and a test asserts
the two are equal.

Both go through one function, `catalogOf(registry)`. They did not at first. The channel
called `toCatalog(registry, '@vn/desktop')` and the generator called
`toCatalog(…, desktopInteractions)`, so `window.vn.catalog()` claimed the app had no
gestures while `commands.json` listed five. The equality test could not catch the
mismatch, because it compared the file against the generator's projection rather than the
channel's. Two call sites building the same value caused the bug, and the fix was to have
one.

The `schema` field is the repo's first JSON-Schema emission that does not go through zod.
`NativeAgentBackend` currently advertises a hand-written `LOOSE_PARAMS`. Feeding it these
schemas instead is an obvious follow-on.

---

## Testing

- `pnpm exec jest --selectProjects @vn/commands` covers DSL parse/format round-trip and
  error columns, prop coercion and defaults, required-missing and unknown-key rejection,
  stack record contents (seq order, `gitHead` populated, error records), `check`'s three
  states and its refusal to let a crashed check read as the command's own reason, catalog
  schema shape, undo candidate selection and its refusals, and the journal itself against
  a real temp repo. The journal's whole job is git behaviour, so mocking git would test
  nothing.
- `pnpm exec jest --selectProjects @vn/desktop` — checks the registry's namespaces and
  ids, that every prop carries a description, that the mutating set is exactly the
  expected commands, that only the document writers are undoable and that every undoable
  command mutates, that the commands declaring a precondition are exactly the mutators
  (minus `agent.run`, whose answer comes from a model), and that the generated
  `commands.json` deep-equals the live registry (skipped when the file hasn't been
  generated).

---

## Follow-ons

The following items are deliberately out of scope for v1, in rough order of value:

1. ~~**Make `renderer/app/Palette.tsx` data-driven** off `command:catalog`.~~ **Shipped**
   as step 7 of
   [`../plans/archive/INDEX.md#allocated-line-ids`](../plans/archive/INDEX.md#allocated-line-ids)
   — see [From the palette](#from-the-palette-or-from-a-commands-own-dialog).
2.  2. **Route `confirm` through the renderer.** The palette now requires a second click,
       but the main process still auto-approves for every other caller, so
       `pipeline.run`'s `confirm: true` does not stop the agent or CDP.
3. **Feed `CatalogEntry.schema` to `NativeAgentBackend`** in place of `LOOSE_PARAMS`.
4.  4. **Undoable `gate.approve`**, which needs `manifest.json` re-pointed alongside the
       document restore. Undo left this straddling case out.
