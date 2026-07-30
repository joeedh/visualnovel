# Interaction model

Status: **shipped.** Every step below is done, and both items this plan left for later were
taken by [`preconditions-and-timeline-interaction.md`](preconditions-and-timeline-interaction.md)
— see [Next](#next-not-done-here). The layer now carries five gestures, not the three it was
prototyped against: `branch.connect`, `branch.splice`, `branch.unwire`, `timeline.cover` and
`script.moveLine`.

<!-- toc -->

## Why

The command system answers _what can this app do_. It does not answer _how a person does it_,
and for the two direct-manipulation surfaces (the branch editor, the coverage timeline) that
gap is most of the interface. An agent reading `commands.json` sees `story.spliceScene`; it
cannot see that the human path is grab-a-card → hover-a-wire → drop, that most wires would
refuse that card, or _why_.

Worse, the reasons are the interesting part. `spliceScene` refuses a scene that already forks
because the spliced edge would never be taken; `setCoverage` refuses a claim that would leave a
neighbouring shot covering nothing. Those sentences exist in `branchops.ts` and `coverage.ts`
and are shown to a human mid-drag, but they are only reachable by _attempting_ the command.

The model here makes them reachable **before** acting, without inventing a second truth about
what the app can do.

## The shape

An **interaction** is a transient gesture whose only terminal is a command that already exists
in the registry. It adds three things and no write path:

```ts
interface Interaction<State, Carried> {
  id, title, description;
  grab: string; // what the user picks up, in words
  carries: string; // what is being carried
  accepts: string; // what a target is
  commands: string[]; // terminal command ids — must all exist in the registry
  cancellable: boolean; // abandoning emits nothing
  targets(state: State, carried: Carried): Verdict[];
}

type Verdict =
  | { target: string; accept: true; note: string; invoke: { id; props } }
  | { target: string; accept: false; reason: string };
```

Four rules hold it honest:

1. **`targets` is a query, not a list.** Validity is state-dependent and the refusal reason is
   the payload. A static "valid drop targets are X" would rot on the first rule change.
2. **The command registry stays the only authority on mutation.** An interaction names
   terminal command ids and returns invocations; it never writes. `InteractionRegistry.verify`
   throws if an interaction names a command the app does not have, so the two cannot drift.
3. **`targets` is the same function the drop calls.** Not a description of it. This is the rule
   `branchops.ts` and `intent.ts` already followed by hand — "the refusal shown mid-drag is the
   refusal that would happen" — now named and reused instead of re-established per surface.
4. **Terminal-executable; states are explanatory.** Nothing here steps a pointer. An agent that
   wants the outcome runs the command; the gesture model exists so it can ask _which_ and _why
   not_ first, and so the app can explain itself. A model that had to emit pointer moves would
   fight the relayout tween, which is deliberately animated.

### What is not an interaction

Inline label editing (`relabel` in the branch editor) commits `story.setChoice` directly from a
text input. There is no carried object and no enumerable target set, so declaring it would
produce an entry whose `targets` is a formality. Interactions are for gestures with a
**choosable target**; everything else is already a command.

## Layout

| File                                            | Role                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/commands/src/interaction.ts`          | The framework: `Interaction`, `Verdict`, registry, `can`, catalog, `formatVerdicts`. Pure. |
| `apps/desktop/src/shared/interactions.ts`       | The branch editor's three interactions + the per-target decisions they run.                |
| `apps/desktop/src/main/commands/interaction.ts` | `interaction.list` / `interaction.targets` — the agent- and CDP-facing surface.            |

`shared/` rather than `main/` for the same reason `branchops.ts` is there: the renderer runs
these exact functions mid-drag. That is also why `renderer/rooms/studio/branch/intent.ts` was
**moved** into it rather than wrapped — main needs the decision-to-invocation mapping too, and
the renderer cannot be imported from `src/`.

## Prototype: the branch editor

Three interactions over one `BranchState` (`{ scenes: SceneMap; edges: StoryEdge[] }`, built
from a `StoryGraph` by `branchState`):

| id               | grab                | carries         | accepts        | commands                        |
| ---------------- | ------------------- | --------------- | -------------- | ------------------------------- |
| `branch.connect` | a card's ⌄ handle   | the source scene | any scene card | `story.setNext` `story.setChoice` |
| `branch.splice`  | a scene card        | the scene       | any wire       | `story.spliceScene`             |
| `branch.unwire`  | a wire's arrowhead  | the edge        | empty canvas   | `story.removeChoice` `story.setNext` |

`branch.splice` is the one with the rich refusals, and it is now the single source of the
verdict overlay: `BranchEditor`'s mid-drag `verdicts` map is built by calling
`branchSplice.targets(...)`, the same call `interaction.targets` makes in main.

From an agent or CDP, against the seeded sample workspace:

```sh
node scripts/vn-cdp.mjs "interaction.targets(interaction='branch.splice' carried='arrival')"
```

```
0 of 5 target(s) would accept arrival.
refuse · arrival#choice:0 · arrival cannot be spliced into its own edge.
refuse · arrival#choice:1 · arrival cannot be spliced into its own edge.
refuse · greet#next · arrival already forks into 2 choice(s), and a scene's next is only
  followed when it has none — the spliced edge would never be taken.
…
```

Those sentences come from `spliceScene` itself. Nothing was attempted to get them, and an
accepted verdict's `invoke` runs as-is:

```sh
node scripts/vn-cdp.mjs "story.spliceScene(scene='ending' from='greet')"
#  Spliced ending into greet → rooftop.
node scripts/vn-cdp.mjs --raw "window.vn.undo()"
#  Undid story.spliceScene(scene='ending' from='greet' edge=-1).
```

## Steps

1. `packages/commands/src/interaction.ts` + tests; export from the package index. ✅
2. Move `scenesOf`/`edgeTarget` out of `renderer/.../graph.ts` and `intent.ts` wholesale into
   `apps/desktop/src/shared/interactions.ts`; move `intent.test.ts` alongside. ✅
3. Declare the three interactions there; `createBranchInteractions()`. ✅
4. `interaction.list` / `interaction.targets` commands; register; `verify` against the command
   registry in the catalog entry and the registry test. ✅
5. `toCatalog(registry, source, interactions?)` — additive `interactions` field on the
   catalog, so `commands.json` carries the gesture surface too. ✅
6. `BranchEditor` builds its verdict overlay from `branchSplice.targets`. ✅
7. Docs: this file, `docs/command-system.md`, `CLAUDE.md`. ✅

## Next (not done here)

Both of these shipped in
[`preconditions-and-timeline-interaction.md`](preconditions-and-timeline-interaction.md), which was
written from this section.

- ~~**The coverage timeline.**~~ Shipped as `timeline.cover` (not `timeline.setCoverage` — the
  gesture is named for what the author does, and it terminates in `story.setCoverage`). The
  framework did generalise over the second surface: `targets` grew a per-gesture state, since a
  timeline gesture is judged against one scene and a branch gesture against the whole graph.
  `script.moveLine` was the third consumer and needed no new decision.
- ~~**Preconditions on plain commands.**~~ Shipped as `stack.check(id, props)`, with three states
  rather than a boolean: `accept` | `refuse` | `undeclared`, because absence of a check is not
  permission. It never gates `exec`, which re-decides for itself.
