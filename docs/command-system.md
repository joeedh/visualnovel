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
  * [Commit-on-save is the journal's sibling](#commit-on-save-is-the-journals-sibling)
- [The registered commands](#the-registered-commands)
  * [The `doc.` namespace](#the-doc-namespace)
  * [The `prompt.` namespace](#the-prompt-namespace)
  * [Interactions: the gesture surface](#interactions-the-gesture-surface)
  * [Preconditions: asking before acting](#preconditions-asking-before-acting)
- [Reaching the commands](#reaching-the-commands)
  * [From the renderer](#from-the-renderer)
  * [From the palette, or from a command's own dialog](#from-the-palette-or-from-a-commands-own-dialog)
  * [From a right-click](#from-a-right-click)
  * [From DevTools or CDP](#from-devtools-or-cdp)
  * [From the agent](#from-the-agent)
- [The catalog](#the-catalog)
- [Testing](#testing)
- [Follow-ons](#follow-ons)

<!-- tocstop -->

Every action the desktop shell can take is a **registered command**: a named, described,
typed shim over a function that already exists. The palette, the menu bar, the document tree's
right-click menus, the authoring agent, and an external CDP client all reach the same registry
through the same execution path, and every execution is recorded with the document repo's git HEAD.

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
  kind: 'string' | 'directory' | 'secret' | 'number' | 'boolean' | 'enum' | 'string[]';
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

Builders cover the kinds — `prop.string`, `prop.directory`, `prop.secret`, `prop.number`,
`prop.boolean`, `prop.oneOf`, `prop.stringList`. Each is overloaded so that **passing a `default` narrows
`required` to `false`**:

```ts
props: {
  characterId: prop.string('the character to approve'),                 // required
  mock: prop.boolean('dry run: preview only', { default: true }),       // optional
  mode: prop.oneOf(['plan', 'execute'] as const, 'the mode to switch to'),
}
```

**`directory` is a string that says the OS can fill it in.** It coerces, serializes and
schematizes exactly as `string` — it *is* one — and exists only so a form can offer a folder
chooser beside the field. The alternative, a form that draws a Browse button for any property
happening to be spelled `path`, makes a widget depend on spelling.

**`secret` is a string that says never write this down.** Same trick, opposite reason: it coerces
and schematizes as a string, and `digestProps` — the single record-time projection, so one seam
covers `record.props`, the formatted `invocation` and the commit trailer built from it — replaces
its value with the literal `<secret>`. `digest` is the near miss and is the wrong tool: it records
`<sha256:…+len>`, a fingerprint of a live credential and its exact length. `run` still receives
the real value; nothing downstream of the record ever does.

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
  commits?: { repo: string; sha: string }[]; // what commit-on-save wrote; absent ⇒ nothing was
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
  document mutators set it — every `story.*` one (the branch/coverage commands it shipped for, the
  prose edits, `moveShot` and the two outfit commands), `doc.write`, `doc.create` and `doc.rename`,
  which write documents by the same right, and the authored-input writers that followed: `art.setNotes`,
  `project.setArtStyle` and the `prompt.*` chunk editors. A command whose writes are generated
  output, or that straddles both classes, stays out. The `↺` column in the table below is the
  list — read it there rather than counting here, because the set grows.
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

### Commit-on-save is the journal's sibling

`Committer` is wired into the stack the same way `UndoJournal` is — a constructor option, absent
by default, so a stack without one moves no ref at all. With one, every mutating command that
left something on disk becomes a commit in each repo it touched, subject named by
`CommandRecord.message` and provenance carried in `Vn-*` trailers. The resulting shas land on
`record.commits`.

The two are independent: a commit changes no file in the worktree, so it cannot perturb a
snapshot tree taken either side of it, and they keep different scopes on purpose — the committer
takes the whole worktree (`git add -A`), the journal only the document class. A command whose
implementation already commits declares `commitsItself: true` and the committer leaves it alone;
that is how `vnauthor`'s one-commit-per-approved-plan survives. Which repos, what the message
looks like, and why the CLI stays out of it: [`repos-and-commits.md`](repos-and-commits.md).

---

## The registered commands

Ninety-seven, in sixteen namespaces. Fifty-seven are `mutating`; fifty-six declare a
precondition; thirty-four are undoable; fifteen ask for confirmation.

**Commands are the only write path.** The `story.*` branch mutators go through
`session.editBranches(decide)` → `planMarkerEdit` → `applyMarkerPlan` → reload, and the scene
editors through `session.editScene(decide)`, so no surface writes scene prose by another route.
The same holds for the shot decompositions: outside the planner, `work/shots/<sceneId>.json` is
written by `story.setCoverage`, `story.setOutfit`, `art.setNotes` (a shot rung), the `prompt.*`
chunk editors, `editScene` — which carries a shot's coverage across a split, merge or delete rather
than stranding it — and `story.decomposeAll`, the one that creates a storyboard where there was
none. `vnauthor`'s `set_outfit` is not another one: it runs the same
`@vn/scriptedit` rules and gets the same refusals.

| Command                        | Props                             | Notes                                                     |
| ------------------------------ | --------------------------------- | --------------------------------------------------------- |
| `art.generate` ✍ ⚠ ✓           | `sentence`, `subject` (default `''`), `open` (default `true`) | Draw a concept from a sentence and file it under Concepts, bound to the location or character it names. Spends one image generation; the pipeline never plans one and `vngen export` ignores it. |
| `art.promote` ✍ ⚠ ✓            | `hash`, `variant`, `description` (default `''`) | Make a concept the location plate for one variant: the variant joins the sheet if it is new, the bytes are re-recorded as a plate, and that plate's task is logged `done` so the next run **adopts** the picture. A character concept is refused — a look goes through the gate. |
| `art.redraw` ✍ ⚠ ✓             | `hash`, `prompt` (default `''`), `title` (default `''`), `open` (default `true`) | Draw a concept again from an edited prompt — the one asset whose prompt is authored rather than derived, so the one prompt there is to rewrite. The result is a **new** sketch beside the original; nothing is overwritten. A planned asset is refused by name: re-rendering one is `asset.regenerate`. |
| `art.setNotes` ✍ ↺ ✓           | `target`, `notes` (default `''`)  | Art direction on one rung — `character:aiko`, `character:aiko/gala`, `location:cafe`, `location:cafe/night`, `shot:greet/s2`. Appended to the prompt, so it **re-renders** what that rung reaches. Never creates the rung it names. |
| `asset.info`                   | `hash`                            | One asset: label, kind, root, accepted, its task, the prompt it was rendered from, the prompt the builders would write **today**, and the art-notes rungs reaching it. |
| `asset.accept` ✍ ✓             | `hash`                            | `store.accept`, generic across both roots. A portrait is refused by name — approving one also writes `character.md` and `approved.png`, which is `gate.approve`. So is a concept: nothing downstream consumes one, so making it count is `art.promote`. And so is an upload — nothing generated it, so there is no work to bless; it counts by being pointed at. A **suspended** asset is refused too, naming what moved. |
| `asset.adopt` ✍ ⚠ ✓            | `hash`, `slot`, `replace` (default `false`) | Make an asset already in the store the output of the picture a slot names — `plate:cafe/night`, `sheet:aiko/gala/front`, `shot:greet/s2` — so the next run **adopts** it rather than rendering one. The generalization of `art.promote`, which is now one caller of it. A `portrait:` slot is refused by name (approving a look is `gate.approve`), as is an `asset:` one (an upload and a concept are their own identity). Superseding a render that already holds the slot needs `replace`; the old bytes stay in the store either way, and nothing is auto-accepted. |
| `asset.replace` ✍ ⚠ ✓          | `hash`                            | The asset editor's Replace strip: open an image chooser and make what comes back this picture's slot — `asset.upload` with the chooser in front and the slot read off the asset instead of typed. Refused when these bytes fill no slot (a concept, an upload, a render something later superseded). Cancelling changes nothing. |
| `asset.regenerate` ✍ ⚠ ✓       | `hash`, `run` (default `false`)   | Put the asset's task back to `pending`; with `run`, run the pipeline for real straight afterwards. A fixed image seed makes a plain re-roll deterministic, and the refusal text says so. A **concept** is refused by name — the planner never made one, so there is no task to requeue: `art.redraw` is what draws it again. An **upload** is refused for the same reason, pointing at `asset.upload` for a different image. |
| `asset.upload` ✍ ⚠ ✓           | `file`, `title` (default `''`), `slot` (default `''`), `replace` (default `false`), `open` (default `true`) | Bring an image from outside into the **base** store. With no `slot` it is a `reference`: nothing generated it, so it is never approved and never planned — it exists to be pointed at by `prompt.addRef`. Name a `slot` and the same act files the bytes and adopts them onto it, which is what a repainted plate wants. Mock placeholder art and anything that is not an image are refused by name; a file that lands but cannot be adopted says so and stays filed as a reference, recoverable with `asset.adopt`. |
| `asset.suspended`              | —                                 | Every asset drawn against a reference whose slot has moved, plus everything downstream of one, in dependency order with the reason for each. Derived on every call, never a stored flag — the bytes stay; suspension only says they are out of date. |
| `bible.search`                 | `query`, `limit` (default `8`)    | Ranked excerpts from `wiki/`. There is no `bible.read`: [`@vn/bible`](story-bible.md) has no whole-file API. |
| `command.check`                | `invocation`                      | Would that invocation run? See [Preconditions](#preconditions-asking-before-acting). |
| `doc.read`                     | `path`                            | The text of one workspace document, with the content hash it was read at. Bounded and text only. |
| `doc.write` ✍ ↺ ✓              | `path`, `text` (digested), `seenHash` (default `''`) | Overwrite a document. A file changed underneath the edit is refused by content. `scenes/**` is refused outright. |
| `doc.create` ✍ ↺ ✓             | `kind` (`character`\|`location`\|`note`), `name` | Scaffold a sheet or a note in its conventional home, from the same templates the agent's create tools use. Refuses over an existing path. |
| `doc.rename` ✍ ↺ ✓             | `path`, `name`                    | Change the name a document is known by, **in place**. A sheet is renamed through its `name:` field, anything else through its title — front-matter `title:`, else the first heading — so the new name is read back from wherever the old one was. The file does not move: an id is derived from a name once, at creation, and afterwards it is what shots, cast lists and `[[goto:]]` markers point at. What the tree's double-click-to-rename dispatches. |
| `gate.candidates`              | `characterId`                     | Pending portrait candidates for one character.            |
| `gate.approve` ✍ ✓             | `characterId`, `hash`             | Flips `character.md`; writes the approved PNG + manifest.  |
| `pipeline.status`              | —                                 | Task counts, gate-pending characters, gate-blocked state.  |
| `pipeline.run` ✍ ⚠ ✓          | `mock` (default `true`)           | Confirmed, like every command that spends money.           |
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
| `story.moveShot` ✍ ↺ ✓         | `scene`, `shot`, `after` (default `''`) | Reorder a shot by moving the lines it covers; empty `after` means the top. A shot other shots draw inside is refused by name. |
| `story.setSceneOutfit` ✍ ↺ ✓   | `scene`, `character`, `outfit` (default `''`) | Writes the scene's `[[outfit:]]` marker; empty clears it. Every shot that does not override it re-renders. |
| `story.setOutfit` ✍ ↺ ✓        | `scene`, `shot`, `character`, `outfit` (default `''`) | One subject of one shot; empty clears the override. Unlike coverage this re-hashes the shot. |
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
| `story.decomposeAll` ✍ ↺ ⚠ ✓  | —                                 | Storyboard every reachable scene that has none, so the graph is whole rather than one wave of it. One model call per scene. Additive only — a scene with a file is left alone and there is **no `force`**, because the file wins forever and re-decomposing would move shot ids, hence task identities, hence re-render art already paid for. A scene the model does not answer for is named and **not written**: an absent file is the only signal meaning "decompose this". `check` refuses mock or unresolved keys with `pipeline.run`'s own sentence, reports the count, and warns about scenes naming a character the project does not have yet. One undo point for the batch. |
| `prompt.info`                  | `hash`                            | The prompt one asset would be generated from: the clauses the builders derived, what the author has done to them, and the one string that gets sent. The same projection the Asset editor draws, so an agent and the pane never disagree about what a picture was asked for. |
| `prompt.setChunk` ✍ ↺ ✓        | `hash`, `chunk`, `op` (`replace`\|`append`\|`mute`\|`clear`), `text` (default `''`) | One thing to one clause. The keys are what `prompt.info` lists. An edit records the derived text it was written against, so the pane can say when the project moved underneath it. It **re-renders** what that rung reaches. |
| `prompt.moveChunk` ✍ ↺ ✓       | `hash`, `chunk`, `after` (default `''`) | Reorder one clause; empty `after` means the top. Order is weight to an image model, so this is an authorial act. `prompt.clear(part=order)` restores the derived order. |
| `prompt.setCustom` ✍ ↺ ✓       | `hash`, `text`                    | Replace the whole prompt with one written by hand. The clauses stay underneath — they are what `prompt.condense` reconciles against and what `prompt.check` measures. |
| `prompt.condense` ✍ ↺ ✓        | `hash`, `force` (default `false`) | Ask the text model to rewrite the clauses as one fluent prompt and store it. It is then **held**: clauses moving under it do not re-render the picture. `force` reconciles against a hand-written prompt rather than refusing over it. |
| `prompt.clear` ✍ ↺ ✓           | `hash`, `part` (`chunks`\|`order`\|`custom`\|`agent`\|`all`, default `all`) | Discard part of what was done to a prompt. What is left is what the builders derive, byte for byte. |
| `prompt.check`                 | `hash`                            | Which clauses a hand-written or condensed prompt no longer appears to say. A word-overlap heuristic — "not found", never "dropped" — so it is a prompt to go and look. In chunks mode nothing can be missing. |
| `prompt.addRef` ✍ ↺ ✓          | `hash`, `chunk`, `ref`            | Attach a reference image to one clause — evidence for that clause, so muting it drops the reference too. `ref` is an asset hash (a prefix will do) or a **slot address**: `portrait:<character>`, `sheet:<character>/<outfit>/<angle>`, `plate:<location>/<variant>`, `shot:<scene>/<shot>`. A slot pins what fills it today and remembers where it came from; a bare hash pins itself and can never move. Refuses a reference that would close a cycle, naming the whole path. |
| `prompt.dropRef` ✍ ↺ ✓         | `hash`, `chunk`, `ref`            | Take a reference off a clause. The bytes stay in the store — this only stops them being sent. |
| `prompt.repin` ✍ ↺ ✓           | `hash`, `chunk`, `ref`, `regenerate` (default `true`) | Point a linked reference at whatever its slot holds now, which is how a suspension is cleared. `regenerate=false` is **re-approve**: it keeps the existing bytes by recording them as the newly-keyed task's output, so nothing re-renders. |
| `project.info`                 | —                                 | What `project.yaml` says: title, entry scene, art style, model ids, image params, and how many image tasks the art style reaches. Never the API keys — their *names* are in the file and a pane listing them is one screenshot away from looking like it lists their values. |
| `project.setArtStyle` ✍ ⚠ ↺ ✓  | `style` (default `''`)            | The sentence every image prompt opens with. Not art notes on one rung: it reaches every portrait, sheet, plate and shot, so it re-keys **every** image task. Spliced into `project.yaml`, so comments and key order survive. |
| `project.setKey` ✍ ✓           | `provider` (`gemini`\|`anthropic`), `key` (**secret**) | Store one model provider's API key in `keys/`, the file `resolveKeys` reads when the matching environment variable is unset — and it says so when one is set, because the variable wins. The value goes to that file and nowhere else: the history records `<secret>`, and `keys` is added to `.gitignore` **before** the write, because commit-on-save runs `git commit -A`. Deliberately **not undoable**: an undo point is a git snapshot, and snapshotting a credential is what this command exists to avoid. |
| `agent.run` ✍                  | `input`                           | One agent turn. Mutating: a turn in execute mode writes.   |
| `agent.setMode`                | `mode` (`plan` \| `execute`)      |                                                            |
| `agent.setModel`               | `modelId`                         | Hot-swaps the text model, preserving conversation state.   |
| `agent.setEffort`              | `effort` (`none`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`) | How hard the model thinks; `none` switches thinking off. Every choice is accepted — the menu is what filters by model, and one the model will not take is stepped down at the wire (`resolveEffort`). A model with no such knob keeps the setting and ignores it (`supportsEffort`). |
| `agent.clear`                  | —                                 | Resets the conversation, back to plan mode. The thread it was in stays on disk and stays listed. |
| `agent.threads`                | —                                 | Every saved conversation, newest first, plus which one is open. Header lines only — no transcripts. |
| `agent.newThread`              | —                                 | End the open conversation and start again. The next turn opens a new thread file. |
| `agent.openThread`             | `id`                              | Replay a saved conversation on screen. **Read-only**: the model is not shown it, and the next turn starts a new thread. Returns the whole record as `data`. |
| `agent.renameThread` ✍ ✓       | `id` (default `''`), `title`      | Retitle a saved conversation; an empty `id` renames the open one. Appended as a superseding `title` record — the log stays append-only, and the last one read wins. |
| `upload.files` ✍ ⚠ ✓           | `paths`                           | Copy the author's own documents into `archive/` verbatim, then open a fresh conversation in plan mode asking what to do with them. The archive is outside every directory the agent sweeps, so nothing here reaches `search` or the bible — it is read by name. |
| `upload.pick` ✍ ⚠ ✓            | —                                 | `upload.files` with the native multi-select file chooser in front. Cancelling changes nothing, and the dialog is not a permission: what the command refuses is refused after it too. |
| `interaction.list`             | —                                 | The gestures the app offers — see below.                   |
| `interaction.targets`          | `interaction`, `carried`, `scene`, `asset` | Every target of a gesture, accepted or refused with why. `scene` and `asset` build the state the named gesture is judged against. |
| `workspace.index`              | —                                 | Characters, locations, screenplay files, diagnostics.      |
| `workspace.doctree`            | —                                 | The sidebar tree (story → scenes → shots, characters, locations, wiki, assets by kind) plus per-entity backlinks — see [`document-tree.md`](document-tree.md). |
| `workspace.filetree`           | —                                 | Every file in the workspace as a tree, `.git` and `node_modules` excluded. |
| `workspace.import` ✍ ✓         | —                                 | Convert `screenplay/*.fountain` into `scenes/<id>.md` chunks (`vngen import`). Refuses over existing chunks; the original is moved aside. |
| `workspace.reindex` ✍ ✓        | —                                 | Rebuild `AICONTEXT.generated.md`: the cast, the locations, the story graph, and the bible's table of contents. Refuses over a file it did not write. |
| `workspace.create` ✍ ✓         | `path`, `title`, `newFolder` (default `false`) | Create a project in a new or empty directory — a starter scene, a story bible page, `project.yaml`, a git repo — then open it. `newFolder` puts it in a `slug(title)` folder inside `path`. Refuses a directory with files in it; warns when it sits inside another repo. |
| `workspace.open` ✍ ✓           | `path`                            | Open another project, making it one if it is not yet (`project.yaml` + `git init` + a first commit). Closes the current one — see [`desktop-app.md`](desktop-app.md#which-project-is-open). |
| `workspace.pick` ✍ ✓           | —                                 | `workspace.open` with the native directory chooser in front. Cancelling changes nothing. |
| `workspace.chooseDirectory`    | —                                 | Open the folder chooser and answer with what was chosen, touching nothing — what fills in a `directory` field. |
| `workspace.recent`             | —                                 | The open project and the ones opened before it, most recent first. |
| `view.open`                    | `editor`, `where` (`here`\|`left`\|`right`\|`above`\|`below`\|`elsewhere`, default `here`), `subject` | Shows an editor, in the active pane or in a new pane split off it. `elsewhere` is anywhere but the asking pane. |
| `view.focus`                   | `editor`, `subject`               | Makes the pane already showing an editor the active one.   |
| `view.close`                   | —                                 | Collapses the active pane into its neighbour; the last pane is kept. |
| `view.layout`                  | —                                 | Throws the remembered arrangement away and rebuilds the default one, ignoring the project's layout templates. The escape hatch; the menu offers `view.applyLayout` instead. |
| `view.layouts`                 | —                                 | Every layout template the project has, and which one the window is showing. One a merge left unresolved is listed with the reason rather than left out. |
| `view.applyLayout`             | `name`                            | Rearranges the whole window to one of the project's layout templates. Refuses a missing, unreadable or conflicted one by name. |
| `view.saveLayout` ✍ ↺ ✓        | `name`, `layout` (digest)         | Files the arrangement on screen in the project as `.vnstudio/layouts/<slug>.json`. Saving over one that exists is allowed and is one undo away. |
| `view.resetLayout` ✍ ⚠ ↺ ✓     | `scope` (`shipped`\|`all`, default `shipped`) | Puts the layouts the app ships with back the way they shipped and re-applies the one on screen. `all` also deletes the ones the author saved. |
| `view.palette`                 | `open` (default `true`)           | Opens or closes the command palette.                       |

✍ mutating ⚠ confirm ↺ undoable ✓ declares a precondition

**Only what a snapshot of the worktree can restore is undoable** — the eighteen `story.*` ones plus
`doc.write`, `doc.create`, `doc.rename`, `art.setNotes`, the eight `prompt.*` writers,
`project.setArtStyle`, and the two `view.*` commands that write layout templates. Those last two
are the only undoable commands that are not document edits, and they qualify for exactly the same
reason: a template is an ordinary file in the project, inside the snapshot pathspec, so undo puts
the author's back.
Which panes are open is *not* — that is a window fact remembered per install, which is why
`view.applyLayout` is neither mutating nor undoable. `asset.accept` and `asset.regenerate` write into the generated class instead (a
manifest, a status log), so neither is undoable and neither needs to be: accepting again and
regenerating again are both ordinary acts. `asset.upload` is the same class — bytes and a manifest
row in the base store — and an upload nothing points at costs nothing, so it is not undoable either.
`art.generate` and `art.redraw` are the same shape —
bytes and a manifest row, and undoing an image you paid for by deleting it is not an improvement
(a redraw files a *new* sketch and leaves the original where it is, so there is nothing to undo). `art.promote` writes
across *both* classes at once (a location sheet, a manifest row, and a `done` record in the task
log), which is exactly what a document snapshot cannot restore, so it asks for confirmation instead
of offering undo. `asset.adopt` and `asset.replace` are that same act with the sheet write dropped —
the `done` record `tasks.jsonl` has no un-appending for is reason enough on its own, and superseding
is recoverable the honest way instead, by adopting the earlier hash back. `gate.approve` straddles both data classes — undoing `character.md` would leave
`manifest.json` still marking the asset `accepted` — `story.export`, `story.screenplay` and
`pipeline.run` write only generated output, and `agent.run` owns its own commits, one per approved
plan. `workspace.import` restructures the whole worktree, which is what a shadow snapshot is worst
at, and the `<name>.fountain.imported` it leaves behind is a reversal the author can perform;
`workspace.reindex` writes one derived file, and undoing it means running it again;
`project.setKey` writes a *gitignored* one on purpose — an undo point is a git snapshot, and
snapshotting a credential is the one thing that command exists to avoid;
`upload.files`/`upload.pick` copy bytes in from outside the tree *and* close the conversation that
was open, which `vngen/state` being outside the snapshot means undo could not put back; and
`workspace.open`/`workspace.pick`/`workspace.create` write into a *different* tree than the one a
snapshot covers, so a shadow ref in the old repo could not restore it anyway. The reasoning is in
[`plans/command-undo-redo.md`](plans/command-undo-redo.md).

**`view.*` commands run in the main process** and push a `command:ui` effect that the renderer
applies (`applyView` moves the panes; `openPalette`/`closePalette` for the palette). The
alternative — a second, renderer-side registry — would be one more thing to keep in sync, and
CDP could not reach it.

**An effect names an editor, never a room.** The shell is a mesh of panes, so the whole
vocabulary is one flat list of editors (`apps/desktop/src/shared/editors.ts`, browser-safe and
imported by both halves): `prop.oneOf(EDITOR_IDS, …)` builds the props, the header's View menu
builds its items from the same array, and a stored layout names an area by the same id.
`checkEditorNames()` warns at boot if the renderer has not registered something the command
offers — main cannot see the editor registry, so without it a command would fail only when
someone picked it.

**Main is optimistic and the mesh corrects it.** `view.*` returns its sentence
(`Showing Coverage below.`) without waiting: only the renderer knows how many panes there are.
`applyView` returns a sentence **instead** when the mesh disagrees — `No pane is showing
Inspector.`, `This is the only pane — closing it would leave nothing.` — and the bridge says
that one as an error. The `CommandRecord` still reads `ok`, because nothing was refused; the
command asked for something the layout had no room for.

**`subject` is what the editor should be showing, in that editor's own vocabulary.**
`view.open`/`view.focus` take it and publish it into the selection field the named editor watches —
`ui.docPath` for `wiki`/`documents`, `ui.assetHash` for `asset` — but only when the mesh could show
the editor at all, because a subject set on a pane that never opened would move every _other_
editor on that field instead. Routing per editor rather than always writing `docPath` is what keeps
an asset hash from arriving as a file path the wiki pane would try to `doc.read`. It is
one optional prop rather than a second command, so "show me her sheet" stays one act.

**`where=elsewhere` means *not on top of what I am looking at*.** A pane already showing the editor
is focused; otherwise the biggest non-chrome pane that is not the asking one takes it, and only a
mesh with nowhere else to put it splits the asking pane right. It exists because a click in the
documents tree opens the Asset editor, and a sidebar that replaced itself with the thing it named
would leave the author nothing to click next.

The `story.*` mutators are the same discipline one level down — each is one authorial act, so a
drag in the branch editor or the coverage timeline is one command and one `CommandRecord`, never
a stream of them.

### The `doc.` namespace

`doc.*` is how a surface reads and writes a workspace document as **text**. The story editors
speak in scenes, lines and shots; a character sheet or a wiki note has no such structure, so the
one honest interface to it is its bytes. Full write-up of the editors on top:
[`desktop-app.md`](desktop-app.md#wiki).

**The rule is about bytes, not about documents.** Moving a sheet's *bytes* happens only through
`doc.*`; a **named field** inside one may also be set by a command that round-trips through
`@vn/model`'s `apply*Edit` serializers, which rewrite the key they were given and leave every other
byte — including the author's YAML comments — where it was. `art.setNotes` is the first such
command and `art.promote` the second (it adds one variant to a location's `variants:` list), and both
take the same write path `vnauthor`'s `edit_character`/`edit_location` take, so one
authorial act still has one answer. What stays forbidden is unchanged: `scenes/**` has exactly one
write path and it is `story.*`.

- **Reads are bounded and text-only.** `doc.read` answers `{ path, text, hash, bytes }` for a
  file under the workspace, refusing what is outside it, what is too large, and what is not text.
  It is deliberately **not** `@vn/bible`'s `query` — the bible is reached by ranked excerpt so it
  never floods a context window, and a human editor needs the opposite: the whole file, once.
- **A save is refused by content, never by clock.** `doc.write` takes `seenHash`, the hash
  `doc.read` answered with, and refuses when the file on disk no longer hashes to it. mtime would
  refuse a file that was merely rewritten identically — undo, then save — and would miss a write
  that landed inside the same second. An empty `seenHash` means "I did not read it first", which
  is only allowed when nothing is there.
- **`scenes/**` is refused outright.** A scene has exactly one write path, `session.editScene`,
  and a text overwrite would route around every rule in `@vn/scriptedit`.
- **The document is logged as a digest.** `prop.string(…, { digest: true })` marks a value the
  `CommandRecord` must not carry verbatim: `formatCommand` and the record store
  `<sha256:bcded73b562b+566>` — twelve hex digits and the byte length — so `commands.jsonl` stays
  a log of _acts_ rather than a second copy of the author's prose. The value the command _runs_
  with is untouched. A digested invocation is not re-executable, which is honest: replaying a
  whole-file overwrite out of a log is not something the record should imply it can do.
  **The same flag reaches the form.** `digest` rides through `toCatalog` onto `CatalogProp`, and
  `CommandForm` draws a filled digest prop as a summary line — `21 KB — the arrangement, as the
  renderer serialized it` — rather than a textbox. A text field over bulk content composed by the
  caller is unreadable and one keystroke from corrupting it.
- **Front-matter is the one thing a save reads.** Front-matter that will not parse is refused, and
  so is a save dropping a `type:` tag the file had — that deletes an entity. Front-matter that
  parses but fails the entity schema **saves**, with the diagnostic beside it: an author
  mid-thought must not be trapped by a half-typed field.
- **`doc.create` scaffolds, it does not compose.** A kind and a name become a sheet in its
  conventional home — `characters/<id>/character.md` and `locations/<id>.md` from
  `newCharacterDoc`/`newLocationDoc`, the same scaffolds `vnauthor`'s create tools use; a note is
  `wiki/<id>.md` holding a heading and nothing else, because `wiki/` is free-form and an empty
  front-matter block would be a shape the author has to delete. It refuses over an existing path
  rather than merging into one.

### The `prompt.` namespace

`prompt.*` edits the composition an image is generated from. The prompt itself is still derived —
every builder assembles a `PromptChunk[]` and `renderPrompt` collapses it byte-identically to the
flat string it always produced — so what these commands write is an **override** stored beside the
authored input, and a project that runs none of them keeps every task hash it had. Full statement:
[`plans/chunked-prompts.md`](plans/chunked-prompts.md).

- **One asset, one rung.** Every command takes the asset `hash` and the session resolves it to the
  rung that names the whole picture: the character for a portrait, the outfit entry for a sheet, the
  variant for a plate, the shot for a frame. There is exactly one place an override can be, which is
  what keeps `prompt.info` and the pane from disagreeing.
- **`prompt.info` is the projection both an agent and the pane read.** It answers the derived
  clauses, what the author did to each, and the one string that gets sent — the same `PromptView`
  the Asset editor draws, so nobody has a second opinion about what a picture was asked for.
- **It costs money, on purpose.** Like `art.setNotes` and unlike a scene edit, an override is in the
  prompt, so it re-keys precisely the tasks that rung reaches. `project.setArtStyle` is the extreme
  of the same rule — it reaches every image task — which is why it is the one of these that confirms.
- **A condensation is held, not re-derived.** `prompt.condense` stores the model's rewrite along
  with the chunks it condensed; when those move, the stored text is still what gets sent and the
  pane says so. `prompt.check` measures a hand-written or condensed prompt against the clauses by
  word overlap and reports what it cannot find — a prompt to go and look, never a verdict.
- **`prompt.clear` is the way back, in parts.** `chunks`, `order`, `custom`, `agent` or `all`; what
  is left is what the builders derive. And `mode` alone is not an override — every mode falls back
  to the derived chunks when the shape it names is empty, so clearing the last edit clears the key
  rather than leaving an inert `prompt_override:` in the author's file.
- **A reference attaches to a clause, not to the prompt.** `prompt.addRef` says *this picture is
  evidence for that sentence*, so muting the clause drops its references too — one act, one meaning.
  `ref` is either an asset hash or a **slot address** (`plate:cafe/night`), and the address is the
  same string the pane prints, so what an author reads off the screen is what they can type.
- **A linked reference pins a hash and separately remembers the slot.** The pin is what the task
  hashes over, so approving a new plate upstream never silently re-renders what points at it — it
  **suspends** instead. Suspension is transitive, derived by walking the graph on read (never a
  stored flag), and enumerable in dependency order through `asset.suspended`. `prompt.repin` is how
  it clears, and `regenerate=false` clears it for free.
- **The graph is kept acyclic at write time, over slots rather than hashes.** `prompt.addRef`'s
  precondition refuses a reference that would close a cycle and names the whole path, because a
  cycle here does not error — it starves the scheduler in silence.

### Interactions: the gesture surface

A command answers _what can this app do_. On the direct-manipulation surfaces that leaves out
most of the interface — nothing in `commands.json` says that `story.spliceScene` is normally
reached by dropping a card on a wire, that most wires would refuse that card, or why.

An **interaction** names the gesture and, crucially, offers a **query** rather than a list:
`targets(state, carried)` returns every candidate marked accept (with the invocation the drop
would run) or refuse (with the sentence the command itself would have given). It has no write
path of its own — every gesture terminates in a registered command, and
`InteractionRegistry.verify` fails the build if it names one that does not exist.

The six gestures — the branch editor's `branch.connect`, `branch.splice` and `branch.unwire`, the
coverage timeline's `timeline.cover`, the script's `script.moveLine`, and the asset pane's
`prompt.reorder` — are declared in
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

Four state types now pass through `targets`, so `interaction.targets` builds the state the named
gesture wants: a `timeline.*` gesture is judged against one scene and takes a `scene` prop, a
`prompt.*` gesture is judged against one asset's composition and takes an `asset` prop, a
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

### From the palette, or from a command's own dialog

The `/` palette (`renderer/pathux/palette.ts`) is a **view of the catalog**, not a hand-kept list:
it fetches `command:catalog` once — the live registry, never `dist/commands.json` — and lists what
matches the query. A newly registered command therefore appears in the palette with no palette edit
at all, which is what makes the claim at the top of this document ("the palette … reaches the same
registry") true rather than aspirational.

**Finding a command and filling it in are separate jobs, and only one surface does both.** The
palette is the finder. A caller that already knows which command it wants — a menu entry, the gate
bar, a right-click that needs an argument — calls `openCommandDialog(id, props)` and gets that
command **alone**: its title, what it does, its fields, its verdict, Cancel, and a button labelled
with the command. No search box, no list of eighty-odd other commands to scroll past. Both are
`Screen.popup`s inside the path.ux mesh rather than OS windows, and both host the same
`renderer/pathux/commandform.ts`, so every rule below holds in either.

- **The form is generated from `props`.** Each `CatalogProp` becomes a checkbox (`boolean`), a
  `<select>` (`enum`, options from `values`) or a text/number input; lists edit as comma-separated
  text. `blankProps` seeds it from each prop's `default`, so what is submitted matches what
  `coerceProps` would accept. A command with no props runs straight from its row.
- **A `directory` prop gets a Browse… button, and stays typeable.** The button `exec`s
  `workspace.chooseDirectory` — a non-mutating command with no props that answers with the chosen
  absolute path, or with `Cancelled.` — and writes what came back into the field. The chooser is a
  convenience beside the field, not a gate in front of it, and it is a command rather than an IPC
  channel so CDP and the agent reach the same act. This is what lets `workspace.create` collect a
  folder, a title and a checkbox in one form rather than asking for a path to be typed.
- **A toggle does not rebuild the form.** A `boolean` is a `check-x` carrying its own state, so
  flipping it rechecks and redraws nothing else — a form rebuilt under a widget costs that widget
  the focus it just took.
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
- **The verdict redraws alone.** It is its own strip inside the form, because a recheck lands on
  every keystroke and rebuilding the whole form would tear out the input being typed into — a
  field that survives one character and then vanishes is a command that cannot be given an
  argument at all.
- **A form opened on a command lands in its first text field.** In the palette, focus is the
  search box's only when the author is searching; a dialog has no search box at all. Someone who
  picked the command off a menu is here to fill its first blank, and typing that path into a filter
  instead is indistinguishable from the entry not working.
- **Highlighting a row is not navigating to it.** Focus and hover only arm the check, so the
  verdict is there to read before the click that opens the form or runs the command.
- **Execution is `command:exec` with `source: 'ui'`** — the same stack `window.vn.exec` and CDP
  reach, so provenance, history and undo are identical whoever ran it. When a `mutating` command
  lands, the shell re-reads the workspace index and remounts the room, exactly as it does for
  undo: those are writes a room did not make itself.

The pure half — filtering, blank values, field coercion — is `renderer/rules/catalog.ts` with a
`tests/` sibling; `commandform.ts`, `palette.ts` and `dialog.ts` stay thin rendering.

### From a right-click

The document tree's context menus are the palette's argument made direct: a **third view of the
catalog**, and the one where `check` earns its keep. An entry is an _invocation_ — a command id and
its props — not a callback, and the menu resolves it twice: through `command:check` before it is
drawn, and through `command:exec` when it is clicked. Three bespoke `contextmenu` handlers that
call `exec` and hope are exactly how a surface starts offering what the command would refuse.

- **A refusal is shown, with its reason, not hidden.** path.ux's menu template has no per-item
  disabled state, so a refused entry draws as `⃠ Accept` and clicking it reports the command's own
  sentence in the message line instead of executing. Hiding it would leave the author guessing why
  the option they remember is gone; the sentence is the whole value of `check`, and it should reach
  the surface that asked.
- **`undeclared` is not permission.** A command with no check draws enabled — the same three-state
  contract — but nothing synthesizes an `accept` for it. Absence of a check is absence of
  information, in a menu exactly as everywhere else.
- **Checks are awaited before the menu opens.** `startMenu` is synchronous, so the handler gathers
  every verdict first. They are read-only previews over state main already holds; if one ever
  became slow enough to notice, the fix is that check, not a menu that lies while it loads.
- **An entry needing an argument opens that command's dialog pre-filled**, and so does every
  `confirm: true` one — a form is where a command's arguments are typed and where it says what it
  is about to do, and the author has already found the command by right-clicking, so they get the
  one command rather than the finder. Such an entry is deliberately not checked: its props are
  incomplete by design, so the refusal it would earn is about the blank the author is on their way
  to filling in.

Which entries a node offers is a pure table in `renderer/pathux/doctree.ts`; the verdict-to-item
resolution is `renderer/pathux/contextmenu.ts`, pure and node-testable because it imports no
`pathux`; `renderer/pathux/showmenu.ts` is the half that opens the menu, verified live over CDP
like every other surface. The tables are in
[`document-tree.md`](document-tree.md#right-click-menus).

**The menu bar is not this.** `header.ts`'s app and View menus are built with the bar, synchronously,
and half their entries are shell acts rather than commands — Quit, Split Area, Undo, Plan ⇄ Execute
reach no registry because there is none to reach. So those menus run and report: `exec` says the
refusal after the click instead of drawing it before, which is the same sentence one beat later. The
rule they do keep is the right-click's: an entry opens the command's own dialog when it has
something to collect (`workspace.create`'s folder, title and checkbox) or something to confirm
(`pipeline.run`, `upload.pick`), and runs outright when it has neither (`workspace.pick`,
`workspace.reindex`) — an empty form is friction, not a safeguard. **Command Palette…** is the one
entry that opens the finder, because finding is what it is for.

### From DevTools or CDP

The preload exposes a second bridge, `window.vn`, over that same IPC:

```js
await vn.catalog();
await vn.exec("view.open(editor='timeline' where='below')"); // DSL form
await vn.exec('gate.approve', { characterId: 'aiko', hash: '9e0a1b' }); // id + props form
await vn.check('gate.approve', { characterId: 'aiko', hash: '9e0a1b' }); // would it run?
await vn.history(5);
```

It lives in the preload rather than in React so that it exists before the app mounts, which
matters for scripting.

**CDP is opt-in in the app, and on by default in the developer launchers.** Setting
`VN_CDP_PORT` makes the app open Chrome's own remote-debugging port, bound to `127.0.0.1`. The
port grants full control of the renderer, so `src/main/index.ts` never opens one unless asked
— and a packaged app is asked by nobody. The two ways a developer starts the app default it to
`9222` instead: `scripts/dev.desktop.mjs` for the live loop, and `scripts/vndesktop.mjs`
(`pnpm vndesktop`) for the built app. The switch can only be appended before
`app.whenReady()`, so a port not opened at launch cannot be opened later — which is why the
entry point you reach for when you intend to drive the app from `vn-cdp.mjs` opens it up front.
Both announce the port on stdout rather than opening it in silence, and `VN_CDP_PORT=` (empty)
is the opt-out. Using Chrome's debugger rather than a new socket means there is no second, less
guarded entry point to secure, and Playwright/Puppeteer/`curl` work out of the box.

`scripts/vn-cdp.mjs` is the driver — it fetches `/json/list`, picks the page target, and
evaluates against `window.vn`:

```sh
node scripts/vn-cdp.mjs "workspace.index()"
node scripts/vn-cdp.mjs "view.open(editor=play)"   # visibly opens a pane
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
`set_outfit` is the same arrangement over `story.setSceneOutfit` / `story.setOutfit` — one tool
because the two differ by a word in the author's sentence, and the same rules underneath, which is
also why the marker write path moved out of `session.editBranches` and into `@vn/scriptedit`'s
`planMarkerEdit` / `applyMarkerPlan`: the agent may not import an app.
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
  "id": "view.focus",
  "title": "Focus an editor",
  "mutating": false,
  "confirm": false,
  "undoable": false,
  "checkable": false,
  "props": [{ "name": "editor", "kind": "enum", "required": true, "values": ["branches", "script", "…"] }],
  "usage": "view.focus(editor='branches')",
  "schema": {
    "type": "object",
    "properties": { "editor": { "type": "string", "enum": ["branches", "script", "…"], "description": "…" } },
    "required": ["editor"],
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
