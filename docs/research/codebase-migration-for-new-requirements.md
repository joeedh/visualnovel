# Migrating the codebase to the new requirements

How the existing packages (everything except the desktop renderer, whose path.ux rewrite is
tracked separately) get from what is shipped to what
[`../designRequirementsEtc.md`](../designRequirementsEtc.md) asks for. This is the input to
the individual plans listed in [`../plans/refactorTaskList.md`](../plans/refactorTaskList.md);
it maps each requirement onto the packages it touches, states the migration path, and names
the design decisions that must be settled before a plan is written.

<!-- toc -->

- [Method and scope](#method-and-scope)
- [Where the requirements already hold](#where-the-requirements-already-hold)
- [1. Entity discovery by meta tag](#1-entity-discovery-by-meta-tag)
- [2. The story bible (`wiki/`)](#2-the-story-bible-wiki)
- [3. Base assets vs project assets](#3-base-assets-vs-project-assets)
- [4. Repo map, commit-on-save, and undo](#4-repo-map-commit-on-save-and-undo)
- [5. Outfits at scene and shot level](#5-outfits-at-scene-and-shot-level)
- [6. Shot ordering](#6-shot-ordering)
- [7. Agent context regeneration](#7-agent-context-regeneration)
- [8. Backlink and document-tree index](#8-backlink-and-document-tree-index)
- [Sequencing and the layering picture](#sequencing-and-the-layering-picture)
- [Decisions a plan must settle (collected)](#decisions-a-plan-must-settle-collected)

<!-- tocstop -->

## Method and scope

Each section below takes one requirement, states what exists today (with the file that proves
it), what the requirement actually demands, the smallest migration that satisfies it without
breaking a shipped contract, and any decision a plan must settle first. The contracts in
[`../pipeline-contracts.md`](../pipeline-contracts.md) are treated as load-bearing: a
migration that breaks content-addressed task identity, the lossless scene round-trip, or the
single-write-path rule is rejected here even where it would be less code.

Out of scope: the renderer itself, and the §UX pane/editor requirements — those belong to the
path.ux rewrite plan. In scope: everything a new editor would *present*, because the
requirements' features (wiki trees, backlinks, outfit pickers, shot reordering) all bottom out
in packages, commands and index shapes on this side of the IPC seam.

## Where the requirements already hold

Worth stating first, because it bounds the work:

- **Approval pipeline, base-assets-first, AI pre-check.** The P3 gate-as-barrier orders base
  assets ahead of scene rendering; the P7 reviewer critiques generated art before a human
  sees it. This is the requirements' "Approval Pipeline" section, shipped.
- **Scene tree ordered by decisions.** Scenes form a graph via `choices`/`next`; reordering
  by editing decisions is exactly what the branch editor's `story.*` commands do.
- **The agent can drive the app.** The command registry, `view.*` effects, the JSON catalog
  and CDP are the "AI agent should be able to help the user drive the app" requirement's
  machinery, shipped and tested.
- **Projects live in git repos.** `@vn/git` exists, vnauthor commits per approved plan, undo
  is built on git plumbing. What's missing is *policy* (commit-on-save, multi-repo), not
  capability.

The gaps are therefore: the story bible, tag-based entity discovery, the asset split,
scene/shot outfits, shot ordering, commit-on-save + multi-repo, context regeneration, the
backlink index, and project bootstrap. Taken in turn.

## 1. Entity discovery by meta tag

**Today.** `@vn/store` is the only reader, and discovery is path convention:
`ProjectPaths.characterFile(id)` is hard-coded `characters/<id>/character.md`
(`packages/store/src/paths.ts:18`), locations are `locations/*.md`, and `loadInputs` walks
those two directories (`packages/store/src/worktree.ts:45`). The requirement instead says
character and set-location files are **story bible files identified via some kind of meta
tag** — discovery by content, not by location.

**The good news** is that the file *format* barely moves. Character and location files are
already markdown with YAML front-matter, parsed by `parseFrontMatter` and validated by the
zod schemas in `@vn/types`; the round-trip serializers (`*ToDoc` / `apply*Edit`) and the
byte-exact `splitFrontMatter` splice all survive unchanged. What changes is *how the reader
finds the files*.

**The structural gap.** `LoadedInputs.characterDocs` and `.locationDocs` are bare
`FrontMatterDoc[]` — no source path (`packages/parse/src/inputs.ts:29-30`). Only scenes carry
`file` and `text` (`SceneChunkDoc`). Under path convention that was tolerable: a writer can
re-derive the path from the id. Under tag discovery it cannot — the path is whatever file
happened to carry the tag. So the first move is mechanical but wide: **promote character and
location docs to the `SceneChunkDoc` shape** (id + absolute `file` + `doc` + `text`), and
retarget the writers at the carried path. This also strengthens the shipped "a writer patches
the file the model was built from" contract rather than weakening it — today that contract
holds for scenes and is merely un-falsifiable for characters.

**Migration path.**

1. Add `type: character` / `type: location` (name the key in one place in `@vn/types`) to the
   front-matter schemas, optional at first.
2. Extend `loadInputs` to scan the wiki subtree (§2) for tagged files *in addition to* the
   conventional directories. Conventional files get the tag implicitly from their location.
3. Diagnostics for the conflicts tag discovery invents: two files claiming the same character
   id, a tagged file that fails the schema, a conventional file *and* a tagged file for the
   same id. Follow the `stray_screenplay` precedent — report, prefer one deterministically,
   never guess silently.
4. Only once the desktop and vnauthor both create entities through templates (§UX workflow)
   does the conventional path become legacy; there is no forced migration of existing
   projects, matching how `screenplay/` was retired: the old form is *reported*, not read
   two ways forever.

**Decision to settle in the plan:** whether the id comes from the tag (`character: ada`) or
stays derived from the filename as scenes do (`scene: <id>` matching the filename, identity
and nothing else). Recommendation: same rule as scenes — the tag names the *type*, the id
must match the filename, mismatch is a diagnostic. One identity rule across the project is
worth more than filename freedom.

## 2. The story bible (`wiki/`)

**Today.** Nothing. No package reads a `wiki/` tree; the agent's context is the built-in
input contract plus `AICONTEXT.md` (with nested files and `@import`s), loaded whole by
`packages/authoring/src/context.ts`.

**Requirement.** An arbitrary markdown tree under `wiki/`, provided to the agent **by
retrieval (embeddings or grep), never pasted whole into context**; optionally its own git
repo; two special file types inside it (characters, set locations — §1).

**Where it lives in the layering.** Reading the wiki is input-side file reading, which is
`@vn/store`'s charter ("the only reader of a project's files"). The *retrieval index* is a
different thing — it has consumers (the agent) and producers (the context-update command) but
no place in the pipeline spine. Recommendation: the wiki tree reader goes in `@vn/store`
(walk, front-matter, tags, nothing clever); retrieval goes in a **new `@vn/bible` package**
between `store` and `authoring` in the graph, forbidden from `pipeline`/`scheduler` like the
rest of the input side. Keeping retrieval out of `store` keeps `store` policy-free, and
keeping it out of `authoring` lets the desktop main process serve wiki search to the UX
without importing the agent.

**Grep-first, embeddings later.** The requirement explicitly allows "grepping or whatever".
Start with: (a) a walked index of wiki files with title/tags/headings, (b) a ripgrep-style
search tool exposed to the agent (`search_bible`) and to the UX as a command, (c) the top-N
excerpt convention the agent already uses for scene chunks. An embedding store is an
*implementation upgrade behind the same seam* — design `@vn/bible`'s interface as
`query(text) → ranked excerpts` from day one so swapping grep for embeddings never touches a
caller. Do not take a vector-DB dependency in the first plan.

**Own-repo option** is §4's problem (the repo map); the bible package itself must simply
never assume `wiki/` and the project root share a `.git`.

## 3. Base assets vs project assets

**Today.** One flat content-addressed store — every generated byte at
`vngen/build/assets/<hash>.<ext>` with one `manifest.json` written through the single-writer
queue. The base/project distinction exists only as `AssetKind`
(`location_ref | portrait | model_sheet | outfit_sheet` vs `shot_image`) and in
`Asset.satisfies` (`packages/types/src/entities.ts:201-222`).

**Requirement.** Base assets (character sheets, location refs) in their own folder subtree,
optionally their own git repo; project assets associated with specific — possibly multiple —
scenes or shots.

**What must not move.** Content addressing is the dedupe and provenance contract. Task
identity hashes normalized prompt + ordered **ref hashes** + model + params — not paths — so
splitting the store into two roots does not disturb a single task hash. That is the fact that
makes this migration safe.

**Migration path.** Give the asset store a *root per kind class*: a `base/` subtree (its own
`assets/` + manifest) for the four base kinds, the existing `vngen/build/` for `shot_image`.
Reads consult both manifests (they cannot collide: hashes are content hashes, and a byte that
exists in both is literally the same byte). The single-writer queue becomes one queue per
manifest. `Asset.satisfies` already carries the association — "possibly multiple scenes or
shots" means `satisfies` grows from a single record to allowing a list, which is a schema
migration with a trivial reader shim (a lone record reads as a one-element list).

**Decisions to settle in the plan:** (a) the base root's on-disk location and whether it is
`assets/` at the project root (authored-side, committable, own-repo-able) or stays under
`vngen/` — the requirement's "own folder subtree… may optionally be in their own git repo"
argues for the project root; (b) what `vngen status` and the FLOOR views report when the base
repo is absent (a clone without the asset submodule must degrade to "unavailable", not
"everything is stale — regenerate", or a checkout error costs real money).

## 4. Repo map, commit-on-save, and undo

**Today.** One repo assumed at the project root. `@vn/git` is already per-directory (every
call takes a cwd), so multi-repo needs no new plumbing — it needs a **resolver**: given an
absolute path, which repo root owns it. Commit policy today is: vnauthor commits once per
approved plan; desktop commands append provenance to `commands.jsonl` but do not commit;
undo restores shadow snapshots under `refs/vn/undo/<seq>` and **never touches HEAD or the
index**, refusing when the worktree drifted.

**Requirement.** Saving files also commits. The app auto-commits existing files at project
creation. Wiki and base assets may be separate repos.

**The conflict to resolve honestly.** Commit-per-command was one of the five strategies
surveyed in [`../gitUndoOptions.md`](../gitUndoOptions.md) and *lost* to shadow snapshots —
but it lost under the constraint "don't pollute the author's history", and the requirement
has now changed that constraint: the author's history is *supposed* to record every save.
The survey's losing option and the shipped option can coexist, though, and that is the
recommendation:

- **Every save/command commits to the owning repo** (via the resolver), small message,
  provenance id in the trailer, matching the `CommandRecord` already written to
  `commands.jsonl`.
- **Undo/redo keeps the shadow-ref mechanism** — it is what makes undo refuse rather than
  guess, and it never rewrites history. An undo after commit-on-save produces a *new*
  commit restoring the prior tree (revert-shaped), never a reset. The "worktree drifted"
  refusal actually gets *stronger* under commit-on-save, because a clean worktree becomes
  the norm rather than the exception.
- Multi-repo undo: a command whose plan spans repos (rare — the resolver should make most
  writes single-repo) snapshots and commits per repo, and refuses if any one repo drifted.

**Project bootstrap** (directory picker UI aside): `git.init` + `git.config` exist; add the
"commit whatever is already there" step and the resolver's initial map. This is small and
should ride along with whichever plan lands the resolver.

**Decision to settle in the plan:** whether pipeline runs (which write hundreds of files
under `vngen/build`) commit per run, per wave, or are excluded from commit-on-save the way
`vngen/build` + `vngen/state` are already excluded from undo snapshots. Recommendation:
authored saves commit individually; a pipeline run commits once at exit — a run is one
event in the story of the project, not five hundred.

## 5. Outfits at scene and shot level

**Today.** `Outfit` is a first-class entity with sheets; `Character.defaultOutfit` names the
fallback; `ShotSubject.outfit` is *already per-shot* — but it is filled by the P5 decomposer,
not authored. There is no scene-level outfit at all, and no authored way to say "Ada wears
the uniform in this scene".

**Requirement.** Outfits optionally specified at the scene or shot level.

**Shot level is nearly free.** `work/shots/<sceneId>.json` already follows the rule
"authored fields at top level, run output under `shotData`", and it has exactly two writers
outside the planner. An authored `subjects` override (or per-subject `outfit` override) at
top level, respected by `buildShotPrompt`, is a natural extension — and because outfit
*does* enter the prompt, changing it re-hashes the task and re-renders the shot, which is
precisely the right cost model (contrast `coversLines`, which deliberately does not).

**Scene level is where the design question lives.** A scene-level outfit is authored scene
metadata, and the scene chunk's front-matter is currently **identity and nothing else** — a
closed schema, `scene: <id>`, with everything semantic living as Fountain elements and
`[[…]]` markers in the body. [`../plans/index.md`](../plans/index.md#decisions-that-span-the-batch)
already marks that decision for revisit "once 4–7 had shipped, against working editors" —
and notes nothing had wanted a field there yet. **Outfits are the first field that wants
in.** Two honest options:

- `[[outfit: ada=uniform]]` as a body marker, like `[[scene:]]`/`[[next:]]` — keeps
  front-matter closed, survives `vngen screenplay` round-trips for free, costs a parser
  extension.
- An `outfits:` map in front-matter — opens the schema, reads better for a structured
  editor, but front-matter does not travel through the Fountain projection today.

Recommendation: the body marker, because the export/import pair (`vngen screenplay` /
`vngen import`) already round-trips markers and would silently drop front-matter fields —
choosing front-matter means also extending that pair, which is strictly more work for the
same meaning. The plan should still record the front-matter revisit as *considered and
declined again*, or take it — but deliberately, not by drift.

## 6. Shot ordering

**Today.** Shots are a persisted decomposition keyed by `coversLines`; the scene's `lines`
array is the only order authority, and shot "order" is an artifact of which lines each shot
covers. Nothing reorders shots as such; the timeline reorders *lines* (`script.moveLine`),
and `@vn/scriptedit`'s `shotfallout` carries coverage across split/merge/delete.

**Requirement.** "Shots can be reordered inside of scenes" — and the requirement's script
model is scenes → shots → lines, with shots as the containers ("lines … are collected into
shots"), explicitly relevant to the manga/storyboarding ambition.

**The decision that must precede the plan.** There are two readings, with very different
costs:

- **Reorder = move the covered lines.** A shot reorder is sugar over the existing line-move
  machinery: move the shot's covered block of lines as a unit; order stays derived from
  coverage. Cheap, no schema change, no new invariant — but it *means* reordering the prose,
  which is a real authorial act with real consequences (the playable's beat order changes).
- **Shots become first-class ordered containers.** An `order` field (or an ordered shot
  list) independent of line order. This contradicts the current model where lines are the
  substrate and shots bind to them — two orderings of one scene must then be reconciled
  everywhere (playable projection, timeline, drift, coverage gaps), and "a shot covering
  lines that appear before another shot's lines, yet ordered after it" needs a defined
  meaning in the runner.

Recommendation: the first reading, because in a *visual novel* the prose order is the
presentation order and a second ordering has no runtime meaning — the playable replays
lines. Revisit only if/when the manga/storyboard mode arrives, where panels genuinely order
independently of script order; note it in the plan as the known trigger for the second
model. Either way the op belongs in `@vn/scriptedit` beside its siblings, so the desktop
and vnauthor share it.

## 7. Agent context regeneration

**Today.** Context is *loaded* (built-in contract > `AICONTEXT.md` + imports > inferred
defaults), never *generated*. Nothing writes an index for the agent.

**Requirement.** The user can manually invoke a context update that regenerates "whatever
index files (or tree of index files) or agents.md or whatever the ai agent uses"; eventually
automatic.

**Migration path.** A command (working name `workspace.reindex`) that walks the wiki + tag
index (§1–2) and writes a generated context file — generated meaning: marked as such,
regenerable at will, committed like everything else (§4), and **read through the existing
precedence chain** rather than a new one (slot it below `AICONTEXT.md`, above inferred
defaults, so a hand-written `AICONTEXT.md` still wins). The `@vn/bible` index (§2) and this
generated summary are producer and cache of the same walk — one plan, one walker.
"Automatic later" then reduces to invoking the same command from the places that invalidate
it (entity create/delete, wiki save), which commit-on-save makes observable.

## 8. Backlink and document-tree index

**Today.** `WorkspaceIndex` (served over `workspace:index`) carries titles, characters,
diagnostics — enough for the current rail, nowhere near the required sidebar: logical
document tree (wiki tree + assets + script tree down to shots), full-file-tree mode, and a
characters tree whose click shows bible file + base assets + every scene and shot the
character appears in.

**The point worth making:** this is a *projection*, not new state. Every edge already
exists somewhere — character → scenes from the model's cast lists; character → shots from
`ShotSubject.characterId`; character → base assets from `Asset.satisfies`; character →
bible file from the tag index (§1). The work is one function that joins them into a
serializable index shape, an extension of `WorkspaceIndex` (or a sibling
`workspace:doctree` channel to keep the hot index small), and invalidation on the same
events that already bump `revision`. It should be near-last in sequence — it reads what
§1, §2, §3 and §5 produce — and it is pure enough to live wherever `WorkspaceIndex` is
assembled today, with tests beside it.

## Sequencing and the layering picture

Dependency order (also mirrored in
[`../plans/refactorTaskList.md`](../plans/refactorTaskList.md)):

1. **§1 tag discovery + source-path-carrying `LoadedInputs`** — foundation; §2, §5's
   diagnostics and §8 all sit on it. No behavior change for existing projects.
2. **§4 repo map + commit policy** — blocks §2's own-repo option, §3's own-repo option, and
   bootstrap. The gitUndoOptions revisit happens here, once.
3. **§2 wiki + `@vn/bible` (grep-first)** and **§3 asset split** — independent of each
   other; parallelizable.
4. **§5 outfits** and **§6 shot ordering** — both touch `work/shots/<sceneId>.json` and the
   scene chunk grammar; order them relative to each other when planned.
5. **§7 context regeneration** — consumes §2's walker.
6. **§8 backlink index** — reads everything, changes nothing; last.

New packages: `@vn/bible` (between `store` and `authoring`, pipeline-forbidden). Everything
else lands in existing packages: `types` (tags, `satisfies` list, outfit override), `parse`
(tag key, outfit marker), `store` (wiki walk, doc shape promotion, dual-root asset store),
`git` (resolver — mechanism only, policy stays in the hosts), `scriptedit` (shot reorder),
`authoring` (`search_bible` tool, reindex), `commands`/desktop main (new commands + index
shapes). The pipeline spine is touched exactly once, deliberately: `buildShotPrompt`
honoring the authored outfit override — a change that *should* re-render shots, and does so
through the existing hash mechanism rather than around it.

## Decisions a plan must settle (collected)

| # | Decision | Leaning stated above |
| --- | --- | --- |
| 1 | Entity id from tag vs filename | Filename, same rule as scenes |
| 2 | Retrieval seam | `query(text) → excerpts`; grep first, embeddings behind the same interface |
| 3 | Base asset root location | Project root (committable, own-repo-able), not under `vngen/` |
| 4 | Commit-on-save × undo | Commit per save via resolver; undo keeps shadow refs, restores as new commits |
| 5 | Pipeline-run commit granularity | One commit per run |
| 6 | Scene-level outfit syntax | `[[outfit: …]]` body marker, not front-matter |
| 7 | Shot reorder semantics | Move-the-covered-lines; first-class order deferred to a manga/storyboard mode |
