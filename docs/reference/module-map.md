# API map

<!-- toc -->

- [Layer 0 — leaves](#layer-0--leaves)
  * [@vn/types — zod schemas and shared value types (`packages/types`)](#vntypes--zod-schemas-and-shared-value-types-packagestypes)
  * [@vn/util — fs, hashing, concurrency primitives (`packages/util`)](#vnutil--fs-hashing-concurrency-primitives-packagesutil)
- [Layer 1](#layer-1)
  * [@vn/config — project.yaml and key resolution (`packages/config`)](#vnconfig--projectyaml-and-key-resolution-packagesconfig)
  * [@vn/parse — authored inputs (`packages/parse`)](#vnparse--authored-inputs-packagesparse)
- [Layer 2](#layer-2)
  * [@vn/model — the in-memory project model (`packages/model`)](#vnmodel--the-in-memory-project-model-packagesmodel)
  * [@vn/store — on-disk project layout (`packages/store`)](#vnstore--on-disk-project-layout-packagesstore)
  * [@vn/git — thin git plumbing (`packages/git`)](#vngit--thin-git-plumbing-packagesgit)
  * [@vn/commands — command framework (`packages/commands`)](#vncommands--command-framework-packagescommands)
- [Layer 3 — rules packages (leaves by design; two hosts run each)](#layer-3--rules-packages-leaves-by-design-two-hosts-run-each)
  * [@vn/scriptedit — scene prose writes (`packages/scriptedit`)](#vnscriptedit--scene-prose-writes-packagesscriptedit)
  * [@vn/bible — retrieval over `wiki/` (`packages/bible`)](#vnbible--retrieval-over-wiki-packagesbible)
  * [@vn/artgen — art rules: prompts, slot graph, approvals (`packages/artgen`)](#vnartgen--art-rules-prompts-slot-graph-approvals-packagesartgen)
  * [@vn/gengraph — generation graphs (`packages/gengraph`)](#vngengraph--generation-graphs-packagesgengraph)
- [Layer 4 — orchestration](#layer-4--orchestration)
  * [@vn/taskgraph — content-addressed task graph (`packages/taskgraph`)](#vntaskgraph--content-addressed-task-graph-packagestaskgraph)
  * [@vn/providers — model backends (`packages/providers`)](#vnproviders--model-backends-packagesproviders)
  * [@vn/pipeline — the P-phases (`packages/pipeline`)](#vnpipeline--the-p-phases-packagespipeline)
  * [@vn/scheduler — resumable run loop (`packages/scheduler`)](#vnscheduler--resumable-run-loop-packagesscheduler)
  * [@vn/agentreport — transcript analysis reports (`packages/agentreport`)](#vnagentreport--transcript-analysis-reports-packagesagentreport)
- [Authoring branch](#authoring-branch)
  * [@vn/authoring — the vnauthor agent core (`packages/authoring`)](#vnauthoring--the-vnauthor-agent-core-packagesauthoring)
- [Outside the graph](#outside-the-graph)
  * [@vn/debug2d — dev-only renderer debugging (`packages/debug2d`, zero deps)](#vndebug2d--dev-only-renderer-debugging-packagesdebug2d-zero-deps)
  * [@vn/testkit — real projects through the real scheduler with mock providers](#vntestkit--real-projects-through-the-real-scheduler-with-mock-providers)
- [Hosts (not mapped here)](#hosts-not-mapped-here)

<!-- tocstop -->

Lists one line per module, grouped by layer. Use this to locate a symbol before reading the
file; the authoritative package responsibilities and import rules are in
[`packages.md`](packages.md). Regenerate the module lists with `pnpm gen:apimap`
(`scripts/gen-apimap.mjs`); update the one-liners by hand when a module's job changes.

## Layer 0 — leaves

### @vn/types — zod schemas and shared value types (`packages/types`)
| module | purpose |
| --- | --- |
| `schemas.ts` | zod schemas for every parsed/machine-consumed boundary (inputs, model, tasks) |
| `model.ts` | the project model types: characters, locations, scenes, assets |
| `entities.ts` | entity-sheet value types and tags |
| `tasks.ts` | task-graph node and task-kind types |
| `prompt.ts` | prompt chunk / ref types shared by artgen and providers |
| `providers.ts` | backend capability types (`ChatBackend`, `ImageBackend`, reviewers) |
| `textmodels.ts` | chat message / request types for text backends |
| `budget.ts` | cost-budget types |
| `playable.ts` | `story.play.json` format types |
| `notifications.ts` | user-notification types |
| `index.ts` | barrel |

### @vn/util — fs, hashing, concurrency primitives (`packages/util`)
| module | purpose |
| --- | --- |
| `fs.ts` | `exists`, `ensureDir`, atomic write, JSONL read/append |
| `hash.ts` | content hashing (`sha256`) |
| `pool.ts` | bounded async pool preserving input order |
| `logger.ts` | logging |
| `errors.ts` | shared error helpers |

## Layer 1

### @vn/config — project.yaml and key resolution (`packages/config`)
| module | purpose |
| --- | --- |
| `config.ts` | load/patch `project.yaml` (`setArtStyle`, `setStartScene`) |
| `keys.ts` | four-place key resolution, `userConfigDir`, `resolveKeys` |

### @vn/parse — authored inputs (`packages/parse`)
| module | purpose |
| --- | --- |
| `fountain.ts` | Fountain screenplay parser |
| `branch.ts` | branch markers |
| `frontmatter.ts` | entity-sheet front matter |
| `inputs.ts` | `loadInputs` — the one read of authored files the model builds from |

## Layer 2

### @vn/model — the in-memory project model (`packages/model`)
| module | purpose |
| --- | --- |
| `canonical.ts` | canonical model construction from parsed inputs |
| `entities.ts` | entity lookups |
| `scenes.ts` | scene and line access |
| `screenplay.ts` | screenplay projection |
| `branchpatch.ts` | branch-marker patching |
| `lineids.ts` | stable line ids |
| `outfits.ts` | outfit/variant inheritance |
| `graph.ts` | model-level graph queries |
| `serialize.ts` | model ⇄ text round-trip serializers (vnauthor edits go through these) |
| `slug.ts` | slugify helpers |
| `used.ts` | enumerate every picture the model implies (planner + slot graph share it) |
| `build.ts` | build/manifest projection |
| `index.ts` | barrel |

### @vn/store — on-disk project layout (`packages/store`)
| module | purpose |
| --- | --- |
| `paths.ts` | `ProjectPaths`: where everything lives |
| `docfile.ts` | bounded workspace read/write + refusals (agent `read_file` and `doc.*` share it) |
| `tree.ts` | markdown tree walk shared by entity discovery and the bible reader |
| `entities.ts` | entity discovery from files |
| `scenes.ts` | scene chunk reading |
| `shots.ts` | `work/shots/<sceneId>.json` access |
| `worktree.ts` | loadInputs-derived workspace view (writers patch these bytes, not disk) |
| `assetstore.ts` | content-addressed asset store |
| `index.ts` | barrel |

### @vn/git — thin git plumbing (`packages/git`)
`git.ts` (command runner), `repos.ts` (repo discovery), `errors.ts`, `index.ts`.

### @vn/commands — command framework (`packages/commands`)
| module | purpose |
| --- | --- |
| `command.ts` | `defineCommand` / `defineFor`, command ids |
| `registry.ts` | `CommandRegistry` |
| `stack.ts` | `CommandStack`: batch, checkpoints, `stack.check` refusal gate |
| `props.ts` | declarative prop specs, `coerceProps` (single validation authority) |
| `digest.ts` | `digestProps` redaction (`prop.secret`) |
| `dsl.ts` | string DSL parse/format (`ns.command(a='x')`) |
| `catalog.ts` | JSON catalog / doc index |
| `interaction.ts` | interactive prompt registry |
| `content.ts` | `ContentStore` (content-addressed workspace blobs) |
| `snapshot.ts` | **side entry** (fs only): snapshot store + `UndoJournal` |
| `commit.ts` | `Committer` commit-on-save |
| `undo.ts` | undo journal |
| `index.ts` | barrel (browser-safe: no `node:fs`) |

## Layer 3 — rules packages (leaves by design; two hosts run each)

### @vn/scriptedit — scene prose writes (`packages/scriptedit`)
| module | purpose |
| --- | --- |
| `sources.ts` | the authored files an edit patches, derived from `loadInputs` (core contract) |
| `apply.ts` | prose edit application |
| `markers.ts` | branch marker edits |
| `lineops.ts` | line-level text ops |
| `branchops.ts` | branch structure ops |
| `cast.ts` | cast changes |
| `coverage.ts` | shot coverage writes |
| `shotcreate.ts` / `shotorder.ts` / `shotfallout.ts` | shot create/reorder/fallout |
| `outfits.ts` / `variants.ts` | outfit and variant edits |
| `write.ts` | **side entry** (fs writes; renderer imports the rules without it) |
| `index.ts` | barrel |

### @vn/bible — retrieval over `wiki/` (`packages/bible`)
`index.ts` (`openBible`, the only entry point), `indexer.ts` (build/read index), `query.ts` (budgeted ranked query), `types.ts`.

### @vn/artgen — art rules: prompts, slot graph, approvals (`packages/artgen`)
| module | purpose |
| --- | --- |
| `gate.ts` | P3 approval gate (`gateStatus`, `isApproved`, `sceneUnblocked`) |
| `chunks.ts` | `PromptChunk` composition + fingerprint |
| `prompts.ts` | per-slot-kind prompt builders (portrait/location/model-sheet/shot) |
| `resolve.ts` | rung/override resolution |
| `refs.ts` | reference binding resolution |
| `upstream.ts` | upstream attachment walk |
| `slotaddr.ts` | slot key parse/format |
| `slotgraph.ts` | slot graph construction (`buildSlotGraph`) |
| `suspend.ts` | suspension walk (drifted upstream ⇒ suspended downstream) |
| `refcycle.ts` | reference cycle detection |
| `prereq.ts` | prerequisite refusals |
| `adopt.ts` / `adoptslot.ts` / `promote.ts` | adoption and concept promotion |
| `concept.ts` | concept image generation |
| `describe.ts` | asset description |
| `storyboard.ts` | shot decomposition (`deterministicShots`, `decomposeScene`) |
| `coverage.ts` | prompt-coverage check |
| `condense.ts` | prompt condensing |
| `setnotes.ts` | art notes / seed setters |
| `artnotes.ts` | art-target rung queries |
| `subject.ts` | concept subject parse/match |
| `base.ts` | base-asset refusals |
| `upload.ts` | reference image upload |
| `drift.ts` | prose-hash drift marker |
| `index.ts` | barrel |

### @vn/gengraph — generation graphs (`packages/gengraph`)
See [`gen-graphs.md`](gen-graphs.md) for what ships.

| module | purpose |
| --- | --- |
| `document.ts` / `dsl.ts` / `edit.ts` | graph document, its DSL, edits |
| `validate.ts` | graph validation (`validateGenGraph`) |
| `registry.ts` / `plugin.ts` / `pluginload.ts` | node registry and plugin loading |
| `nodes/` | built-in node kinds, runtimes, socket types (barrel `nodes/index.ts`) |
| `services.ts` | service surface nodes call |
| `execute.ts` | executor (hashes nodes, runs via runtimes) |
| `state.ts` | **side entry** (fs): graphs dir, run journal, blobs, hashes |
| `journal.ts` / `journalfile.ts` / `manifest.ts` / `graphfile.ts` | on-disk formats |
| `blobs.ts` / `hash.ts` / `paths.ts` | blob store, hashing, paths |
| `drift.ts` | generation-graph drift reporting |
| `migrate.ts` / `defaults.ts` | migration and defaults |
| `cost.ts` / `prices.ts` / `pricestore.ts` / `priceagent.ts` | pricing; agents only on request |
| `index.ts` | main barrel (renderer-safe; `state.ts` is the node-only entry) |

## Layer 4 — orchestration

### @vn/taskgraph — content-addressed task graph (`packages/taskgraph`)
`graph.ts` (the graph and deduplication), `hash.ts` (task hashes), `log.ts` (the
append-only status log in `state/tasks.jsonl`), `index.ts`.

### @vn/providers — model backends (`packages/providers`)
| module | purpose |
| --- | --- |
| `backend.ts` | backend interface glue |
| `backends/anthropic.ts` / `gemini.ts` | vendor text backends |
| `backends/capture.ts` | request capture (tests/debug) |
| `backends/transient.ts` | retryable/transient error handling |
| `backends/convo-request.ts` | conversation request shaping |
| `structured.ts` | structured-output retry |
| `image.ts` | image backend seam |
| `review.ts` | vision QA reviewer |
| `mock.ts` / `placeholder.ts` | mock and placeholder providers |
| `cache.ts` / `factory.ts` | caching and backend selection |
| `index.ts` | barrel |

### @vn/pipeline — the P-phases (`packages/pipeline`)
| module | purpose |
| --- | --- |
| `pipeline.ts` | the run driver |
| `p1.ts` | P1: planning inputs / character sheets |
| `planner.ts` | task planning over the model |
| `decompose.ts` | explicit decomposition |
| `p5.ts` / `p6.ts` | later phases (see pipeline-contracts.md) |
| `runners.ts` | task runners |
| `genservices.ts` | generation services wiring |
| `graphrun.ts` / `graphload.ts` | bound generation-graph runs |
| `drift.ts` | pipeline-side drift reporting |
| `prompts.ts` | pipeline LLM prompts |
| `index.ts` | barrel (re-exports the P3 gate from `@vn/artgen` by name) |

### @vn/scheduler — resumable run loop (`packages/scheduler`)
`scheduler.ts` (schedule + resume + budget), `index.ts`.

### @vn/agentreport — transcript analysis reports (`packages/agentreport`)
`analyze.ts` (createAnalyst/analyze), `transcript.ts` (assemble/redact), `redact.ts`
(secret redaction), `render.ts`, `report.ts` (schema), `issue.ts` (GitHub issue),
`sourcemap.ts`/`sourcetools.ts`/`requesttools.ts` (tooling for the analyst), `index.ts`.

## Authoring branch

### @vn/authoring — the vnauthor agent core (`packages/authoring`)
| module | purpose |
| --- | --- |
| `loop.ts` | the `Agent` loop: turns, retries, restores |
| `backend.ts` | structured/native agent backends |
| `tools.ts` | **all built-in tools + `ALL_TOOLS`/`createRegistry`** (~2,700 lines) |
| `context.ts` | system prompt assembly, AICONTEXT/CLAUDE.md loading |
| `generated.ts` | `AICONTEXT.generated.md` (workspace.reindex) |
| `workspace.ts` | `Workspace` index/focus |
| `compact.ts` | history compaction |
| `history.ts` | history tools |
| `approve.ts` | approval triage |
| `archive.ts` | upload archive |
| `skills.ts` | skill discovery/creation/running |
| `art.ts` | artgen/text-LLM wiring |
| `apierror.ts` | API failure recovery |
| `wrap.ts` | line-wrap warnings |

## Outside the graph

### @vn/debug2d — dev-only renderer debugging (`packages/debug2d`, zero deps)
`frame.ts` (capture), `geom.ts`, `spaces.ts`, `types.ts`, `dom/` (DOM attribution/resolvers), `explain/`, `query/`. See [`docs/guides/debugGuide.md`](../guides/debugGuide.md).

### @vn/testkit — real projects through the real scheduler with mock providers
Nothing may import it. See [`docs/guides/testkit.md`](../guides/testkit.md).

## Hosts (not mapped here)
`apps/cli`, `apps/authoring`, `apps/desktop`. See docs/reference/desktop-app.md for the
desktop app's structure, including the sixteen editors.