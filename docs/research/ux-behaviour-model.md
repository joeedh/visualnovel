# A UX behaviour model for the desktop app

This document is research. Nothing here is planned work. The companion report
[`formalizing-the-rules-modules.md`](formalizing-the-rules-modules.md) covers the refactor
of `apps/desktop/renderer/rules/` that this one depends on.

What would it take to describe every UX behaviour of the desktop app (buttons, context
menus, tree rows, the gen-graph canvas, drags, keyboard shortcuts) in one machine-readable
model, with each behaviour traced to the code that implements it, so that an LLM can query
it and a linter can check it?

This report argues for a guarded affordance model derived headlessly from the rule
modules. The existing CDP sweep stays in place as the integration test that ties the
derived model to the live widgets. The report argues against three alternatives: a
hand-written model, a model measured only at runtime, and an enumerated state machine.

<!-- toc -->

- [What exists today](#what-exists-today)
- [What is missing](#what-is-missing)
- [Three targets, and why only one fits](#three-targets-and-why-only-one-fits)
    - [Not an enumerated state machine](#not-an-enumerated-state-machine)
    - [Not measured only at runtime](#not-measured-only-at-runtime)
    - [Not hand-written](#not-hand-written)
    - [Derived from the rule modules](#derived-from-the-rule-modules)
- [The proposed shape](#the-proposed-shape)
    - [Three tiers](#three-tiers)
    - [The record](#the-record)
    - [Pseudo-commands](#pseudo-commands)
    - [Traceability](#traceability)
    - [Effects on commands](#effects-on-commands)
    - [Situations](#situations)
- [The two use cases](#the-two-use-cases)
    - [Querying by an LLM](#querying-by-an-llm)
    - [Linting](#linting)
- [Costs](#costs)
- [Decisions a plan would settle](#decisions-a-plan-would-settle)
- [See also](#see-also)

<!-- tocstop -->

## What exists today

The repo already has most of the pieces, spread over the command system and the
guided-tour layer.

- **Every desktop action is a command.** Each command is registered with typed props, a
  string DSL (`namespace.command(a='x' b=1)`) and one JSON catalog, projected by
  `toCatalog` and written to `apps/desktop/dist/commands.json` at build time.
  [`../reference/command-system.md#the-catalog`](../reference/command-system.md#the-catalog).
- **Guards are declared ahead of the run.** A mutating command declares its refusal before
  it runs, through `stack.check`. `Interaction.targets` evaluates a drag's targets without
  arming anything. Both report whether the action can happen now, and neither performs it.
- **Anchors map controls to commands.** `act()` in `renderer/pathux/tour/anchors.ts` takes
  one `Offer` (the command id and props a control runs, or the reason it is disabled),
  sets the click handler from it and records the anchor from it. The record and the
  handler come from one object, so they cannot drift.
  [`../reference/guided-tours.md`](../reference/guided-tours.md).
- **The sweep already generates the model at runtime.** `scripts/sweep-anchors.mjs`
  connects to a running app over CDP, opens each editor, dumps the anchors and writes
  `apps/desktop/anchors.json`, stamped with the git sha, the project and the selection it
  was measured under. Each record holds a command id, the editor that drew the control,
  and the state it was drawn in.
- **Two cross-checks run on the sweep.** One compares enabled state against `stack.check`,
  and the other compares the recorded rect against a hit test. The enabled-state check has
  found a real bug (the branch editor drawing `delete` enabled for the entry scene). See
  [`../reference/guided-tours.md#cross-checks`](../reference/guided-tours.md#cross-checks).
- **One check blocks in CI.** `anchorcoverage.test.ts` reads the committed file and fails
  if a record names a command that no longer exists, if the command list drifts from the
  live registry, or if the anchored count drops below `FLOOR` (40).
- **Tours are the only way to compose actions.** A `Tour` is a linear list of steps of
  four kinds (`command`, `input`, `select`, `gesture`), validated by `checkTour` against
  the registry. Macros over the palette were researched and not built
  ([`user-authored-macros-and-custom-actions.md`](user-authored-macros-and-custom-actions.md)).

The sweep covered the following at the time of writing:

| Registry commands | Commands with a control found | Records |
| ----------------- | ----------------------------- | ------- |
| 170               | 49                            | 137     |

## What is missing

The anchor layer falls short of the goal in four places.

- **Vocabulary.** An anchor names a command. Behaviours that never reach main have no
  name: publishing a selection into a `ui.*` field (partly covered by `publishes` on item
  anchors), expanding a tree node, opening a context menu or a popup, scrolling, focusing
  a pane, starting or accepting a drag, a keyboard shortcut.
- **Context menus.** The chrome's menu code (`chrome/contextmenu.ts`,
  `chrome/showmenu.ts`) does not register anchors. The document tree's menu is derived
  from `menuFor`, which is plain data, so `window.__vnAnchors.tree()` can enumerate it
  without opening a pane. The node, branch, timeline, script and asset editors build their
  own entries, and the map does not list those entries.
- **State coverage.** A runtime sweep covers only the controls that were drawn. Many
  controls are drawn only with a subject selected, a node picked, a thread open or a run
  in flight. The sweep visits one project under one selection, so only 49 of 170 commands
  have a control on file.
- **Traceability.** An `AnchorDump` carries `key`, `id`, `props`, `supplies`, `form`,
  `enabled`, `reason`, `editor`, `via`, `nodeId` and `rect`. It does not record where in
  the source the control or its rule lives.

## Three targets, and why only one fits

### Not an enumerated state machine

The app's UX state combines the pane mesh, the active pane, the `ui.*` selection fields
and the project's document state. An exhaustive walk of that state grows combinatorially
large before it yields anything informative, and any walk executes transitions, so a
mutating command writes to the project.

Each control depends on a guard over a few state variables, and the repo already expresses
guards as declarations. So describe each control as a guard plus a list of effects, which
gives a guarded transition system. That form answers the LLM's question of when the author
can do X and what happens, and it answers the linter's question as well, without
enumerating states. A reachability question, if one is ever requested, becomes a symbolic
walk over guards on view and selection state, and that walk does not touch main.

### Not measured only at runtime

The sweep works well as an integration test, but it should not be the only source, because
it covers only the states the sweep happened to draw. Reading transitions from a live app
also requires either executing mutating commands or guessing at them.

### Not hand-written

A hand-written model reintroduces the drift the anchor layer was built to eliminate. Every
disagreement between the model and the app raises the question of which one is stale, and
a reviewer cannot answer that question from the diff.

### Derived from the rule modules

Six modules under `renderer/rules/` already compute `Offer` values from state as pure
functions with node tests, and the state each reads is a shared IPC view type
(`PromptView`, `AssetInfo`, `Convo`, `ReportStateView`). Running those modules over a set
of synthetic states produces the model with no DOM, no main process and no side effects.
Because the inputs are chosen, the output is enumerable. The editor draws from the same
rule module, so every control the model describes exists in the editor.

The anchor map already does this for the document tree, where the menu is data that the
map enumerates without a pane. The companion report describes what the rule modules need
before every editor can be read this way.

## The proposed shape

### Three tiers

| Tier     | Source                                      | Runs where        | Executes commands |
| -------- | ------------------------------------------- | ----------------- | ----------------- |
| Derived  | rule modules over synthetic states          | CI, headless      | no                |
| Measured | CDP sweep of the built app                  | by hand, advisory | no                |
| Executed | mutating commands on a mock scratch project | CI or by hand     | yes, rolled back  |

- **Derived** — the model is generated in CI from fixtures and committed, or generated on
  demand. Neither form is ever edited by hand.
- **Measured**: runs the existing sweep and adds one comparison. Every derived offer has
  an anchor on screen under its situation, and every anchor has a derived offer. That
  comparison catches the two drifts the derivation cannot see on its own: a control drawn
  without going through its rule, and a rule with no control. The existing checks stay,
  because enabled state against `stack.check` and the ring hit test can only be measured
  live.
- **Executed** is the only tier where mutating commands run. `--mock` writes no assets and
  needs no keys, `@vn/testkit` runs real projects on disk through the real scheduler with
  mock providers, and undo takes a content-addressed snapshot of the document tree. A test
  runs each mutating command in a throwaway project, diffs the snapshot, and fails when
  the diff covers anything outside what the command declared it affects.

### The record

The derived tier produces one record per control, and the measured tier confirms the
record:

```jsonc
{
    "key"      : "cmd:gate.approve", // the anchor key, as today
    "editor"   : "asset", // AnchorHome
    "situation": "portrait:unapproved", // which fixture produced it
    "offer": {
        "ok"      : true,
        "id"      : "gate.approve", // a command id or a pseudo-command id
        "props"   : { "characterId": "aiko", "hash": "…" },
        "supplies": [], // props typed at the widget
        "label"   : "Approve",
        "tooltip" : "Approve this portrait through the gate.",
    },
    "effects"  : ["command:gate.approve"], // what a click does, in order
    "from": {
        "rule": "assetview.approveAction", // the rule function that produced the offer
        "file": "apps/desktop/renderer/rules/assetview.ts",
        "line": 59,
    },
    "measured": {
        // filled by the sweep, absent in the derived file
        "gitSha": "…",
        "via"   : "dom",
        "rect": { "left": 0, "top": 0, "right": 0, "bottom": 0, "width": 0, "height": 0 },
        "agrees": true, // enabled state matched stack.check
    },
}
```

A refused control keeps the same shape with `ok: false` and a `reason`, exactly as `Offer`
does today. The `situation` field replaces the sweep's single top-level `under`, because a
model covering many states needs the state on each record.

### Pseudo-commands

The phrase covers two different things, and each needs a different treatment.

- **Showing an editor is done by a command.** `view.open` and `view.focus` run in main and
  push a `command:ui` effect naming an editor. They appear in the model as ordinary
  invocations. `panes.ts`
  ([`../reference/swappingPaneEditors.md`](../reference/swappingPaneEditors.md)) holds the
  rule that an editor lands in the sparing pane and never covers the pane the author is
  navigating from, and the linter can check that rule once effects are recorded.
- **Renderer-local behaviours are missing.** These become a closed, enumerated vocabulary
  of effect ids, registered in the same catalog as commands with a flag marking them as
  pseudo, so a reader sees one file and a `checkTour`-style validation can reject an
  unknown id. The initial list is:

    | Pseudo-command | Effect                                             |
    | -------------- | -------------------------------------------------- |
    | `ui.publish`   | Sets a `ui.*` field (a selection).                 |
    | `tree.expand`  | Expands or collapses a document-tree node.         |
    | `menu.open`    | Opens a context menu for a subject.                |
    | `popup.open`   | Opens a floating widget (the asset picker).        |
    | `pane.focus`   | Makes a pane active without moving anything.       |
    | `pane.scroll`  | Scrolls a surface to bring something into view.    |
    | `drag.start`   | Arms an interaction with a carried subject.        |
    | `drag.accept`  | A drop target that would accept a carried subject. |
    | `key.bind`     | A keyboard shortcut bound to another effect.       |

- **A control records a list of effects, not one.** A double-click on a shot in Shot
  Coverage publishes a selection and then opens an editor in the sparing pane. Recording
  only the last effect drops the part a linter checks.
- **The design rule applies unchanged.** A pseudo-command is recorded from the object that
  installs its handler, the way `act()` records a command. A renderer-local handler that
  is a closure has to become a call to a recorded effect first. Rewriting such a closure
  is the real engineering cost, and it is the same work the anchor layer did for commands.

### Traceability

Provenance comes from three sources, listed in order of preference. None of them is a
build-time transform, which would need more machinery than the others and would only be as
accurate as the transform.

1.  1. **The rule function.** Once every offer comes from a rule module, the offer can
       carry the name of the function that produced it. The function name is the most
       stable reference because it survives DOM rewrites.
2.  2. **Captures a stack at registration, in the sweep build only.** Calls
       `new Error().stack` at `act()` time and resolves the result through the source map
       to a file and line. The capture requires no annotations and never runs in
       production.
3.  **The command id.** Command definitions are one file per namespace under
    `apps/desktop/src/main/commands/`, so an id already locates its implementation.

### Effects on commands

A command definition declares the command's guard but not its effect. The definition does
not say which document paths or `ui.*` fields the command changes.

- Add an `affects` field to each command definition, listing the document subtrees and ui
  fields it may touch. The derived model then has effects for commands as well as for
  renderer-local behaviours.
- Verify the declaration in the executed tier by diffing the undo snapshot after each
  mutating command runs in a mock scratch project. The test fails if the diff covers
  anything outside the declaration.

### Situations

The one hand-authored input is the list of situations to derive under. Each situation is a
fixture of the IPC view types the rules already read, and the sweep uses the same list as
its script of states to visit. The situations that matter are the ones that gate controls:
nothing selected, a scene selected, a shot selected, a node picked in the gen graph, a
thread open, a run in flight, a portrait awaiting approval, a project with no keys.

## The two use cases

### Querying by an LLM

- **One file, one schema.** The model is a JSON document with a zod schema in `@vn/types`,
  like the command catalog and `anchors.json`, and a generated markdown projection for
  humans and models, like the catalog has. Here "formal" means a schema with a closed
  vocabulary. Parsing a grammar would add nothing the JSON does not already provide, and
  the command DSL gives an invocation a textual form.
- **The readers already exist.** The tour's resolver reads `anchors.json` today, and the
  `show_me` tool writes tours against the registry. A model with situations and effects
  helps both. `show_me` can say which pane and which selection a step needs before the
  author gets there, and the debug agent can answer "how does the author do X" with a file
  and line.
- **Two layers, not one.** The affordance model supplies the vocabulary. Workflows (tours
  today, macros if they are built) compose over that vocabulary and stay separate, so the
  generated file never carries anything hand-written.

### Linting

The lint use case is the stronger of the two, and it should drive the schema. The rules
below are checkable from the model, and each one lists what it needs:

| Rule                                                                  | Needs                       | Status                        |
| --------------------------------------------------------------------- | --------------------------- | ----------------------------- |
| Every control carries a tooltip (CLAUDE.md's rule)                    | `tooltip` on the record     | not checked today             |
| A disabled control states why, in the stack's own words               | `reason` on the record      | recorded, not checked         |
| Enabled state agrees with `stack.check`                               | the measured tier           | checked by the sweep          |
| The ring lands on the control                                         | the measured tier           | checked by the sweep (strays) |
| A command has at least one control, or is listed as palette-only      | the derived tier            | partly, via `FLOOR`           |
| A surface opens an editor only through the sparing rule               | `effects` with a pane field | not checked today             |
| A mutating command reachable from a menu is undoable or confirms      | `effects` plus the catalog  | not checked today             |
| A keyboard shortcut is bound once                                     | `key.bind` effects          | not checked today             |
| Two controls in one pane share a key only with a discriminator        | `key` and `on`              | not checked today             |
| The committed model was derived after the last change to `editors/**` | `gitSha` and git            | not checked today             |

The last rule reports the known weakness of a committed generated file rather than leaving
it unreported.

## Costs

- **Extract inline offer logic into rule modules** for the ten editors that register
  anchors without a rule module, and unify the six rule modules that exist. The companion
  report covers this work.
- **Recording renderer-local handlers as effects.** Each closure that expands, selects,
  opens or scrolls calls through a recorded effect. Recording these handlers is the
  largest single change and touches every editor.
- **Declaring `affects` on 170 commands**, and writing the executed-tier test that
  verifies it.
- **Writing and maintaining the situation list.** The work is small, but the model is only
  as complete as this list, and a control drawn only in an unlisted situation shows up as
  unanchored.
- **A second committed generated file** that has the same staleness problem as
  `anchors.json`. The sha rule above makes this staleness visible.

## Decisions a plan would settle

- Decide whether the derived model is committed or generated in CI and compared, and where
  it lives (`apps/desktop/ux-model.json` beside `anchors.json` is the obvious place).
- Whether `anchors.json` is absorbed into the model's measured fields or kept as the
  tour's smaller input is an open question.
- What is the exact pseudo-command vocabulary, and is `key.bind` an effect or a property
  of a control?
- Decide whether `affects` is a list of document-tree path prefixes, a list of `ui.*`
  field names, or both, and how the snapshot diff is matched against it.
- Which lint rules block in CI and which are advisory. Under the existing split, the
  registry comparison blocks CI and the sweep's disagreements do not block it.

## See also

- [`../reference/guided-tours.md`](../reference/guided-tours.md) documents the anchor
  layer and the tour as it ships.
- [`../reference/command-system.md`](../reference/command-system.md) covers the registry
  and the catalog.
- [`../reference/swappingPaneEditors.md`](../reference/swappingPaneEditors.md) states the
  pane-choice rule that a linter would check `view.open` effects against.
- [`agent-access-to-the-ux-command-system.md`](agent-access-to-the-ux-command-system.md)
  explains why the agent does not get the registry, and why the agent needs a model to
  read instead.
- [`user-authored-macros-and-custom-actions.md`](user-authored-macros-and-custom-actions.md)
  describes the composition layer that would sit on top of this model.
