# Command system for the desktop app

Status: **shipped** (see [Status — shipped](#status--shipped) at the end).

## Context

The desktop app (`apps/desktop`) has no generic way to name, describe, or invoke an
operation. Every action is a bespoke IPC channel hand-registered in `src/main/index.ts` and
hand-wired to a React handler: `gate:approve`, `pipeline:run`, `agent:setMode`, and so on.
Consequences today:

- The `/` command palette (`renderer/Palette.tsx`) is a **static mockup** — hardcoded model
  list, fake skill rows, no discovery, no search input.
- `registerIpc()` is **untyped against `InvokeChannels`**; channel strings and arg types are
  re-declared by hand on the main side and can silently drift.
- There is no history of what the app did, no provenance tying an action to the state of the
  document repo when it ran, and no way to drive the app from outside for scripting or
  debugging.

This plan introduces a **command stack**: commands are registered, carry typed properties,
are invokable from a small string DSL, record the document repo's git HEAD at execution
time, are emitted as a build-time JSON catalog, and can be driven over CDP.

**Undo/redo is explicitly out of scope for v1** (per decision). The record shape reserves
everything a future implementation needs — `gitHead`, `gitDirty`, `written` paths, the
replayable invocation string — and `docs/gitUndoOptions.md` (a deliverable of this plan)
surveys the strategies so the choice is made deliberately later, not by accident now.

Intended outcome: one registry, one execution path, one catalog. The palette, the menu bar,
the agent, and an external CDP client all reach the same commands.

---

## Deliverables

0. `docs/plans/command-system.md` — this plan, checked in per CLAUDE.md § Plans, kept
   current as work proceeds.
1. `packages/commands` (`@vn/commands`) — the framework: prop specs, registry, DSL, stack,
   catalog projection. Pure and dependency-light; unit tested.
2. `apps/desktop/src/main/commands/` — the actual command definitions, thin wrappers over
   the existing `WorkspaceSession` methods.
3. `scripts/gen-command-catalog.mjs` + a `build:catalog` step → `apps/desktop/dist/commands.json`.
4. CDP access: opt-in `--remote-debugging-port`, a `window.vn` preload bridge, and
   `scripts/vn-cdp.mjs` as a driver.
5. `docs/gitUndoOptions.md` — the undo strategy report.

---

## 1. `packages/commands` — the framework

New package, layered as a near-leaf. Deps: `types`, `util`, `git` (for the `Git` type used
to read HEAD). Register it in **both** places in `eslint.config.mjs`:

- `ALLOWED`: `commands: ['types', 'util', 'git']`, and add `'commands'` to the `desktop` entry.
- `boundaries/elements`: `{ type: 'commands', pattern: 'packages/commands', mode: 'folder' }`
  — **and add the missing `{ type: 'desktop', pattern: 'apps/desktop', mode: 'folder' }`**.
  `desktop` is currently listed in `ALLOWED` but has no element entry, so the boundary rule
  never actually applies to the desktop app. Worth closing while we're here.

Also add `'commands'` to: `PACKAGES` in `scripts/esbuild.desktop.mjs`, `PACKAGES` in
`jest.config.cjs`, and the `paths` map in the root `tsconfig.json`.

### `src/props.ts` — declarative property specs

Deliberately **not** zod. The repo is on zod 3 (no `z.toJSONSchema`), and `@vn/authoring`
already had to hand-roll `describeToolParams` (`packages/authoring/src/tools.ts:89-117`)
just to render its tool args as a string. A declarative spec makes the JSON catalog, the DSL
coercion, and a future properties panel all fall out of one source of truth.

```ts
export type PropKind = 'string' | 'number' | 'boolean' | 'enum' | 'string[]';
export type PropValue = string | number | boolean | string[] | null;

export interface Prop<T = PropValue, Req extends boolean = boolean> {
  kind: PropKind;
  description: string;
  required: Req;
  default?: T;
  /** enum only. */
  values?: readonly string[];
  min?: number;
  max?: number;
}

export type PropSpecMap = Record<string, Prop>;
```

Builders (`prop.string`, `prop.number`, `prop.boolean`, `prop.oneOf`, `prop.stringList`),
overloaded so passing a `default` narrows `required` to `false`. `PropsOf<M>` then maps the
spec to the runtime object type:

```ts
export type PropsOf<M extends PropSpecMap> = { [K in keyof M]: ValueOf<M[K]> };
```

**Shipped deviation:** the plan originally made defaulted keys *optional* here. That is wrong
for `run` — `coerceProps` has already filled the defaults, so it never sees `undefined`, and
every defaulted prop would have forced a cast at the call site. Optionality belongs to the
*raw input*, not to the runtime object. `Req` still matters (the catalog reads it off the
spec to build the JSON-Schema `required` list), just not at the type level.

`coerceProps(specs, raw)` → `{ ok: true; value } | { ok: false; errors: string[] }`. Applies
defaults, coerces strings to number/boolean (JSON and CDP callers send loose values),
rejects unknown keys and out-of-set enum values. This is the single validation authority —
mirroring how `Agent.dispatch` in `packages/authoring/src/loop.ts:229-287` is the sole
arg-validation point for tools.

### `src/command.ts`

Modelled on the existing `Tool` interface (`packages/authoring/src/tools.ts:56-65`) so the
two registries read as siblings.

```ts
export interface CommandContext<Host = unknown> {
  root: string;
  git: Git;
  host: Host;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** Elevated-action gate; absent means the command refuses rather than assumes consent. */
  confirm?(message: string): Promise<boolean>;
}

export interface CommandOutput {
  message: string;
  data?: unknown;
  /** Workspace-relative paths written — provenance now, undo input later. */
  written?: string[];
}

export interface Command<M extends PropSpecMap = PropSpecMap, Host = any> {
  id: string;              // dotted, camelCase allowed: /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/
  title: string;
  description: string;
  props: M;
  mutating: boolean;
  confirm?: boolean;
  /** Reserved. v1 registers nothing undoable — see docs/gitUndoOptions.md. */
  undoable?: false;
  run(props: PropsOf<M>, ctx: CommandContext<Host>): Promise<CommandOutput>;
}

export function defineCommand<M extends PropSpecMap, Host>(c: Command<M, Host>): Command<M, Host>;
```

### `src/dsl.ts` — `namespace.command(a='x' b=1)`

Hand-rolled tokenizer + recursive-descent parser, ~150 lines, pure and fully unit-testable.

```
invocation := path '(' args? ')'
path       := ident ('.' ident)+
args       := arg ((',' | ws) arg)*        // commas optional
arg        := ident '=' value
value      := quoted | number | 'true' | 'false' | 'null' | array | bareword
quoted     := '...' | "..."  with \\ escapes
array      := '[' value ((',' | ws) value)* ']'
```

Barewords parse as strings, so `agent.setMode(mode=execute)` works — convenient for enums;
`coerceProps` sorts out the rest. Errors carry a column offset for a legible message.

`formatCommand(id, props): string` is the inverse, used for the history display and the
JSONL log. A round-trip test pins `parse(format(x)) ≡ x`.

### `src/stack.ts` — the command stack

```ts
export type CommandSource = 'ui' | 'dsl' | 'cdp' | 'agent' | 'menu';

export interface CommandRecord {
  seq: number;
  id: string;
  props: Record<string, PropValue>;
  /** DSL rendering — a copy-pasteable repro line. */
  invocation: string;
  source: CommandSource;
  /** Document-repo HEAD at exec time; null in an unborn or absent repo. */
  gitHead: string | null;
  /** Whether the worktree was dirty when the command ran. */
  gitDirty: boolean;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'error';
  message: string;
  written?: string[];
  error?: string;
}
```

`@vn/git` already has everything needed: `head(): Promise<string | null>` (returns `null` in
an unborn repo) and `isDirty(pathspec?)`. No changes to that package.

```ts
export class CommandStack<Host> {
  constructor(opts: {
    registry: CommandRegistry<Host>;
    context: CommandContext<Host>;
    onRecord?(r: CommandRecord): void | Promise<void>;
  });
  exec(id: string, raw: Record<string, unknown>, source: CommandSource): Promise<CommandOutcome>;
  execDsl(text: string, source: CommandSource): Promise<CommandOutcome>;
  history(limit?: number): CommandRecord[];
  canUndo(): boolean;   // v1: always false
  undo(): Promise<CommandOutcome>;  // v1: { ok: false, error: 'undo not implemented — see docs/gitUndoOptions.md' }
}
```

Execution order, deliberately mirroring `Agent.dispatch`: resolve id → coerce/validate props
→ `confirm` gate if flagged → capture `gitHead`/`gitDirty` → run → record. A failed command
still produces a record with `status: 'error'`.

`onRecord` is a hook, not a hardcoded write — the desktop wires it to `appendJsonl` (already
in `@vn/util`) at `paths.state/commands.jsonl`, alongside the existing `tasks.jsonl`.

### `src/registry.ts` and `src/catalog.ts`

`CommandRegistry`: `register` (throws on duplicate id or malformed id), `get`, `list()`
sorted by id, `namespaces()`.

`toCatalog(registry, source)` projects to the JSON shape:

```ts
export interface CatalogEntry {
  id; title; description; mutating; confirm; undoable;
  props: { name; kind; description; required; default?; values? }[];
  /** Ready-to-paste DSL template, e.g. "gate.approve(characterId='' hash='')". */
  usage: string;
  /** JSON Schema for the props object — for external tooling and LLM tool advertisement. */
  schema: { type: 'object'; properties: {…}; required: string[]; additionalProperties: false };
}
```

The `schema` field incidentally gives the repo its first real zod-free JSON-Schema
emission; `NativeAgentBackend` currently advertises `LOOSE_PARAMS`
(`packages/authoring/src/backend.ts:145-189`). Not wired up here — noted as a follow-on.

---

## 2. Command definitions — `apps/desktop/src/main/commands/`

Definitions live in the desktop app, not the framework package: they need the session, and
`apps/desktop` is already the sanctioned join point above both branches. They are **thin
wrappers over existing `WorkspaceSession` methods** — low risk, no logic moves.

| File            | Commands                                                                  |
| --------------- | ------------------------------------------------------------------------- |
| `gate.ts`       | `gate.approve`, `gate.candidates`                                         |
| `pipeline.ts`   | `pipeline.run`, `pipeline.status`                                         |
| `story.ts`      | `story.export`, `story.play`                                              |
| `agent.ts`      | `agent.run`, `agent.setMode`, `agent.setModel`, `agent.clear`             |
| `workspace.ts`  | `workspace.index`                                                         |
| `view.ts`       | `view.room`, `view.palette`                                               |
| `index.ts`      | `createDesktopRegistry(): CommandRegistry<CommandHost>`                   |

Scope covers all three tiers — disk-mutating, agent/UI state, and read-only queries. With
undo deferred, the payoff of the bus is *uniform reach* (palette, menus, CDP), so leaving
queries and view state outside it would gut most of the value.

Two notes:

- **`view.*` commands run in main and emit an effect** on a new `command:ui` event channel
  that `App.tsx` applies (`setRoom`, `setPaletteOpen`). One registry, one catalog, and CDP
  can drive the UI — rather than a second renderer-side registry to keep in sync.
- **`story.export`** needs a new `WorkspaceSession.exportPlayable()`: `buildPlayable` is
  already called by `playable()`; write the result to `paths.storyPlay`
  (`packages/store/src/paths.ts:56`) via `writeFileAtomic`. Mirrors `vngen export`.

`CommandHost` = `{ session: WorkspaceSession; ui(effect): void }`.

---

## 3. IPC surface

In `src/shared/ipc.ts`, add to `InvokeChannels`:

```ts
'command:catalog': () => CommandCatalog;
'command:exec': (p: { id?: string; props?: Record<string, PropValue>; dsl?: string;
                      source?: CommandSource }) => CommandOutcome;
'command:history': (limit?: number) => CommandRecord[];
```

and to `EventChannels`: `'command:ui': UiEffect`. The preload is a fully generic passthrough
(`src/preload/index.ts`) — **no changes needed there for these channels**.

While editing `registerIpc()` (`src/main/index.ts:56`), add a typed wrapper so registration
is checked against the map instead of hand-annotated:

```ts
function handle<C extends InvokeChannel>(
  channel: C,
  fn: (...args: Parameters<InvokeChannels[C]>) => Promise<ReturnType<InvokeChannels[C]>> | ReturnType<InvokeChannels[C]>,
): void { ipcMain.handle(channel, (_e, ...args) => fn(...(args as never))); }
```

**Existing channels stay** as thin delegations to the command stack, so the renderer keeps
working and can migrate incrementally. `renderer/api.ts`'s `fallback` mock needs cases for
the new channels (its `default` silently resolves `undefined` in browser-preview mode).

---

## 4. CDP access

Chrome's own debugger, not a new server — no second socket to secure, and it works with
Playwright/Puppeteer/`curl` out of the box.

- **`src/main/index.ts`**: if `process.env.VN_CDP_PORT` is set, before `app.whenReady()`
  call `app.commandLine.appendSwitch('remote-debugging-port', port)` and
  `appendSwitch('remote-debugging-address', '127.0.0.1')`. **Opt-in and off by default** —
  the port grants full control of the renderer. Document that in `CLAUDE.md`.
- **`scripts/dev.desktop.mjs`**: default `VN_CDP_PORT=9222` in the dev loop only. (Since
  shipped, `scripts/vndesktop.mjs` defaults it too — the launchers are what a developer runs,
  and neither is in a packaged build.)
- **`src/preload/index.ts`**: a second `contextBridge.exposeInMainWorld('vn', …)` with
  `exec(dslOrId, props?)`, `catalog()`, `history(n?)`, `undo()`, `redo()`. Living in the
  preload (not React) means it exists before the app mounts, which matters for scripting.
- **`scripts/vn-cdp.mjs`**: `node scripts/vn-cdp.mjs "gate.approve(characterId='aiko')"` —
  GET `/json/list`, pick the page target, open its WebSocket, send `Runtime.evaluate` with
  `awaitPromise: true, returnByValue: true`, print the JSON result. Feature-detect
  `globalThis.WebSocket` (unflagged only on Node 22+; the repo's floor is Node 20) and fall
  back to a `ws` devDependency on `@vn/desktop`.

---

## 5. Build-time catalog

`scripts/gen-command-catalog.mjs`:

1. esbuild-bundle a tiny `apps/desktop/src/main/commands/catalog-entry.ts` (imports the
   registry, calls `toCatalog`) to a temp CJS file, using the **same alias map + externals**
   as `esbuild.desktop.mjs`. Factor that alias map into `scripts/aliases.mjs` and have both
   scripts import it, so the lists can't drift.
2. `require()` it and pull the catalog object.
3. Write `apps/desktop/dist/commands.json`, pretty-printed with stable key order.

Wiring:

- `apps/desktop/package.json`: `"build:catalog": "node ../../scripts/gen-command-catalog.mjs"`,
  and `"build": "pnpm build:main && pnpm build:catalog && pnpm build:renderer"`.
- `turbo.json`: broaden `globalDependencies` `"scripts/esbuild.*.mjs"` → `"scripts/*.mjs"`
  so the new generator invalidates the cache. `outputs: ["dist/**"]` already covers the JSON.

The channel `command:catalog` serves the **live registry**, never the file, so the two cannot
diverge at runtime. A test asserts the generated JSON equals `toCatalog(createDesktopRegistry())`.

---

## 6. `docs/gitUndoOptions.md` — the undo strategy report

Written as part of this plan, not implemented. Structure:

1. **Where v1 leaves off** — what `CommandRecord` already captures (`gitHead`, `gitDirty`,
   `written`, `invocation`) and why each is a prerequisite for every strategy below.
2. **A — Per-command inverse (memento).** Precise; each command supplies its own undo. Fails
   for `pipeline.run` (generated assets, model calls) and costs authoring effort per command.
3. **B — Path-scoped restore.** `git restore --source <record.gitHead> -- <record.written>`.
   Cheap and exact for document edits; needs handling for paths untracked at that HEAD
   (delete rather than restore), and it silently discards concurrent edits to those paths.
4. **C — Commit per mutating command.** Undo becomes `git revert`. Durable and shareable,
   but pollutes history and collides with the authoring agent's "one commit per approved
   plan" rule (`packages/authoring/src/loop.ts`).
5. **D — Shadow snapshots.** `write-tree`/`commit-tree` into `refs/vn/undo/<seq>` without
   moving HEAD (or `git stash create`). Full fidelity including dirty and untracked state,
   invisible to normal `git log`, prunable. Currently the strongest candidate.
6. **E — Split by data class.** Documents via D; generated assets via the existing
   content-addressed store + `tasks.jsonl`, which are already append-only — "undo" there is
   re-pointing, not deleting.
7. **Cross-cutting problems.** Dirty worktree at exec time; interleaving with vnauthor's own
   commits; redo validity after an external edit; the `vngen/` tree being committed output.
8. **Recommendation** and a migration path that keeps the v1 `CommandRecord` shape.

---

## Files touched

**New**

- `packages/commands/` — `package.json`, `src/{index,props,command,registry,dsl,stack,catalog}.ts` + `*.test.ts`
- `apps/desktop/src/main/commands/` — `{index,gate,pipeline,story,agent,workspace,view,catalog-entry}.ts`
- `scripts/gen-command-catalog.mjs`, `scripts/aliases.mjs`, `scripts/vn-cdp.mjs`
- `docs/gitUndoOptions.md`, `docs/plans/command-system.md`

**Modified**

- `apps/desktop/src/shared/ipc.ts` — command channels + `command:ui` event
- `apps/desktop/src/main/index.ts` — typed `handle<C>()`, command handlers, CDP switch
- `apps/desktop/src/main/session.ts` — `exportPlayable()`; expose the stack
- `apps/desktop/src/preload/index.ts` — `window.vn` bridge
- `apps/desktop/renderer/{api.ts,App.tsx}` — fallback cases, `command:ui` listener
- `apps/desktop/package.json` — `build:catalog`, `ws` devDep
- `eslint.config.mjs` — `commands` element + allow-list; add the missing `desktop` element
- `jest.config.cjs`, `tsconfig.json`, `turbo.json`, `scripts/esbuild.desktop.mjs`
- `CLAUDE.md` — command system section, `VN_CDP_PORT`, the new package in the layering table

**Deliberately unchanged:** `packages/authoring` (its `Tool` registry stays separate — the
agent's tools and the app's commands have different gating rules), `packages/git`,
`renderer/Palette.tsx` (making the palette data-driven is a natural follow-on, not required
to land the bus).

---

## Verification

1. `pnpm check`, `pnpm lint`, `pnpm test` green. Confirm the boundaries rule now actually
   fires for `apps/desktop` (temporarily add a forbidden import; expect an error).
2. `pnpm exec jest --selectProjects @vn/commands` — DSL parse/format round-trip, prop
   coercion and defaults, required-missing and unknown-key rejection, stack record contents
   (seq order, `gitHead` populated, error records), catalog schema shape.
3. `pnpm build` → assert `apps/desktop/dist/commands.json` exists, is valid JSON, and every
   entry has a non-empty `usage` and a `schema`.
4. **Live app:** `pnpm --filter @vn/desktop dev`, then in DevTools console:
   ```js
   await vn.catalog();
   await vn.exec("view.room(name='floor')");        // UI switches rooms
   await vn.exec("pipeline.status()");
   await vn.exec("gate.approve(characterId='aiko' hash='9e0a1b')");
   await vn.history();                              // records carry gitHead
   ```
5. **CDP, out of process:** with the dev loop running,
   `node scripts/vn-cdp.mjs "workspace.index()"` prints the index JSON;
   `node scripts/vn-cdp.mjs "view.room(name='play')"` visibly switches rooms.
6. `git -C examples/sample rev-parse HEAD` matches the `gitHead` on records appended to
   `examples/sample/vngen/state/commands.jsonl`.
7. Confirm `vn.undo()` returns the explicit not-implemented outcome pointing at
   `docs/gitUndoOptions.md` rather than throwing or silently no-op'ing.
8. Per CLAUDE.md § Finishing a plan: audit comments (no `CLAUDENOTE:` left) and update
   `CLAUDE.md` + `docs/plans/command-system.md` to match what shipped.

---

## Status — shipped

All of it landed. `pnpm check` and `pnpm lint` are clean; `pnpm test` is 25 suites / 210 tests
(from 24 / 204). Every verification step above passed, including the live checks: the catalog,
`workspace.index()`, `view.room(name='play')` and `story.export()` all executed over CDP, the
`gitHead` on each record matched `git -C examples/sample rev-parse HEAD` exactly, unknown
commands and invalid props were rejected with legible messages and a non-zero exit, and
`--undo`/`--redo` returned the explicit refusal.

Deviations from the plan as written, all deliberate:

- **`PropsOf<M>` makes every key present**, not defaulted-keys-optional. See §1 above.
- **`COMMAND_ID` allows camelCase within a segment** (`agent.setMode`), so ids can mirror the
  IPC channels they wrap. Segments still must start lowercase.
- **`ws` is a root devDependency**, not one of `@vn/desktop` — `scripts/vn-cdp.mjs` runs from
  the repo root.
- **`scripts/vn-cdp.mjs` grew `--undo`/`--redo` flags** alongside `--catalog`/`--history`, via
  a small lookup table, rather than leaving those to ad-hoc expressions.
- **jest gained an `@vn/desktop` project** so the registry test runs. This works because the
  command modules reach the session only through a type-only import, so the registry is
  loadable without Electron — the same property the catalog generator depends on.

Two things the plan did not anticipate, both found while proving step 1:

- **`boundaries/element-types` was entirely inert**, repo-wide — not just missing the `desktop`
  element. `'import/resolver': { node: true }` could not resolve source-only packages (an
  `exports` map, no `main`), and the rule silently passes *unclassified* dependencies. Fixed by
  adding `eslint-import-resolver-typescript` and pointing the resolver at the root tsconfig.
  The layering CLAUDE.md advertised as "enforced by lint rules" had never actually held.
- With the rule live, **two pre-existing violations surfaced** in `packages/scheduler` —
  type-only imports of `ProjectConfig` and `ProjectPaths`. Both are legitimate pass-throughs
  into `@vn/pipeline`, which already allows both, so the `scheduler` allow-list was widened to
  match reality rather than the imports removed.

Follow-ons, deliberately not in scope: making `renderer/Palette.tsx` data-driven off the
catalog, routing `confirm` through the renderer instead of the main process's
auto-approve stub, and feeding `CatalogEntry.schema` to `NativeAgentBackend` in place of its
`LOOSE_PARAMS`.
