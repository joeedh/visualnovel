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
- [Reaching the commands](#reaching-the-commands)
  * [From the renderer](#from-the-renderer)
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
  the five `story.*` document mutators set it. A command whose writes are generated output, or
  that straddles both classes, stays out — see the table below.
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

Twenty-four, in seven namespaces. Ten are `mutating`; one asks for confirmation.

| Command                        | Props                             | Notes                                                     |
| ------------------------------ | --------------------------------- | --------------------------------------------------------- |
| `gate.candidates`              | `characterId`                     | Pending portrait candidates for one character.            |
| `gate.approve` ✍               | `characterId`, `hash`             | Flips `character.md`; writes the approved PNG + manifest.  |
| `pipeline.status`              | —                                 | Task counts, gate-pending characters, gate-blocked state.  |
| `pipeline.run` ✍ ⚠            | `mock` (default `true`)           | The only `confirm: true` command — it spends money.        |
| `story.play`                   | —                                 | Build the playable in memory; writes nothing.              |
| `story.export` ✍               | —                                 | Write `vngen/build/story.play.json` (`vngen export`).      |
| `story.graph`                  | —                                 | Scenes + branch edges for the editor; reachability marked. |
| `story.coverage`               | `scene`                           | One scene's lines + persisted shots — the timeline's input. |
| `story.setChoice` ✍ ↺          | `scene`, `goto`, `label`, `index` (default `-1`) | `-1` appends. Rewrites one `[[choice:]]` marker. |
| `story.removeChoice` ✍ ↺       | `scene`, `index`                  | Deletes the marker line; the prose is untouched.           |
| `story.setNext` ✍ ↺            | `scene`, `goto` (default `''`)    | Empty `goto` clears the `[[next:]]` marker.                |
| `story.spliceScene` ✍ ↺        | `scene`, `from`, `edge` (default `-1`) | `A→B` becomes `A→scene→B`, as one two-scene patch.    |
| `story.setCoverage` ✍ ↺        | `scene`, `shot`, `lines` (default `''`) | Comma-separated line ids; claimed lines leave every other shot. |
| `agent.run` ✍                  | `input`                           | One agent turn. Mutating: a turn in execute mode writes.   |
| `agent.setMode`                | `mode` (`plan` \| `execute`)      |                                                            |
| `agent.setModel`               | `modelId`                         | Hot-swaps the text model, preserving conversation state.   |
| `agent.clear`                  | —                                 | Resets the conversation, back to plan mode.                |
| `interaction.list`             | —                                 | The gestures the app offers — see below.                   |
| `interaction.targets`          | `interaction`, `carried`          | Every target of a gesture, accepted or refused with why.   |
| `workspace.index`              | —                                 | Characters, locations, screenplay files, diagnostics.      |
| `view.room`                    | `name` (`studio`\|`floor`\|`play`) | Switches the shell's room.                                |
| `view.mode`                    | `room`, `mode`                    | A mode within a room — STUDIO `convo`\|`branches`, FLOOR `list`\|`graph`\|`timeline`. |
| `view.palette`                 | `open` (default `true`)           | Opens or closes the command palette.                       |
| `view.panelSize`               | `id`, `width` (80–1200)           | Saved width of a resizable panel; persisted, not an effect. |

✍ mutating ⚠ confirm ↺ undoable

**Only the `story.*` document mutators are undoable**, because undo restores a snapshot of the
document tree. `gate.approve` straddles both data classes — undoing `character.md` would leave
`manifest.json` still marking the asset `accepted` — `story.export` and `pipeline.run` write
only generated output, and `agent.run` owns its own commits, one per approved plan. The
reasoning is in [`plans/command-undo-redo.md`](plans/command-undo-redo.md).

**`view.*` commands run in the main process** and push a `command:ui` effect that the renderer
applies (`setRoom`, `setPaletteOpen`, `setStudioMode`, `setFloorMode`). The alternative — a
second, renderer-side registry — would be one more thing to keep in sync, and CDP could not
reach it.

`Room` stays a three-value union rather than growing into a mixed list of rooms and modes:
an editor is a mode *within* a room, so it gets `view.mode(room, mode)` and a
`{ type: 'mode' }` effect. Which modes a room *has* is a pairing of two props, which the spec
layer can't express — `prop.oneOf` can only say "one of these five" — so `run` checks the pair
and **refuses by throwing** (`STUDIO has no "graph" mode — try convo or branches.`), and the
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

The three branch-editor gestures (`branch.connect`, `branch.splice`, `branch.unwire`) are
declared in `apps/desktop/src/shared/interactions.ts`, beside `branchops.ts` and for the same
reason: `BranchEditor` runs `branchSplice.targets` to draw its mid-drag verdict overlay, and
`interaction.targets` runs the same call in main, so an author and an agent cannot be told
different things about the same drop.

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
`{ session: WorkspaceSession; state: SessionStore; ui(effect: UiEffect): void }`. `state` is
persisted UI state — deliberately not called `session`, which is already the backend one.

---

## Reaching the commands

### From the renderer

Three invoke channels on the existing typed IPC map (`apps/desktop/src/shared/ipc.ts`), plus
one event channel:

```ts
'command:catalog': () => CommandCatalog;
'command:exec':    (r: { id?; props?; dsl?; source? }) => CommandOutcome;
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

### From DevTools or CDP

The preload exposes a second bridge, `window.vn`, over that same IPC:

```js
await vn.catalog();
await vn.exec("view.room(name='floor')"); // DSL form
await vn.exec('gate.approve', { characterId: 'aiko', hash: '9e0a1b' }); // id + props form
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

The `schema` field is incidentally the repo's first zod-free JSON-Schema emission.
`NativeAgentBackend` currently advertises a hand-written `LOOSE_PARAMS`; feeding it these
schemas instead is an obvious follow-on.

---

## Testing

- `pnpm exec jest --selectProjects @vn/commands` — DSL parse/format round-trip and error
  columns, prop coercion and defaults, required-missing and unknown-key rejection, stack
  record contents (seq order, `gitHead` populated, error records), catalog schema shape, undo
  candidate selection and its refusals, and the journal itself against a **real** temp repo —
  its whole job is git behaviour, so mocking git would test nothing.
- `pnpm exec jest --selectProjects @vn/desktop` — the registry's namespaces and ids, that
  every prop carries a description, that the mutating set is exactly the expected commands,
  that only the document writers are undoable and nothing undoable is non-mutating, and that
  the generated `commands.json` deep-equals the live registry (skipped when the file hasn't
  been generated).

---

## Follow-ons

Deliberately out of scope for v1, in rough order of value:

1. **Make `renderer/app/Palette.tsx` data-driven** off `command:catalog` — it is still the
   static mockup that motivated this work.
2. **Route `confirm` through the renderer.** The main process currently auto-approves, so
   `pipeline.run`'s `confirm: true` is not yet a real gate.
3. **Feed `CatalogEntry.schema` to `NativeAgentBackend`** in place of `LOOSE_PARAMS`.
4. **Undoable `gate.approve`**, which needs `manifest.json` re-pointed alongside the document
   restore — the one straddling case undo left out.
