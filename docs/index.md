# Documentation Index

<!-- toc -->

- [As-shipped guides](#as-shipped-guides)
- [Design reports](#design-reports)
- [Research](#research)
- [Background & reference](#background--reference)

<!-- tocstop -->

The pages below are reference material for the VN Generator monorepo. For the working map
of the code itself (package layering, the invariants in brief), see
[`../CLAUDE.md`](../CLAUDE.md); each area's full write-up is below. CLAUDE.md holds the
git-history and tooltip rules, and the rest of the conventions for how this repo is
written are in [`reference/conventions.md`](reference/conventions.md). For how to debug
the repo (state files, CDP, the 2D debug surface, known traps), see
[`guides/debugGuide.md`](guides/debugGuide.md).

Implementation plans live separately in [`plans/`](plans);
[`plans/index.md`](plans/index.md) lists all of them with their build status, and a
shipped plan's file sits in [`plans/archive/`](plans/archive).

Each directory holds one kind of document. [`guides/`](guides) explains how to carry out a
task, such as running the system, debugging it, or getting a key.
[`reference/`](reference) explains how a shipped part of the system works.
[`history/`](history) holds the reports and surveys that shaped the design and are now
static. [`research/`](research) holds exploratory work that may never ship.

## As-shipped guides

Describes how a part of the system works today, in the detail that CLAUDE.md only
summarizes.

- [`reference/packages.md`](reference/packages.md) — What each package in the monorepo is
  responsible for, and the rules that keep the graph acyclic: the disjoint pipeline spine
  and authoring branch, the six constrained leaves, most of which exist because two hosts
  must run the same rules.
- [`reference/contracts.md`](reference/contracts.md) — How pipeline contracts are declared
  in code and indexed for `pnpm contracts`, and the constraint-solver, stills-family,
  narrative-structure and executor-registry seams as shipped, with the decisions that
  still bind.
- [`guides/cli.md`](guides/cli.md) — `vngen` as shipped: the eight commands and their
  flags, `export` vs `screenplay`, `--mock` as a dry run and what a real run needs
  instead, key resolution.
- [`guides/api-keys.md`](guides/api-keys.md) — How to get a model key from Google and from
  Anthropic, what each one costs, and the four places a key is read from, in precedence
  order.
- [`guides/toolchain.md`](guides/toolchain.md) — How the repo is built, checked, tested
  and formatted, and why each choice deviates from the original plan: the two-pass
  typecheck, source-only packages, turbo's `globalDependencies`, the command-catalog build
  step.
- [`../packages/contracts/contracts.json`](../packages/contracts/contracts.json) — The
  pipeline's invariants, each a `contract({...})` declaration beside the code that
  enforces it. This generated file holds every summary and a subject map;
  `pnpm contracts <query>` searches it by file, command, tool, id or text, and
  [`reference/contracts.md`](reference/contracts.md) explains the system.
- [`reference/gen-graphs.md`](reference/gen-graphs.md) — Generation graphs as shipped: a
  bound graph as the slot's runner (task identity never moves; an edit shows as drift and
  the next run redraws), the on-disk layout under `work/graphs/` and `state/graphs/`.
- [`reference/asset-stores.md`](reference/asset-stores.md) — The base/project asset split:
  why base art lives at `assets/` (and may be its own repo), routing by `AssetKind`, the
  union read, the three base states and why an `unavailable` one stops a run, `satisfies`
  as a list.
- [`reference/command-system.md`](reference/command-system.md) — The desktop app's command
  system: typed property specs, the registry, the `namespace.command(a='x')` DSL, the
  git-stamped execution stack, undo/redo, the interaction layer that declares the
  direct-manipulation gestures.
- [`reference/history-pane.md`](reference/history-pane.md) — The History pane as shipped:
  where the code is across `@vn/git`, the session parts and the renderer, the vocabulary
  (save, checkpoint, shared copy), the list and strip, the change view and its per-kind
  diffs.
- [`reference/repos-and-commits.md`](reference/repos-and-commits.md) — Which repo owns a
  path and when history gets written: the discovered repo map (`RepoResolver`,
  `WorkspaceIndex.repos`, and what `owned: false` refuses), commit-on-save with its
  clean-worktree invariant and trailer shape.
- [`reference/desktop-app.md`](reference/desktop-app.md) — The Electron app, organized by
  editor: the path.ux shell (panes, `view.*`, header, palette, keymap, bridge, shadow-root
  surfaces), the shared graph canvas, then Branches, Script, Convo, Shot Coverage,
  Tasks/Task Graph/Inspector and Play.
- [`reference/swappingPaneEditors.md`](reference/swappingPaneEditors.md) — `panes.ts`, the
  pure arithmetic behind every `view.*` pane choice: the `Pane` shape, `arrangeable`,
  `NO_PANE`, each of the six exported functions, the conversation-avoiding preference
  (`SPOKEN_IN`/`sparing`).
- [`reference/guided-tours.md`](reference/guided-tours.md) — The anchor layer and the
  tours that ride on it: `act()` wiring a click and its record from one `Offer`,
  `cmd:`/`item:` keys, the DOM and `pick` flavours.
- [`reference/asset-picker.md`](reference/asset-picker.md) — **Attach…** as shipped: the
  desktop app's half of path.ux's gallery popup — the `asset.list` snapshot that fills it
  and why it is a snapshot, `AssetListing` and the `labelAssets` names it carries.
- [`reference/document-tree.md`](reference/document-tree.md) — The sidebar's two shapes:
  the logical document tree (story → scenes → shots, characters, locations, the wiki,
  assets by kind) and per-entity backlinks, plus the `kind:key` node-id contract, the
  caps, the separate file-tree mode.
- [`reference/playable-format.md`](reference/playable-format.md) — `story.play.json` — the
  in-house playable `@vn/export` projects from the model + manifest: beat shape, branch
  edges, `{hash, ext}` asset refs, and why a missing asset is omitted rather than an
  error.
- [`guides/github-pages.md`](guides/github-pages.md) — Publishing a generated VN as a
  light novel on GitHub Pages: what **Install GitHub Page Builder…** writes into the
  project, why the renderer is committed as a dependency-free bundle instead of installed
  by CI.
- [`guides/collaborating.md`](guides/collaborating.md) — Working with a collaborator
  through the History pane's shared copies, written for an author: what a shared copy is,
  connecting one, sending and getting saves, the conflict view, credential helpers on the
  three platforms.
- [`guides/testkit.md`](guides/testkit.md) — `@vn/testkit`: real projects on disk run
  through the real scheduler with mock providers, the per-scene gate, `synthProject`'s
  determinism, marked placeholder art, and the recorded-asset corpus with its refresh
  script.
- [`guides/showEditorPaneGuide.md`](guides/showEditorPaneGuide.md) — How to show an editor
  to the author from application code: reaching `view.open`/`view.focus` through `exec` or
  a direct `ctx.host.ui` push, choosing `where`, when `subject` is a silent no-op, when to
  set `flash`, popup sizing.
- [`reference/vnauthor.md`](reference/vnauthor.md) — The authoring agent as shipped: CLI
  flags, REPL commands, the plan/execute state machine, the agent-backend seam, context
  precedence, and skills.
- [`reference/agent-report.md`](reference/agent-report.md) — Help ▸ Report a Difficult
  Agent… as shipped: the `@vn/agentreport` leaf, evidence assembled from a thread plus
  `commands.jsonl`, the redactor as a boundary with its in-memory pseudonym map.
- [`reference/story-bible.md`](reference/story-bible.md) — `wiki/` and `@vn/bible`:
  retrieval over the author's free-form notes — why there is no whole-file API, how the
  character budget is enforced, what the index holds, the grep ranking an embedding store
  would replace.
- [`guides/debugGuide.md`](guides/debugGuide.md) — How to debug anything here, cheapest
  tool first: the gates, reading state on disk, reproducing offline, driving the desktop
  app over CDP, `window.__vnDebug`, and the known traps.
- [`reference/conventions.md`](reference/conventions.md) — How this repository is written
  rather than what it does: where plans and research are filed and how `todos.md` is
  treated, the rule that CLAUDE.md stays a map with pointers, formatting markdown by
  naming the files.

## Design reports

- [`history/vn-generator-report.md`](history/vn-generator-report.md) — The core system
  design: goals, the deterministic-vs-generative split, phases P1–P7, the task graph, the
  asset store, and the provenance manifest.
- [`history/authoring-agent-report.md`](history/authoring-agent-report.md) — Design of
  `vnauthor`, the plan-first conversational agent that helps an author write and refine
  the _input_ files (characters, scenes, locations).
- [`reference/desktopAppState.md`](reference/desktopAppState.md) — The desktop app's state
  model: what persists in project files, in `localStorage`, in the session store and in
  memory, including the pane layout, selection and the Play editor's playthrough stack.
- [`history/gitUndoOptions.md`](history/gitUndoOptions.md) — The survey that decided how
  undo works: five candidate strategies (memento, path-scoped restore, commit-per-command,
  shadow snapshots, split-by-data-class) and their failure modes.

## Research

[`research/`](research) holds surveys, investigations, and exploratory designs.

- [`research/graphThingsReport.md`](research/graphThingsReport.md) — An inventory of the
  graph-shaped structures in the repo that could back a node editor or visualizer, from
  story branches to the approval gate.
- [`research/scene-chunks-as-the-authored-unit.md`](research/scene-chunks-as-the-authored-unit.md)
  — What it would take to stop processing a preexisting screenplay and let the author
  freely edit per-scene chunks, starting with why positional line ids are the real
  blocker.
- [`research/pipeline-contracts-into-code.md`](research/pipeline-contracts-into-code.md) —
  How to move every invariant of the former pipeline contracts page into code and delete
  the page. Done: see [`reference/contracts.md`](reference/contracts.md) and
  [the archived plan](plans/archive/INDEX.md#contracts-into-code-and-workflows).
- [`research/workflows-and-narrative-engines.md`](research/workflows-and-narrative-engines.md)
  — How the repo would support several production workflows (VN, manga, storyboard,
  previz, animation, film) and several narrative engines (linear, branching, storylets);
  partly built, see [`reference/contracts.md`](reference/contracts.md) for the seams that
  shipped.
- [`research/codebase-migration-for-new-requirements.md`](research/codebase-migration-for-new-requirements.md)
  — How the non-UX codebase migrates to
  [`history/designRequirementsEtc.md`](history/designRequirementsEtc.md): meta-tag entity
  discovery, the `wiki/` story bible, and the base/project asset-store split.
- [`research/2d-graphics-debug-api.md`](research/2d-graphics-debug-api.md) — Exploratory
  design for a source-agnostic 2D debugging layer (neutral fragment IR, spatial and causal
  queries, time travel). The first slice shipped as `@vn/debug2d`; see
  [`guides/debugGuide.md`](guides/debugGuide.md).
- [`research/retrieval-beyond-grep.md`](research/retrieval-beyond-grep.md) — What could
  replace the grep-shaped ranking in `@vn/bible`, from five defects in `query.ts` to eight
  options from BM25F to local embeddings, priced against the package's constraints.
- [`research/navigating-the-story-bible.md`](research/navigating-the-story-bible.md) —
  What it would take for the agent to list the wiki rather than only search its prose,
  given that `Bible.files()` already returns the metadata a listing needs.
- [`research/wysiwyg-markdown-editing.md`](research/wysiwyg-markdown-editing.md) — What it
  would take to replace the Wiki pane's `<textarea>` with a richer surface; CodeMirror 6
  leads, and nothing is decided.
- [`research/comparable-systems.md`](research/comparable-systems.md) — What else exists in
  this space as of August 2026, in four camps: prompt-to-VN products, the open-source
  agent layer, multi-agent story-to-play research, and generative previz.
- [`research/pressure-test-guided-ui-tours.md`](research/pressure-test-guided-ui-tours.md)
  — An adversarial read of
  [`plans/archive/guided-ui-tours.md`](plans/archive/guided-ui-tours.md) against the code;
  three editors bypass `bridge.exec`, so the tour's advance mechanism is blind to most
  `story.*` edits.
- [`research/pressure-test-prompt-caching-plan.md`](research/pressure-test-prompt-caching-plan.md)
  — An adversarial read of
  [`plans/archive/INDEX.md#prompt-caching-and-deferred-tool-loading`](plans/archive/INDEX.md#prompt-caching-and-deferred-tool-loading)
  against the code and the Claude API docs.
- [`research/pressure-test-skills-editor-plan.md`](research/pressure-test-skills-editor-plan.md)
  — An adversarial read of
  [`plans/archive/INDEX.md#skills-editor-and-agent-authored-skills`](plans/archive/INDEX.md#skills-editor-and-agent-authored-skills)
  against the code.
- [`research/what-the-agent-knows-and-where-it-lives.md`](research/what-the-agent-knows-and-where-it-lives.md)
  — The umbrella over the two reports below it: knowledge reaches the agent through the
  built-in `SYSTEM_PROMPT`, a skill, or the code, and the three differ by reachability
  rather than size.
- [`research/agent-transcript-review-test4.md`](research/agent-transcript-review-test4.md)
  — An adversarial read of the four saved `vnauthor` conversations in `examples/test4`
  against the code that produced them.
- [`research/pressure-test-what-the-agent-knows-about-the-story-format.md`](research/pressure-test-what-the-agent-knows-about-the-story-format.md)
  — An adversarial read of
  [`plans/archive/INDEX.md#what-the-agent-knows-about-the-story-format`](plans/archive/INDEX.md#what-the-agent-knows-about-the-story-format)
  against the code, with the central claim checked by running it.
- [`research/story-format-rules-and-a-scene-lint.md`](research/story-format-rules-and-a-scene-lint.md)
  — What the authoring agent does not know about the story format, read from all fourteen
  `examples/test4` conversations, and a scene lint to close the gap.
- [`research/a-less-technical-mode.md`](research/a-less-technical-mode.md) — What a mode
  for someone who just wants to play with this would actually have to change, worked
  against the code.
- [`research/local-and-self-hosted-models.md`](research/local-and-self-hosted-models.md) —
  Whether this app can run against models the author hosts themselves, on their own
  machine or a box on their home network, for text and images alike.
- [`research/tracking-cache-misses-in-transcripts.md`](research/tracking-cache-misses-in-transcripts.md)
  — Whether a saved conversation could record when the prompt cache missed. A miss is
  observable on Anthropic and on nothing else.
- [`research/agent-access-to-the-ux-command-system.md`](research/agent-access-to-the-ux-command-system.md)
  — Whether `vnauthor` should reach the desktop's registered commands directly, weighed
  against the shared decisions and separate transports it has today.
- [`research/user-authored-macros-and-custom-actions.md`](research/user-authored-macros-and-custom-actions.md)
  — What it would take to let an author hook custom actions into the UX: a macro as a
  saved sequence of palette commands plus agent nodes, written in the command DSL.
- [`research/pressure-test-user-authored-macros.md`](research/pressure-test-user-authored-macros.md)
  — An adversarial read of
  [`research/user-authored-macros-and-custom-actions.md`](research/user-authored-macros-and-custom-actions.md)
  against the code: a `CommandRecord`'s `invocation` is built from digested props, so a
  macro cannot be recorded by filtering the history.
- [`research/prompt-cache-tests-against-live-models.md`](research/prompt-cache-tests-against-live-models.md)
  — What it would take to verify prompt caching against the real APIs on approval only,
  one check per supported model, for both `vnauthor` and the report analyst.
- [`research/shot-framing-systems.md`](research/shot-framing-systems.md) — A
  build-oriented survey of how generative systems produce a _specifically framed_ shot,
  staged as prompt → layout → camera → conditioning → validation, with three costed
  architectures and the evidence for each.
- [`research/manga-shot-composition.md`](research/manga-shot-composition.md) — What it
  would take to compose every frame the way a storyboard artist would, rather than popping
  a portrait over a background — and the correction that reframes the question.
- [`research/manga-live-tests.md`](research/manga-live-tests.md) — The live-model checks
  the [manga-style plan](plans/archive/manga-style.md#live-model-testing) asks for, one
  section per stage, with what was drawn, what came back and what it cost.
- [`research/openrouter-prompt-cache-live-run.md`](research/openrouter-prompt-cache-live-run.md)
  — The live check `plans/openrouter-as-a-fallback-transport.md` owed:
  `scripts/verify-prompt-cache.mjs --via openrouter`, run on 2026-09-19 against Claude
  Opus 4.8 and Gemini 2.5 Flash.
- [`research/git-library-vs-git-process.md`](research/git-library-vs-git-process.md) —
  Whether to replace `@vn/git`'s `execFile` calls with an in-process git library, and the
  finding that the answer is no.
- [`research/node-based-asset-generation.md`](research/node-based-asset-generation.md) —
  How the node-based asset generator works, with the nine decisions settled on 2026-08-24:
  a bound graph is the slot's runner, so an edit shows as drift rather than a changed
  hash.
- [`research/ux-behaviour-model.md`](research/ux-behaviour-model.md) — What it would take
  to describe every UX behaviour of the desktop app in one machine-readable model an LLM
  can query and a linter can check: why an enumerated state machine, a hand-written model
  and a runtime-only sweep each fail.
- [`research/zod-backed-model-interface.md`](research/zod-backed-model-interface.md) —
  Whether the renderer could bind editors to project documents through path.ux's data-path
  system, with a `ModelInterface` whose structs are generated from zod schemas.
- [`research/deleting-things.md`](research/deleting-things.md) — A survey, written before
  any plan, of what deleting a scene, shot, character, location, wiki page, asset or
  thread would take.
- [`research/git-editor-pane.md`](research/git-editor-pane.md) — Feature requirements and
  workflow design for a History pane over the project's repositories; the app already
  writes a complete history and reads none of it back.
- [`research/slots-as-asset-history.md`](research/slots-as-asset-history.md) — The model
  the code has for a slot holding a history of takes, and where it disagrees with itself:
  six answers to which take is current.
- [`research/storylet-system.md`](research/storylet-system.md) — An external architecture
  pitch for a systemic narrative engine for large narrative teams: a storylet database
  over shared world state, with compile-time verification.
- [`research/storylet-solver.md`](research/storylet-solver.md) — Design research for the
  verification solver behind a storylet model meant for RPGs and VNs at Mass Effect
  trilogy scale or beyond.
- [`research/storylet-path-summaries.md`](research/storylet-path-summaries.md) — The third
  storylet note: how a path through the storylet graph becomes prose a writer can read
  before writing the next storylet.
- [`research/fast-ux-helper.md`](research/fast-ux-helper.md) — How to build a fast helper
  that answers "how do I…" questions about the desktop app, and whether a small fine-tuned
  model is the right tool.
- [`research/formalizing-the-rules-modules.md`](research/formalizing-the-rules-modules.md)
  — The companion refactor: what `renderer/rules/` looks like today and the smallest
  change that gives a headless reader one `controls(state)` entry point per editor.

## Background & reference

- [`reference/fountain.md`](reference/fountain.md) — An introduction to Fountain, the
  plain-text screenplay format used for scene prose, plus the conventions the parser
  relies on.
- [`history/visualNovelFormats.md`](history/visualNovelFormats.md) — A survey of VN
  scripting languages, authoring formats, and runtime engines — context for how our
  intermediate representation models story, branching, and presentation.
- [`history/original-prompt.md`](history/original-prompt.md) — The original request that
  kicked off the project, kept verbatim for provenance.
