# The command system

<!-- toc -->

- [Why it exists](#why-it-exists)
- [Two halves](#two-halves)
- [Properties are declarative specs, not zod](#properties-are-declarative-specs-not-zod)
  * [`coerceProps` is the single validation authority](#coerceprops-is-the-single-validation-authority)
- [The DSL](#the-dsl)
- [The stack](#the-stack)
  * [`CommandRecord`](#commandrecord)
  * [Undo is opt-in, and rests on shadow snapshots](#undo-is-opt-in-and-rests-on-shadow-snapshots)
- [The registered commands](#the-registered-commands)
  * [Interactions: the gesture surface](#interactions-the-gesture-surface)
  * [Preconditions: asking before acting](#preconditions-asking-before-acting)
- [Reaching the commands](#reaching-the-commands)
  * [From the renderer](#from-the-renderer)
  * [From the palette](#from-the-palette)
  * [From DevTools or CDP](#from-devtools-or-cdp)
  * [From the agent](#from-the-agent)
- [The catalog](#the-catalog)
- [Testing](#testing)
- [Follow-ons](#follow-ons)

<!-- tocstop -->

Every action the desktop shell can take is a **registered command**: a named, described,
typed shim over a function that already exists. The palette, the menu bar, the authoring
agent, and an external CDP client all reach the same registry through the same execution
path, and every execution is recorded with the document repo's git HEAD.

This document describes what shipped. The implementation plan — including the deviations
from it and the follow-ons deliberately left out — is
[`plans/command-system.md`](plans/command-system.md). Undo/redo landed later, on top of this;
the strategy survey is [`gitUndoOptions.md`](gitUndoOptions.md) and the plan that carried out
its recommendation is [`plans/command-undo-redo.md`](plans/command-undo-redo.md).

---

## Why it exists

Before this, every desktop action was a bespoke IPC channel hand-registered in
`apps/desktop/src/main/index.ts` and hand-wired to a React handler: `gate:approve`,
`pipeline:run`, `agent:setMode`. That shape has no room for discovery (the `/` palette was a
static mockup), no history, no provenance tying an action to the state of the repo when it
ran, and no way to drive the app from outside for scripting or debugging.

The command system replaces that with **one registry, one execution path, one catalog**.

---

## Two halves

The split matters, and it is enforced by the boundaries lint rule.

**`packages/commands` (`@vn/commands`) is the framework.** It holds prop specs, the registry,
the DSL, the execution stack, and the catalog projection. It is domain-agnostic — it knows
nothing about visual novels — and depends only on `types`, `util`, and `git` (for the `Git`
type it reads HEAD through).

**`apps/desktop/src/main/commands/` holds the actual commands.** They need the
`WorkspaceSession`, and `apps/desktop` is already the sanctioned join point above both the
pipeline and authoring branches. Each definition is a thin wrapper over a session method that
existed already, so registering a command moved no logic.

`@vn/commands` reads as a sibling of `@vn/authoring`'s `Tool` registry on purpose. The two
differ in what they serve: a `Tool` is advertised to an LLM and gated by the agent's
plan/execute mode; a `Command` is the app's own vocabulary and is recorded on a stack with
provenance. They stay separate because their gating rules differ.

---

## Properties are declarative specs, not zod

```ts
export interface Prop<T extends PropValue = PropValue, Req extends boolean = boolean> {
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'string[]';
  description: string;
  required: Req;
  default?: T;
  values?: readonly string[]; // enum only
  min?: number; // number only
  max?: number;
}
```

A command's props have to serialize into the build-time JSON catalog, coerce the loose values
arriving from the DSL and CDP, and (later) drive a properties panel. One introspectable spec
serves all three. A zod schema serves none of them without a second hand-rolled walker — the
repo is on zod 3, so there is no `z.toJSONSchema`, and `@vn/authoring` already had to
hand-roll `describeToolParams` for exactly this reason.

Builders cover the five kinds — `prop.string`, `prop.number`, `prop.boolean`, `prop.oneOf`,
`prop.stringList`. Each is overloaded so that **passing a `default` narrows `required` to
`false`**:

```ts
props: {
  characterId: prop.string('the character to approve'),                 // required
  mock: prop.boolean('dry run: preview only', { default: true }),       // optional
  mode: prop.oneOf(['plan', 'execute'] as const, 'the mode to switch to'),
}
```

`PropsOf<M>` maps the spec to the object `run` receives, and **every key is present**:
`coerceProps` has already applied the defaults, so optionality belongs to the *raw input*, not
to the runtime object. `required` still matters — the catalog reads it off the spec to build
the JSON-Schema `required` list — just not at the type level.

### `coerceProps` is the single validation authority

```ts
coerceProps(specs, raw): { ok: true; value } | { ok: false; errors: string[] }
```

It applies defaults, coerces loose values (`'42'` → `42`, `'true'` → `true`, a bare string →
a one-element `string[]`), range-checks numbers against `min`/`max`, rejects out-of-set enum
values, and **rejects unknown keys**. Nothing else validates props, which mirrors the role
`Agent.dispatch`'s `safeParse` plays for authoring tools.

---

## The DSL

```
namespace.command(prop1='bleh' prop2=1)
```

A hand-rolled tokenizer and recursive-descent parser (`src/dsl.ts`) — small enough to keep
pure and exhaustively testable, and errors carry a **column** so the palette can point at the
offending character.

```
invocation := path '(' args? ')'
path       := ident ('.' ident)+          // at least two segments
args       := arg ((',' | ws) arg)*       // commas optional, whitespace suffices
arg        := ident '=' value
value      := quoted | number | 'true' | 'false' | array | bareword
```

Two deliberate choices:

- **Barewords parse as strings**, so `agent.setMode(mode=execute)` reads naturally. `true` and
  `false` are the only words that mean themselves; `coerceProps` sorts out the rest.
- **Arrays are string-only** (`[a, 'b c']`) — the one list kind commands take.

`formatCommand(id, props)` is the inverse, used for the history display and the `invocation`
field of every record. A round-trip test pins `parseCommand(formatCommand(x)) ≡ x`.

Command ids are `/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/` — dotted, at least two segments,
each starting lowercase. camelCase within a segment is allowed so ids can mirror the IPC
channels they wrap (`agent.setMode`). The registry throws on a malformed or duplicate id;
both are authoring bugs, not runtime states.

---

## The stack

`CommandStack` is the one execution path. Its order deliberately mirrors `Agent.dispatch`:

1. **Resolve** the id in the registry → `unknown command "…"` if absent.
2. **Coerce and validate** props → `invalid props for "…": …` listing every error.
3. **Confirm**, if the command is flagged `confirm: true`. If no gate is wired into the
   context, the command **refuses rather than assuming consent** — the same rule tools follow.
4. **Capture git state** — `gitHead` and `gitDirty`.
5. **Run**, then **record**.

A command that throws still produces a record, with `status: 'error'` and the message. `exec`
never throws for command-level failure; it returns a `CommandOutcome` discriminated on `ok`.

Git state is **provenance, not control flow**: a project need not be a repo, so any failure
reading it degrades to `{ head: null, dirty: false }` rather than failing the command.

### `CommandRecord`

```ts
interface CommandRecord {
  seq: number; // total order within the session
  id: string;
  props: Record<string, PropValue>;
  invocation: string; // the DSL rendering — a copy-pasteable repro line
  source: 'ui' | 'menu' | 'dsl' | 'cdp' | 'agent';
  mutating: boolean;
  gitHead: string | null; // document-repo HEAD at exec time; null outside a repo
  gitDirty: boolean; // whether the worktree was dirty when it ran
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'error';
  message: string;
  written?: string[]; // workspace-relative paths the command wrote
  error?: string;
  undo?: { pre: string; post: string; changed: boolean }; // shadow snapshots; absent ⇒ not an undo point
  stack?: 'undo' | 'redo'; // set on the stack's own entries, which are history, not undo points
}
```

`onRecord` is a hook rather than a hardcoded write. The desktop app wires it to `appendJsonl`
at `vngen/state/commands.jsonl` — alongside the pipeline's own `tasks.jsonl`, and for the same
reason: an append-only log that can be replayed and diffed.

### Undo is opt-in, and rests on shadow snapshots

v1 shipped undo-less on purpose — a half-working undo on an author's only copy of their
screenplay is worse than none. It landed once the story editors made destructive edits
reachable from a *gesture*. The mechanism is
[`gitUndoOptions.md`](gitUndoOptions.md) §8: **shadow snapshots** of the document tree, **split
by data class**, and **refuse rather than guess** when the repo moved. Full write-up:
[`plans/command-undo-redo.md`](plans/command-undo-redo.md).

- **Opt-in per command.** `Command.undoable` widened from `?: false` to `?: boolean`, and only
  the fifteen `story.*` document mutators set it — the six branch/coverage ones it shipped for, plus
  the nine prose edits. A command whose writes are generated output, or that straddles both classes,
  stays out — see the table below.
- **Bracketing.** With an `UndoJournal` wired, the stack captures the worktree either side of
  an undoable command into detached commits parked under `refs/vn/undo/<seq>/{pre,post}`. HEAD
  never moves and the index is never touched. Snapshots are scoped to the document class
  (`['.', ':(exclude)vngen/build', ':(exclude)vngen/state']`), which is both why a `pipeline.run`
  between two edits is not drift and why hashing stays sub-second on a 100 MB workspace.
- **`changed` is measured, not claimed.** `undo.changed` compares the two trees. `written` is
  what a command *said* it wrote; two equal tree shas are proof. A `changed: false` record is
  walked past, so a no-op edit never becomes the undo point.
- **Drift refuses.** Undo snapshots the worktree first; if that tree isn't the candidate's
  `post` tree, something changed since the command ran and undo declines by name rather than
  discarding it.
- **Redo restores the post state**, never replays `invocation` — a replay is a *re-run*.
- **A stack without a journal behaves exactly as before**: `undo()` / `.redo()` refuse.

Undo and redo each append their own `CommandRecord` tagged `stack`, so `commands.jsonl` does
not lie about what touched the worktree.

---

## The registered commands

Thirty-seven, in eight namespaces. Twenty-one are `mutating`; twenty declare a precondition;
fifteen are undoable; one asks for confirmation.

| Command                        | Props                             | Notes                                                     |
| ------------------------------ | --------------------------------- | --------------------------------------------------------- |
| `command.check`                | `invocation`                      | Would that invocation run? See [Preconditions](#preconditions-asking-before-acting). |
| `gate.candidates`              | `characterId`                     | Pending portrait candidates for one character.            |
| `gate.approve` ✍ ✓             | `characterId`, `hash`             | Flips `character.md`; writes the approved PNG + manifest.  |
| `pipeline.status`              | —                                 | Task counts, gate-pending characters, gate-blocked state.  |
| `pipeline.run` ✍ ⚠ ✓          | `mock` (default `true`)           | The only `confirm: true` command — it spends money.        |
| `story.play`                   | —                                 | Build the playable in memory; writes nothing.              |
| `story.export` ✍ ✓             | —                                 | Write `vngen/build/story.play.json` (`vngen export`).      |
| `story.screenplay` ✍ ✓         | `clean` (default `false`)         | Project the scenes back to one Fountain file at the project root (`vngen screenplay`). `clean` drops the `[[…]]` markers, which makes it one-way. |
| `story.graph`                  | —                                 | Scenes + branch edges for the editor; reachability marked. |
| `story.coverage`               | `scene`                           | One scene's lines + persisted shots — the timeline's input. |
| `story.setChoice` ✍ ↺ ✓        | `scene`, `goto`, `label`, `index` (default `-1`) | `-1` appends. Rewrites one `[[choice:]]` marker. |
| `story.removeChoice` ✍ ↺ ✓     | `scene`, `index`                  | Deletes the marker line; the prose is untouched.           |
| `story.setNext` ✍ ↺ ✓          | `scene`, `goto` (default `''`)    | Empty `goto` clears the `[[next:]]` marker.                |
| `story.spliceScene` ✍ ↺ ✓      | `scene`, `from`, `edge` (default `-1`) | `A→B` becomes `A→scene→B`, as one two-scene patch.    |
| `story.setCoverage` ✍ ↺ ✓      | `scene`, `shot`, `lines` (default `''`) | Comma-separated line ids; claimed lines leave every other shot. |
| `story.assignLineIds` ✍ ↺ ✓    | `scene` (default `''`)            | Writes allocated ids down as `[[line:]]` marks; empty `scene` means all. |
| `story.setLineText` ✍ ↺ ✓      | `line`, `text`                    | Retype one line. Says how many rendered shots now illustrate the old prose. |
| `story.insertLine` ✍ ↺ ✓       | `scene`, `text`, `after` (default `''`), `kind` (default `dialogue`), `speaker` (default `''`) | Empty `after` means the top of the scene; the id is allocated, not positional. |
| `story.deleteLine` ✍ ↺ ✓       | `line`                            | A shot left covering nothing is **kept** — deleting paid-for art is the author's call. |
| `story.moveLine` ✍ ↺ ✓         | `line`, `after` (default `''`)    | Reorder within the scene. What `script.moveLine` commits.  |
| `story.setSpeaker` ✍ ↺ ✓       | `line`, `speaker` (default `''`)  | Empty `speaker` makes the line narration.                  |
| `story.newScene` ✍ ↺ ✓         | `scene`, `heading`                | A `scenes/<id>.md` with a heading and no lines; nothing points at it yet. |
| `story.deleteScene` ✍ ↺ ✓      | `scene`                           | Refuses while anything still points at it, naming what.    |
| `story.splitScene` ✍ ↺ ✓       | `scene`, `at`, `into`             | `at` starts the second half; shots follow their lines, keeping their ids. |
| `story.mergeScene` ✍ ↺ ✓       | `scene`, `into`                   | Only across a `next` boundary; `scene`'s file and storyboard are removed. |
| `agent.run` ✍                  | `input`                           | One agent turn. Mutating: a turn in execute mode writes.   |
| `agent.setMode`                | `mode` (`plan` \| `execute`)      |                                                            |
| `agent.setModel`               | `modelId`                         | Hot-swaps the text model, preserving conversation state.   |
| `agent.clear`                  | —                                 | Resets the conversation, back to plan mode.                |
| `interaction.list`             | —                                 | The gestures the app offers — see below.                   |
| `interaction.targets`          | `interaction`, `carried`, `scene`        | Every target of a gesture, accepted or refused with why.   |
| `workspace.index`              | —                                 | Characters, locations, screenplay files, diagnostics.      |
| `workspace.import` ✍ ✓         | —                                 | Convert `screenplay/*.fountain` into `scenes/<id>.md` chunks (`vngen import`). Refuses over existing chunks; the original is moved aside. |
| `view.room`                    | `name` (`studio`\|`floor`\|`play`) | Switches the shell's room.                                |
| `view.mode`                    | `room`, `mode`                    | A mode within a room — STUDIO `convo`\|`branches`\|`script`, FLOOR `list`\|`graph`\|`timeline`. |
| `view.palette`                 | `open` (default `true`)           | Opens or closes the command palette.                       |
| `view.panelSize`               | `id`, `width` (80–1200)           | Saved width of a resizable panel; persisted, not an effect. |

✍ mutating ⚠ confirm ↺ undoable ✓ declares a precondition

**Only the `story.*` document mutators are undoable**, because undo restores a snapshot of the
document tree. `gate.approve` straddles both data classes — undoing `character.md` would leave
`manifest.json` still marking the asset `accepted` — `story.export`, `story.screenplay` and
`pipeline.run` write only generated output, and `agent.run` owns its own commits, one per approved
plan. `workspace.import` restructures the whole worktree, which is what a shadow snapshot is worst
at, and the `<name>.fountain.imported` it leaves behind is a reversal the author can perform. The
reasoning is in [`plans/command-undo-redo.md`](plans/command-undo-redo.md).

**`view.*` commands run in the main process** and push a `command:ui` effect that the renderer
applies (`setRoom`, `setPaletteOpen`, `setStudioMode`, `setFloorMode`). The alternative — a
second, renderer-side registry — would be one more thing to keep in sync, and CDP could not
reach it.

`Room` stays a three-value union rather than growing into a mixed list of rooms and modes:
an editor is a mode *within* a room, so it gets `view.mode(room, mode)` and a
`{ type: 'mode' }` effect. Which modes a room *has* is a pairing of two props, which the spec
layer can't express — `prop.oneOf` can only say "one of these six" — so `run` checks the pair
and **refuses by throwing** (`STUDIO has no "graph" mode — try convo or branches or script.`), and the
`UiEffect` mode member is split per room so the renderer's handler is exhaustive over the right
set. The `story.*` mutators are the same discipline one level down —
each is one authorial act, so a drag in the branch editor or the coverage timeline is one
command and one `CommandRecord`, never a stream of them.

`view.panelSize` is the exception that needs no effect: it writes to the desktop session
store, and the store broadcasts its own `session:changed`, which is what the renderer's
`usePanelWidth` already listens for. Dragging a panel writes through the same store but
_not_ through the command stack, so `commands.jsonl` doesn't collect a record per drag.

### Interactions: the gesture surface

A command answers _what can this app do_. On the direct-manipulation surfaces that leaves out
most of the interface — nothing in `commands.json` says that `story.spliceScene` is normally
reached by dropping a card on a wire, that most wires would refuse that card, or why.

An **interaction** names the gesture and, crucially, offers a **query** rather than a list:
`targets(state, carried)` returns every candidate marked accept (with the invocation the drop
would run) or refuse (with the sentence the command itself would have given). It has no write
path of its own — every gesture terminates in a registered command, and
`InteractionRegistry.verify` fails the build if it names one that does not exist.

The five gestures — the branch editor's `branch.connect`, `branch.splice` and `branch.unwire`, the
coverage timeline's `timeline.cover`, and the script's `script.moveLine` — are declared in
`apps/desktop/src/shared/interactions.ts`, beside `branchops.ts`/`coverage.ts` (and delegating to
`@vn/scriptedit`'s `lineops`) for the same reason those are shared: `BranchEditor` runs
`branchSplice.targets` to draw its mid-drag verdict overlay, the `Timeline` evaluates
`timelineCover.targets` once per grab for its notice, and
`interaction.targets` runs the same call in main — so an author and an agent cannot be told
different things about the same drop.

`script.moveLine` was declared and tested with **no surface at all**, and that is the layer earning
its keep: an agent could ask which insertion points in a scene would reorder anything, and get each
one with the `story.moveLine` it would run, before any drag existed to make it. STUDIO's script
column is now its first consumer and needed no new decision to become one. Its targets are insertion
points, so there is one more of them than there are lines — `top`, then "after each line" — and a
drop that would reorder nothing is left out rather than reported as an accept, which is what lets
the column show no insertion rule at all where a drop would change nothing.

```sh
node scripts/vn-cdp.mjs "interaction.targets(interaction='branch.splice' carried='arrival')"
#  0 of 5 target(s) would accept arrival.
#  refuse · arrival#choice:0 · arrival cannot be spliced into its own edge.
#  refuse · greet#next · arrival already forks into 2 choice(s), and a scene's next is only
#    followed when it has none — the spliced edge would never be taken.
```

Full design, including what deliberately is _not_ an interaction:
[`plans/interaction-model.md`](plans/interaction-model.md).

`CommandHost` is the app-specific service bundle every command receives:
`{ session: WorkspaceSession; state: SessionStore; ui(effect: UiEffect): void; check(id, props) }`.
`state` is persisted UI state — deliberately not called `session`, which is already the backend
one; `check` is the stack's own precondition query, reached through the host because a command
cannot import the stack that runs it.

Three state types now pass through `targets`, so `interaction.targets` builds the state the named
gesture wants: a `timeline.*` gesture is judged against one scene and takes a `scene` prop, a
`script.*` gesture gets every scene as its chunk parses (a line id names its own scene, so a `scene`
prop would be a second answer to the same question), everything else gets the branch graph. The
registry is untyped in its state
(`InteractionRegistry`, `State = any`) for the same reason, and the carried value is **always a
string** — an interaction with structure encodes it (`arrival__beat1#end`) and parses it in
`targets`, refusing a token that names nothing against the `UNRESOLVED` target.

### Preconditions: asking before acting

An interaction answers "would this drop work" for a gesture. `check` answers it for a command:

```ts
type CheckResult = { ok: true; note: string } | { ok: false; reason: string };
interface Command<M, Host> {
  check?(props: PropsOf<M>, ctx: CommandContext<Host>): Promise<CheckResult>;
}
stack.check(id, props): Promise<{ state: 'accept' | 'refuse' | 'undeclared'; message: string }>
```

Four rules, and the third state is the load-bearing one:

1. **Absence is `undeclared`, never `accept`.** Collapsing "nobody wrote a check" into "would
   succeed" is the one way this can lie, and it would lie by default on every command nobody
   got to.
2. **A check is a report about now.** The workspace can move between check and exec; `run`
   re-decides and stays the only authority. Nothing calls `check` on the way into `exec`.
3. **A check reads and does not write** — each is a load plus a pure decision, so asking is free.
4. **Only mutating commands declare one.** A read has nothing to prevent. A test pins the list.

The `story.*` checks are the *same* pure decision the command runs (`branchops`, `setCoverage`,
`@vn/scriptedit`'s `lineops`), taken against a freshly read graph and discarded — so the refusal you
are shown is the refusal that would happen, the same honesty rule the mid-drag overlays follow. For
the nine prose editors that extends past refusals to the *cost*: a check reports the same storyboard
fallout the run reports (`1 shot(s) lose 3 line(s) of coverage, 1 already rendered`), because both
read it off the same plan. `gate.approve` asks
whether the character exists and the hash is among its candidates (already-approved is a note,
not a refusal: re-approving is how an author changes their mind). `pipeline.run` refuses only
when `mock: false` and no key resolves — the half that is certain and expensive to discover by
running — and reports pending work and the gate as its note, because "is anything plannable"
cannot be answered without planning, which would write.

`checkable` on each catalog entry says which commands have a precondition to ask.

```sh
node scripts/vn-cdp.mjs "command.check(invocation=\"story.setNext(scene='arrival')\")"
#  story.setNext: refuse — arrival has no next scene to clear.
node scripts/vn-cdp.mjs --raw "window.vn.check('pipeline.run', {mock: false})"
```

Full design, and why this is not the same function as `targets`:
[`plans/preconditions-and-timeline-interaction.md`](plans/preconditions-and-timeline-interaction.md).

---

## Reaching the commands

### From the renderer

Invoke channels on the existing typed IPC map (`apps/desktop/src/shared/ipc.ts`), plus one
event channel:

```ts
'command:catalog': () => CommandCatalog;
'command:exec':    (r: { id?; props?; dsl?; source? }) => CommandOutcome;
'command:check':   (r: { id; props? }) => CommandCheck;
'command:history': (limit?: number) => CommandRecord[];
'command:undo' / 'command:redo': () => CommandOutcome;
// event:
'command:ui': UiEffect;
```

The pre-existing channels (`gate:approve`, `pipeline:run`, …) still work, so the renderer can
migrate to commands incrementally rather than in one cut.

`UiEffect` also carries an `{ type: 'undo'; state; revision }` member, pushed from `onRecord`
after **every** command — so the topbar's undo/redo affordances stay honest whoever ran it, with
no polling. `revision` counts undo/redo moves only; the shell remounts the room on it, since
those are the writes a room did not make itself.

While wiring this up, `registerIpc()` gained a typed `handle<C>()` wrapper that registers
against `InvokeChannels`, so a handler can no longer drift from its declared signature — the
old hand-annotated `ipcMain.handle` calls could and did.

### From the palette

The `/` palette (`renderer/app/Palette.tsx`) is a **view of the catalog**, not a hand-kept list:
it fetches `command:catalog` once — the live registry, never `dist/commands.json` — and renders a
`COMMANDS` group under the existing skills and session rows. A newly registered command therefore
appears in the palette with no palette edit at all, which is what makes the claim at the top of
this document ("the palette … reaches the same registry") true rather than aspirational.

- **The form is generated from `props`.** Each `CatalogProp` becomes a checkbox (`boolean`), a
  `<select>` (`enum`, options from `values`) or a text/number input; lists edit as comma-separated
  text. `blankProps` seeds it from each prop's `default`, so what is submitted matches what
  `coerceProps` would accept. A command with no props runs straight from its row.
- **`mutating` is marked `writes`; `confirm` takes a second click.** The main process still
  auto-approves `confirm` for other callers — that half of follow-on 2 is still open — but from
  the palette, `pipeline.run` is a real two-step.
- **`checkable` entries show their verdict, re-asked on every keystroke.** The answer is
  `command:check`, so it is the same three states the command declares: `accept` and `refuse`
  render inline (✓ / ✕ with the sentence the command itself would give), and **`undeclared`
  renders as nothing at all** — a command that states no precondition has not said yes. The
  verdict never gates the run; a refusal surfaces as the execution error, from a stack that
  re-decided for itself. It is also re-asked after every run, since a command that just ran
  changed what its own precondition would now answer.
- **Highlighting a row is not navigating to it.** Focus and hover only arm the check, so the
  verdict is there to read before the click that opens the form or runs the command.
- **Execution is `command:exec` with `source: 'ui'`** — the same stack `window.vn.exec` and CDP
  reach, so provenance, history and undo are identical whoever ran it. When a `mutating` command
  lands, the shell re-reads the workspace index and remounts the room, exactly as it does for
  undo: those are writes a room did not make itself.

The pure half — filtering, blank values, field coercion — is `renderer/app/catalog.ts` with a
`tests/` sibling; `Palette.tsx` stays thin rendering.

### From DevTools or CDP

The preload exposes a second bridge, `window.vn`, over that same IPC:

```js
await vn.catalog();
await vn.exec("view.room(name='floor')"); // DSL form
await vn.exec('gate.approve', { characterId: 'aiko', hash: '9e0a1b' }); // id + props form
await vn.check('gate.approve', { characterId: 'aiko', hash: '9e0a1b' }); // would it run?
await vn.history(5);
```

It lives in the preload rather than in React so that it exists before the app mounts, which
matters for scripting.

**CDP is opt-in and off by default.** Setting `VN_CDP_PORT` makes the app open Chrome's own
remote-debugging port, bound to `127.0.0.1`. The port grants full control of the renderer, so
it is never on unless asked for; `scripts/dev.desktop.mjs` defaults it to `9222` **for the dev
loop only**. Using Chrome's debugger rather than a new socket means there is no second, less
guarded entry point to secure, and Playwright/Puppeteer/`curl` work out of the box.

`scripts/vn-cdp.mjs` is the driver — it fetches `/json/list`, picks the page target, and
evaluates against `window.vn`:

```sh
node scripts/vn-cdp.mjs "workspace.index()"
node scripts/vn-cdp.mjs "view.room(name='play')"   # visibly switches rooms
node scripts/vn-cdp.mjs --catalog
node scripts/vn-cdp.mjs --history 5
node scripts/vn-cdp.mjs --undo                     # and --redo
```

A failed or refused command exits non-zero, so it composes in a shell.

### From the agent

`CommandSource` includes `'agent'`; the plumbing is in place, but wiring the authoring agent's
tool loop to the registry is a follow-on, not shipped.

What _is_ shipped is the thing that matters more: the agent and the commands share the **decisions**
rather than the transport. `vnauthor`'s `edit_scene` tool takes an `op` named after the `story.*`
command it mirrors and calls the same `@vn/scriptedit` rule, so a refusal the author reads mid-drag
is the sentence the agent gets back, and the storyboard fallout is accounted for once, in one place.
Routing the tool loop through the registry later would buy provenance in `commands.jsonl` — not
different behaviour. See [`vnauthor.md`](vnauthor.md#tools).

---

## The catalog

`toCatalog(registry, source, interactions?)` projects the registry into a serializable shape.
The optional third argument adds an `interactions` array — everything about a gesture except
`targets`, which only means anything against live state. It is additive, so a consumer that
knows only about commands reads the same file unchanged. Per command:
the metadata, a `props` array, a ready-to-paste `usage` template
(`gate.approve(characterId='' hash='')`, built by formatting type-appropriate placeholders),
and a **JSON Schema** for the props object.

```jsonc
{
  "id": "view.room",
  "title": "Switch room",
  "mutating": false,
  "confirm": false,
  "undoable": false,
  "checkable": false,
  "props": [{ "name": "name", "kind": "enum", "required": true, "values": ["studio", "floor", "play"] }],
  "usage": "view.room(name='studio')",
  "schema": {
    "type": "object",
    "properties": { "name": { "type": "string", "enum": ["studio", "floor", "play"], "description": "…" } },
    "required": ["name"],
    "additionalProperties": false,
  },
}
```

`pnpm build` writes it to `apps/desktop/dist/commands.json` via
`scripts/gen-command-catalog.mjs`, which esbuild-bundles a tiny `catalog-entry.ts` and
`require`s the result. That entry point is kept separate from `commands/index.ts` so the
generator never pulls in Electron — the same property that lets jest construct the registry in
a plain Node process, since the command modules reach the session only through a **type-only**
import.

**The `command:catalog` IPC channel serves the live registry, never the file**, so the app
itself cannot be misled by a stale one. The file exists for external tooling, and a test
asserts the two are equal.

Both go through **one** function, `catalogOf(registry)`. They didn't at first — the channel called
`toCatalog(registry, '@vn/desktop')` and the generator called `toCatalog(…, desktopInteractions)`, so
`window.vn.catalog()` claimed the app had no gestures while `commands.json` listed five. The
equality test could not catch it, because it compared the file against the *generator's* projection
rather than the channel's. Two call sites building the same value is the shape of that bug; the fix
was to have one.

The `schema` field is incidentally the repo's first zod-free JSON-Schema emission.
`NativeAgentBackend` currently advertises a hand-written `LOOSE_PARAMS`; feeding it these
schemas instead is an obvious follow-on.

---

## Testing

- `pnpm exec jest --selectProjects @vn/commands` — DSL parse/format round-trip and error
  columns, prop coercion and defaults, required-missing and unknown-key rejection, stack
  record contents (seq order, `gitHead` populated, error records), `check`'s three states and
  its refusal to let a crashed check read as the command's own reason, catalog schema shape, undo
  candidate selection and its refusals, and the journal itself against a **real** temp repo —
  its whole job is git behaviour, so mocking git would test nothing.
- `pnpm exec jest --selectProjects @vn/desktop` — the registry's namespaces and ids, that
  every prop carries a description, that the mutating set is exactly the expected commands,
  that only the document writers are undoable and nothing undoable is non-mutating, that the
  commands declaring a precondition are exactly the mutators (minus `agent.run`, whose answer
  is a model's), and that the generated `commands.json` deep-equals the live registry (skipped
  when the file hasn't been generated).

---

## Follow-ons

Deliberately out of scope for v1, in rough order of value:

1. ~~**Make `renderer/app/Palette.tsx` data-driven** off `command:catalog`.~~ **Shipped** as
   step 7 of [`plans/allocated-line-ids.md`](plans/allocated-line-ids.md) — see
   [From the palette](#from-the-palette).
2. **Route `confirm` through the renderer.** The palette now takes a second click, but the main
   process still auto-approves for every other caller, so `pipeline.run`'s `confirm: true` is not
   a gate for the agent or CDP.
3. **Feed `CatalogEntry.schema` to `NativeAgentBackend`** in place of `LOOSE_PARAMS`.
4. **Undoable `gate.approve`**, which needs `manifest.json` re-pointed alongside the document
   restore — the one straddling case undo left out.
