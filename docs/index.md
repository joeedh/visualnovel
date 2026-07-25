# Documentation Index

Reference material for the VN Generator monorepo. For the working guide to the code
itself (commands, package layering, conventions), see [`../CLAUDE.md`](../CLAUDE.md).

Implementation plans live separately in [`plans/`](plans) and are not indexed here.

## Design reports

| Document | What it covers |
| -------- | -------------- |
| [`vn-generator-report.md`](vn-generator-report.md) | The core system design: goals, the deterministic-vs-generative split, phases P1–P7, the task graph, the asset store, and the provenance manifest. Stops short of engine export. |
| [`authoring-agent-report.md`](authoring-agent-report.md) | Design of `vnauthor`, the plan-first conversational agent that helps an author write and refine the *input* files (characters, screenplay, locations). Input-side only — it never runs the generative pipeline. |
| [`desktopAppState.md`](desktopAppState.md) | The desktop app's state model: what persists in project files vs. `localStorage` vs. memory, and how the PLAY room's playthrough stack is saved and restored. |
| [`command-system.md`](command-system.md) | The desktop app's command system as shipped: typed property specs, the registry, the `namespace.command(a='x')` DSL, the git-stamped execution stack, the build-time JSON catalog, and CDP access. |
| [`gitUndoOptions.md`](gitUndoOptions.md) | Why the command stack ships without undo, and what it would take to add: five candidate strategies (memento, path-scoped restore, commit-per-command, shadow snapshots, split-by-data-class), their failure modes, and a migration path that keeps the v1 record shape. |

## Research

Surveys, investigations, and exploratory designs live in [`research/`](research).

| Document | What it covers |
| -------- | -------------- |
| [`research/2d-graphics-debug-api.md`](research/2d-graphics-debug-api.md) | Exploratory design for a source-agnostic 2D debugging layer: a neutral fragment/frame IR captured from DOM and canvas alike, spatial + causal queries (`explainPick`, `explainTransform`, `whyInvalidated`), time travel, and invariants-as-tests. Aimed at the desktop app's rooms today and a node-based story editor later. Nothing implemented. |

## Background & reference

| Document | What it covers |
| -------- | -------------- |
| [`fountain.md`](fountain.md) | An introduction to Fountain, the plain-text screenplay format used for input, plus the conventions the parser relies on. |
| [`visualNovelFormats.md`](visualNovelFormats.md) | A survey of VN scripting languages, authoring formats, and runtime engines — context for how our intermediate representation models story, branching, and presentation. |
| [`original-prompt.md`](original-prompt.md) | The original request that kicked off the project, kept verbatim for provenance. |
