# The command system

Every action the desktop shell can take is a **registered command**: a named, described,
typed shim over a function that already exists. The palette, the menu bar, the authoring
agent, and an external CDP client all reach the same registry through the same execution
path, and every execution is recorded with the document repo's git HEAD.

This document describes what shipped. The implementation plan — including the deviations
from it and the follow-ons deliberately left out — is
[`plans/command-system.md`](plans/command-system.md). The deferred undo/redo design is
[`gitUndoOptions.md`](gitUndoOptions.md).

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
}
```

`onRecord` is a hook rather than a hardcoded write. The desktop app wires it to `appendJsonl`
at `vngen/state/commands.jsonl` — alongside the pipeline's own `tasks.jsonl`, and for the same
reason: an append-only log that can be replayed and diffed.

### Undo is deferred, not forgotten

**v1 registers nothing undoable.** `Command.undoable` is typed `?: false`, so today nothing
can accidentally claim to be reversible, and `stack.undo()` / `.redo()` return an explicit
refusal pointing at [`gitUndoOptions.md`](gitUndoOptions.md).

That report surveys five strategies and recommends shadow snapshots for document state paired
with the existing task graph for generated output. The point of recording `gitHead`,
`gitDirty`, `written` and `invocation` now is that **the record shape is the commitment; the
mechanism is not** — every candidate strategy is built from fields v1 already writes, so
adopting one is additive.

A half-working undo on an author's only copy of their screenplay is worse than none.

---

## The registered commands

Thirteen, in six namespaces. Four are `mutating`; one asks for confirmation.

| Command                        | Props                             | Notes                                                     |
| ------------------------------ | --------------------------------- | --------------------------------------------------------- |
| `gate.candidates`              | `characterId`                     | Pending portrait candidates for one character.            |
| `gate.approve` ✍               | `characterId`, `hash`             | Flips `character.md`; writes the approved PNG + manifest.  |
| `pipeline.status`              | —                                 | Task counts, gate-pending characters, gate-blocked state.  |
| `pipeline.run` ✍ ⚠            | `mock` (default `true`)           | The only `confirm: true` command — it spends money.        |
| `story.play`                   | —                                 | Build the playable in memory; writes nothing.              |
| `story.export` ✍               | —                                 | Write `vngen/build/story.play.json` (`vngen export`).      |
| `agent.run` ✍                  | `input`                           | One agent turn. Mutating: a turn in execute mode writes.   |
| `agent.setMode`                | `mode` (`plan` \| `execute`)      |                                                            |
| `agent.setModel`               | `modelId`                         | Hot-swaps the text model, preserving conversation state.   |
| `agent.clear`                  | —                                 | Resets the conversation, back to plan mode.                |
| `workspace.index`              | —                                 | Characters, locations, screenplay files, diagnostics.      |
| `view.room`                    | `name` (`studio`\|`floor`\|`play`) | Switches the shell's room.                                |
| `view.palette`                 | `open` (default `true`)           | Opens or closes the command palette.                       |

✍ mutating ⚠ confirm

**`view.*` commands run in the main process** and push a `command:ui` effect that the renderer
applies (`setRoom`, `setPaletteOpen`). The alternative — a second, renderer-side registry —
would be one more thing to keep in sync, and CDP could not reach it.

`CommandHost` is the app-specific service bundle every command receives:
`{ session: WorkspaceSession; ui(effect: UiEffect): void }`.

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
node scripts/vn-cdp.mjs --undo                     # v1: refuses, by design
```

A failed or refused command exits non-zero, so it composes in a shell.

### From the agent

`CommandSource` includes `'agent'`; the plumbing is in place, but wiring the authoring agent's
tool loop to the registry is a follow-on, not shipped.

---

## The catalog

`toCatalog(registry, source)` projects the registry into a serializable shape. Per command:
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
  record contents (seq order, `gitHead` populated, error records), catalog schema shape.
- `pnpm exec jest --selectProjects @vn/desktop` — the registry's namespaces and ids, that
  every prop carries a description, that the mutating set is exactly the four expected
  commands and nothing is undoable, and that the generated `commands.json` deep-equals the
  live registry (skipped when the file hasn't been generated).

---

## Follow-ons

Deliberately out of scope for v1, in rough order of value:

1. **Make `renderer/Palette.tsx` data-driven** off `command:catalog` — it is still the static
   mockup that motivated this work.
2. **Route `confirm` through the renderer.** The main process currently auto-approves, so
   `pipeline.run`'s `confirm: true` is not yet a real gate.
3. **Feed `CatalogEntry.schema` to `NativeAgentBackend`** in place of `LOOSE_PARAMS`.
4. **Undo**, per [`gitUndoOptions.md`](gitUndoOptions.md), starting with `gate.approve`.
