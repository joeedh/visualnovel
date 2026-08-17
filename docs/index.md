# Documentation Index

<!-- toc -->

- [As-shipped guides](#as-shipped-guides)
- [Design reports](#design-reports)
- [Research](#research)
- [Background & reference](#background--reference)

<!-- tocstop -->

Reference material for the VN Generator monorepo. For the working map of the code itself
(package layering, the invariants in brief, conventions), see [`../CLAUDE.md`](../CLAUDE.md);
each area's full write-up is below. For how to debug the repo (state files, CDP, the 2D debug
surface, known traps), see [`debugGuide.md`](debugGuide.md).

Implementation plans live separately in [`plans/`](plans); [`plans/index.md`](plans/index.md)
lists all of them with their build status.

## As-shipped guides

How a part of the system actually works today, in the detail CLAUDE.md only summarizes.

| Document | What it covers |
| -------- | -------------- |
| [`packages.md`](packages.md) | What each package in the monorepo is responsible for, and the rules that keep the graph acyclic: the disjoint pipeline spine and authoring branch, the four constrained leaves that exist because two hosts must run the same rules, why the boundaries rule is per import statement rather than transitive, and the two packages that sit outside the graph entirely. |
| [`cli.md`](cli.md) | `vngen` as shipped: the eight commands and their flags, `export` vs `screenplay`, `--mock` as a dry run and what a real run needs instead, key resolution, the on-disk project layout (base art at `assets/`, everything else under a committed `vngen/`), one scene per file, and the `examples/sample` walkthrough. |
| [`toolchain.md`](toolchain.md) | How the repo is built, checked, tested and formatted, and why each choice deviates from the original plan: the two-pass typecheck, source-only packages, turbo's `globalDependencies`, the command-catalog build step, the import resolver the boundaries rule needs, and the `tests/` folder convention. |
| [`pipeline-contracts.md`](pipeline-contracts.md) | The load-bearing invariants of the generative pipeline, each stated with the failure it prevents: content-addressed task identity and asset storage, the gate-as-barrier, incremental planning, persisted shot decompositions, allocated line ids, lossless scene serialization, the P7 refine loop, and the deterministic fallbacks. |
| [`asset-stores.md`](asset-stores.md) | The base/project asset split: why base art lives at `assets/` (and may be its own repo), routing by `AssetKind`, the union read, the three base states and why an `unavailable` one stops a run, `satisfies` as a list, and what does *not* move. |
| [`command-system.md`](command-system.md) | The desktop app's command system: typed property specs, the registry, the `namespace.command(a='x')` DSL, the git-stamped execution stack, undo/redo, the interaction layer that declares the direct-manipulation gestures, per-command preconditions (`check`), the build-time JSON catalog, and CDP access. |
| [`repos-and-commits.md`](repos-and-commits.md) | Which repo owns a path and when history gets written: the discovered repo map (`RepoResolver`, `WorkspaceIndex.repos`, and what `owned: false` refuses), commit-on-save with its clean-worktree invariant and trailer shape, the checkpoint commit that opens a session, `ensureRepo` bootstrap, and how undo composes with all of it across several repos. |
| [`desktop-app.md`](desktop-app.md) | The Electron app, organized by editor: the path.ux shell (panes, `view.*`, header, palette, keymap, bridge, shadow-root surfaces), the shared graph canvas, then Branches, Script, Convo, Coverage, Tasks/Task Graph/Inspector and Play, plus the session store, which project is open (launch precedence, the picker, what a switch tears down), the seeded `examples/mySampleRepo` workspace, and the retired `--react` shell. |
| [`document-tree.md`](document-tree.md) | The sidebar's two shapes: the logical document tree (story → scenes → shots, characters, locations, the wiki, assets by kind) and per-entity backlinks, plus the `kind:key` node-id contract, the caps, the separate file-tree mode, and what is deliberately absent (click actions, wiki mention-search). |
| [`playable-format.md`](playable-format.md) | `story.play.json` — the in-house playable `@vn/export` projects from the model + manifest: beat shape, branch edges, `{hash, ext}` asset refs, and why a missing asset is omitted rather than an error. |
| [`testkit.md`](testkit.md) | `@vn/testkit`: real projects on disk run through the real scheduler with mock providers, the per-scene gate, `synthProject`'s determinism, marked placeholder art, and the recorded-asset corpus with its refresh script. |
| [`vnauthor.md`](vnauthor.md) | The authoring agent as shipped: CLI flags, REPL commands, the plan/execute state machine, the agent-backend seam, context precedence, and skills. |
| [`story-bible.md`](story-bible.md) | `wiki/` and `@vn/bible`: retrieval over the author's free-form notes — why there is no whole-file API, how the character budget is enforced, what the index holds, the grep ranking an embedding store would replace, and who reaches it (`search_bible`, `bible.search`). |
| [`debugGuide.md`](debugGuide.md) | How to debug anything here, cheapest tool first: the gates, reading state on disk, reproducing offline, driving the desktop app over CDP, `window.__vnDebug`, and the known traps. |

## Design reports

| Document | What it covers |
| -------- | -------------- |
| [`vn-generator-report.md`](vn-generator-report.md) | The core system design: goals, the deterministic-vs-generative split, phases P1–P7, the task graph, the asset store, and the provenance manifest. Stops short of engine export. |
| [`authoring-agent-report.md`](authoring-agent-report.md) | Design of `vnauthor`, the plan-first conversational agent that helps an author write and refine the *input* files (characters, scenes, locations). Input-side only — it never runs the generative pipeline. |
| [`desktopAppState.md`](desktopAppState.md) | The desktop app's state model: what persists in project files vs. `localStorage` vs. the session store vs. memory — the pane layout and selection, `ShellState`, the conversation, and how the Play editor's playthrough stack is saved and restored. |
| [`gitUndoOptions.md`](gitUndoOptions.md) | The survey that decided how undo works: five candidate strategies (memento, path-scoped restore, commit-per-command, shadow snapshots, split-by-data-class) and their failure modes. Shadow snapshots won — see [`command-system.md`](command-system.md) for what shipped. An afterword records how commit-per-command later came back as a *commit policy* without disturbing that verdict. |

## Research

Surveys, investigations, and exploratory designs live in [`research/`](research).

| Document | What it covers |
| -------- | -------------- |
| [`research/graphThingsReport.md`](research/graphThingsReport.md) | An inventory of the graph-shaped structures in the repo that could back a node editor or visualizer — story branches, the task DAG, prompt assembly, the refine loop, shot/line coverage, asset provenance, the approval gate — with what each view reveals, and the case for one heterogeneous adapter with the views as filters. |
| [`research/scene-chunks-as-the-authored-unit.md`](research/scene-chunks-as-the-authored-unit.md) | What it would take to stop processing a preexisting screenplay and let the author freely edit per-scene chunks: why positional line ids are the real blocker, why `Scene.lines` already carries what a lossless Fountain export needs, the Markdown-with-front-matter chunk format and its `[[line:]]` id markers, prose-drift as a surfaced marker rather than a rehash, and what Fountain becomes (import once, export always). The first move — allocated line ids — has shipped. |
| [`research/codebase-migration-for-new-requirements.md`](research/codebase-migration-for-new-requirements.md) | How the non-UX codebase migrates to [`designRequirementsEtc.md`](designRequirementsEtc.md): meta-tag entity discovery, the `wiki/` story bible and a grep-first retrieval seam, the base/project asset-store split, commit-on-save reconciled with shadow-ref undo, scene/shot outfits, shot ordering, context regeneration, and the backlink index — each mapped to packages, with sequencing and the decisions each plan must settle. The input to [`plans/refactorTaskList.md`](plans/refactorTaskList.md). |
| [`research/2d-graphics-debug-api.md`](research/2d-graphics-debug-api.md) | Exploratory design for a source-agnostic 2D debugging layer: a neutral fragment/frame IR captured from DOM and canvas alike, spatial + causal queries (`explainPick`, `explainTransform`, `whyInvalidated`), time travel, and invariants-as-tests. The first slice (IR, DOM adapter, queries, `explainPick`) is implemented as `@vn/debug2d` — see [`debugGuide.md`](debugGuide.md) for usage. |
| [`research/retrieval-beyond-grep.md`](research/retrieval-beyond-grep.md) | What could replace the grep-shaped ranking in `@vn/bible`, priced against the constraints that package already carries: five specific defects in `query.ts` (a substring test standing in for a term match, no IDF, a file bonus flattened onto every window, an ASCII-only tokenizer, a misattributed heading), why the chunk unit is wrong before the ranker is, and eight options from BM25F to local ONNX embeddings — with the finding that LLM query expansion cannot live in the package and a local encoder can. No vector database, at any step. |
| [`research/wysiwyg-markdown-editing.md`](research/wysiwyg-markdown-editing.md) | What it would take to replace the Wiki pane's `<textarea>` with a richer surface: the round-trip fault line (a WYSIWYG serializer normalizes bytes that `doc.write`'s content hash, byte-exact front-matter splicing and committed provenance all depend on), the constraints any candidate inherits from the shadow-root/no-React renderer, buffer-authoritative options against true-WYSIWYG ones, and measured bundle sizes for CodeMirror, ProseMirror and Toast UI. CodeMirror 6 with a decoration layer leads; nothing is decided. |
| [`research/comparable-systems.md`](research/comparable-systems.md) | What else exists in this space as of August 2026, in four camps — prompt-to-VN products, the open-source agent layer, multi-agent story-to-play research, and generative previz — what this project has that none of them do (content-addressed task identity, drift, the base root that refuses to regenerate, git as the substrate), where it is exposed (camera continuity, export lock-in), and the previz trade: consistency by geometry against consistency by provenance. |
| [`research/pressure-test-guided-ui-tours.md`](research/pressure-test-guided-ui-tours.md) | An adversarial read of [`plans/guided-ui-tours.md`](plans/guided-ui-tours.md) against the code: three editors bypass `bridge.exec` so the tour's advance mechanism is blind to most `story.*` edits, the two graph editors have no per-node click to wire and no node to hit-test, the props of every typed-input act are unknown when the anchor is recorded (including the plan's own headline example), three of the five rules it cites are not `Action`-shaped, `@vn/debug2d` never solved shadow piercing — and `menuFor` is already the pure, node-testable half of the map the plan proposed to measure with a CDP sweep. |

## Background & reference

| Document | What it covers |
| -------- | -------------- |
| [`fountain.md`](fountain.md) | An introduction to Fountain, the plain-text screenplay format used for scene prose, plus the conventions the parser relies on — including this project's note markers (`[[scene:]]`, `[[choice:]]`, `[[next:]]`, `[[line:]]`, `[[nextline:]]`) and where the Fountain lives: the body of a `scenes/<id>.md`, one scene per file. |
| [`visualNovelFormats.md`](visualNovelFormats.md) | A survey of VN scripting languages, authoring formats, and runtime engines — context for how our intermediate representation models story, branching, and presentation. |
| [`original-prompt.md`](original-prompt.md) | The original request that kicked off the project, kept verbatim for provenance. |
