# Preconditions, and the timeline's gesture

Status: **shipped.** Follows [`interaction-model.md`](interaction-model.md), whose "Next (not
done here)" section named both halves. As-shipped deviations are in
[As shipped](#as-shipped) at the end; everything above it is the plan as written.

<!-- toc -->

## Why

The interaction layer shipped against one surface. Two things follow from that:

- **It has never been generalised.** `BranchState` is the only state type that has ever been
  passed through `targets`, and every carried object has been a scene id. Whether the shape is
  right or merely fitted to the branch editor is currently unknowable. The coverage timeline is
  the other direct-manipulation surface and it is deliberately unlike the first — the carried
  thing is a *handle on a shot*, not an object, and the targets are *rows of script*.
- **It only covers gestures.** `interaction.targets` answers "what would happen if I dropped
  this there, and why not" for two surfaces. For every other command the only way to learn that
  `pipeline.run` has no key, or that `gate.approve` was handed a hash that character never
  produced, is to run it. For a mutating command that is a bad way to find out.

Both halves are the same idea — **make the refusal reachable before acting** — and neither
introduces a second authority on what the app can do.

## Part 1 — `timeline.cover`

The timeline's one gesture: grab a bracket's start or end handle, drag it up or down the
script, release. `src/shared/coverage.ts` already holds the rule, and `Timeline.tsx` already
runs it mid-drag; what is missing is the enumeration — *every* row judged, not just the one
under the pointer.

### The move

`resolveDrag` (which lines the drop asks for) and `spansFor` (the geometry it resolves
against) live in `renderer/rooms/floor/timeline/coverage.ts`, which main cannot import. They
move into `src/shared/coverage.ts` beside the rule they feed — the same move `intent.ts` made,
for the same reason.

`previewOf` and `DragPreview` **stay in the renderer**: they are ghost geometry for drawing and
main has no use for them. `spansFor` moves whole, lane assignment included, because `previewOf`
reads the `lane` it assigned; splitting the lane pass out would give the renderer a second
traversal that could disagree with main about how many columns there are. `runsOf` is exported
from shared for `previewOf` to keep using.

### The shape

| | |
| --- | --- |
| id | `timeline.cover` |
| grab | a shot bracket's start or end handle |
| carries | the handle — `<shotId>#start` or `<shotId>#end` |
| accepts | any line of the scene |
| commands | `story.setCoverage` |
| state | `{ lines: CoverageLine[]; shots: CoverShot[] }` — exactly `SceneCoverage` minus `decomposed` |
| targets | one verdict per line id, in screenplay order |

Each target is `resolveDrag(...)` for that row, fed through `setCoverage` — the pure rule, the
one the command runs. A row the drop would not change is **not** a refusal and not an accept:
it is dropped from the list, because "nothing happens" is what release already does silently
and a verdict saying so would be noise on most of the strip.

### Three findings to write into the framework

The point of a second surface is what it breaks. Three things it does:

1. **The carried token is always a string.** `interaction.targets`, the DSL and CDP can carry
   nothing else, so an interaction whose carried object has structure must encode it —
   `arrival__beat1#end`. Rather than leave every caller to guess, **drop the `Carried` type
   parameter** from `Interaction`/`can`/`defineInteraction` and make it `carried: string`
   throughout. An interaction that needs structure parses it in `targets` and refuses a
   malformed token. The alternative — keeping the parameter and adding a `parse(s): Carried`
   member — buys a type at the cost of a second thing every interaction must declare, and the
   wire is a string either way.
2. **A carried token that names nothing refuses; it does not return `[]`.** `branch.unwire`
   already does this by hand (`No edge "…"`). An empty list means *this gesture has no targets
   in this state*, which is a different fact from *you asked about something that is not
   there*, and an agent reading `0 of 0` cannot tell them apart. State the rule and make
   `timeline.cover` follow it.
3. **`targets` is synchronous and pure, and must stay that way.** It runs per pointer move.
   This is the line that stops Part 2 from being folded into it — see below.

### What the renderer gets for free

`Timeline.tsx` currently calls `setCoverage` once per pointer move, for the row under the
cursor. With the interaction it calls `timelineCover.targets` **once at grab** — state and
carried are both fixed for the whole gesture — and indexes the result by line id. Fewer
evaluations, and the notice and the ghost are then read from the same verdict list that
`interaction.targets` would hand an agent.

## Part 2 — preconditions on plain commands

### The shape

An optional member on `Command`:

```ts
type CheckResult = { ok: true; note: string } | { ok: false; reason: string };

interface Command<M, Host> {
  …
  /** Would this run? A report about now, never a promise. Pure-ish: reads, never writes. */
  check?(props: PropsOf<M>, ctx: CommandContext<Host>): Promise<CheckResult>;
}
```

and on the stack:

```ts
stack.check(id, props): Promise<{ state: 'accept' | 'refuse' | 'undeclared'; message: string }>
```

`check` coerces props through `coerceProps` first, so a bad prop is reported exactly as `exec`
would report it rather than reaching a hand-written check that has to re-validate.

### Four rules

1. **Absence is `undeclared`, never `accept`.** A command with no `check` returns a third state
   saying so. Collapsing that into "would succeed" is the one way this feature can lie, and it
   would lie by default, on every command nobody got to.
2. **A check is a report about now.** Between check and exec the workspace can move; `run`
   re-decides and stays the only authority. `check` never gates `exec` — nothing calls it on
   the way in.
3. **A check reads and does not write.** Enforced by review, not by types, but the ones below
   are all a load plus a pure decision.
4. **Only mutating commands declare one.** A read has nothing to prevent, and a `check` on one
   would be a second way to ask the same question. A test asserts it.

### Which commands, and what their check is

| Command | Check |
| --- | --- |
| `story.setChoice` `removeChoice` `setNext` `spliceScene` | the `branchops` decision against a freshly read `scenesOf(storyGraph())`, discarded |
| `story.setCoverage` | `setCoverage` against `sceneCoverage(scene)`, discarded |
| `story.export` | is there a model to project |
| `gate.approve` | does the character exist, is `hash` among its candidates, is it already approved |
| `pipeline.run` | is anything plannable; and for `mock: false`, do the keys resolve — the check worth having, since the alternative is finding out by spending |

The five `story.*` commands are nearly free: they already split decision from write, which is
what `check` needs and what the rest of the app does not have. `gate.approve` and
`pipeline.run` each need a small read added to `WorkspaceSession`.

### The surface

- **`command.check`**, a new non-mutating command, one prop: `invocation`, a DSL line. Parsed
  by the existing `parseCommand`, so an agent asks with the same string it would execute:

  ```sh
  node scripts/vn-cdp.mjs "command.check(invocation=\"story.setNext(scene='greet' goto='greet')\")"
  ```

- **`checkable: boolean`** on each catalog entry, so a reader knows which commands can be asked
  before asking. Additive, like `interactions` was.
- `window.vn.check(id, props)` beside `exec`, for DevTools.

### Why this is not the same function as `targets`

An interaction's verdict list is conceptually `check` fanned out over targets, and folding them
together is tempting. It does not work: `targets` is synchronous and pure because it runs on
every pointer move, while `check` is async and reaches the session. Making `targets` async
would put an await inside a drag; making `check` sync would forbid it from reading anything.
They stay two functions that answer the same question at different costs, and the honesty rule
they share — the refusal you are shown is the refusal that would happen — is upheld by both
delegating to the same pure decision.

## Steps

1. Move `spansFor`/`resolveDrag`/`runsOf` into `src/shared/coverage.ts`; move their tests
   alongside; leave `previewOf` in the renderer. Gates green with no behaviour change.
2. Drop the `Carried` type parameter from the interaction framework; update `branch.*` and the
   framework tests. Write findings 2 and 3 into `interaction.ts`'s contract docs.
3. Declare `timeline.cover` in `src/shared/interactions.ts` (or a sibling if that file is
   getting long); register it; extend `INTERACTION_IDS`.
4. `Timeline.tsx` builds its notice and ghost from `timelineCover.targets`, evaluated once per
   grab.
5. `check` on `Command`; `CommandStack.check`; `undeclared` as a first-class state; tests.
6. Declare the eight checks in the table above; add the two `WorkspaceSession` reads.
7. `command.check` command, `checkable` in the catalog, `window.vn.check`.
8. Verify live over CDP against the seeded workspace: a refused coverage drop, a refused
   `setNext`, and `pipeline.run(mock=false)` with no key present.
9. Docs: this file, `docs/command-system.md`, `docs/index.md`, `CLAUDE.md`.

Steps 1–4 and 5–7 are independent; either can land first. Step 8 wants both.

## As shipped

Steps 1–9 landed as written, with five things the plan did not anticipate.

- **`CoverState` carries `sceneId`.** The plan's state shape — `SceneCoverage` minus
  `decomposed` — cannot build the invocation a verdict has to hand back: `story.setCoverage`
  takes `scene`, and nothing else in the state names it. So the state is
  `{ sceneId, lines, shots }`.
- **`interaction.targets` gained a `scene` prop.** With two state types in one registry, the
  command has to build the state the named gesture wants. It dispatches on the namespace: a
  `timeline.*` gesture is judged against one scene and refuses without `scene=<id>`; everything
  else gets the branch state, as before. `InteractionRegistry` widened from
  `InteractionRegistry<BranchState>` to the default `State = any` for the same reason, and the
  factory is now `createDesktopInteractions()`.
- **`UNRESOLVED` is a real export.** Finding 2 says a carried token that names nothing refuses,
  which needs a target to name. `branch.unwire` had been hanging that refusal on `CANVAS` — a
  genuine target — and `timeline.cover` has no equivalent, so `@vn/commands` now exports an
  `UNRESOLVED` sentinel and the doc points at it.
- **The timeline still calls `resolveDrag` per pointer move — for geometry only.** A `Verdict`
  carries a message and an invocation, not the span the ghost is drawn from, and the ghost is
  drawn for a *refused* drop too. So the verdict comes from the once-per-grab `targets` map and
  the geometry from `resolveDrag`, which is the same pure function the verdict went through.
- **`pipeline.run`'s check refuses only on keys.** "Is anything plannable" cannot be answered
  without planning: `planTasks` mutates the graph and can issue an LLM decomposition call, so a
  check that ran it would write, breaking rule 3. And under incremental planning "nothing
  pending" does not mean "nothing to do" — most of a run's work becomes plannable only after an
  earlier wave finishes, so a refusal on that count would be wrong. The check therefore reports
  already-pending work and the gate as its accept note, and reserves refusal for the half that
  is both certain and expensive to discover by running: `mock: false` with no resolvable key.
  `session.runPreconditions` is the read; it surfaces `resolveKeys`'s message, which by contract
  names the source and never a value.
- **`gate.approve` does not refuse an already-approved character.** The plan's table lists "is it
  already approved" as a check input, and it is — but as a *note*, not a refusal: approving a
  second candidate is how an author changes their mind, and the command supports it.
- **`agent.run` is the one mutating command with no check.** What it would do is decided by a
  model, so there is no state this process can read that answers the question. The test that
  pins rule 4 pins the list, so this is a visible exception rather than an omission.

Verified live over CDP against the seeded workspace (Step 8), all three refusals as written:
the coverage drop that would empty `arrival__establishing`, `story.setNext` against a scene that
does not exist and against a scene with no `next` to clear, and `pipeline.run(mock=false)` with
no key — plus `story.graph` reporting `undeclared`.

## Then: what to do about surfacing gestures in the UI

The third gap is that **nothing in the app shows a human that these gestures exist.** The
palette lists commands; an author has no way to discover that a card can be dropped on a wire,
or that a bracket's edge drags. The catalog now carries `grab`/`carries`/`accepts` — three
strings written in plain English, read by nothing.

**Recommendation: do not build a gesture browser. Make the palette teach, and stop there.**

The reasoning is that a list of gestures is the weakest possible form of this. It is read once,
away from the surface it describes, at the moment the author is least able to act on it — and
it would be a fourth place the interface is described, after the code, the catalog and the two
mid-drag overlays. Discoverability problems are not solved by an index of the thing you failed
to discover.

What is worth doing is small and in situ:

- **The palette's `story.*` and `timeline` entries name their gesture.** One line under the
  description — "or: drop a scene card on a wire" — read from `grab` on whichever interaction
  lists that command as a terminal. No new data, no new surface, and it appears exactly where
  someone is already looking for the capability.
- **The refusal already teaches.** Both surfaces show the reason mid-drag, which is the moment
  it can be acted on. That is the discoverability mechanism this app actually has, and it is
  better than a list.

What would change the recommendation: a third and fourth direct-manipulation surface. At two
gestures per surface across four surfaces the case for an index gets real, and the catalog is
already shaped to serve one. At three gestures total it is not.
