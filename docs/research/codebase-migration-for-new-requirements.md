# Migrating the codebase to the new requirements

Describes how the existing packages (everything except the desktop renderer, whose path.ux rewrite is
tracked separately) get from what is shipped to what
[`../history/designRequirementsEtc.md`](../history/designRequirementsEtc.md) asks for. This document is the
input to the individual plans listed in [`../plans/refactorTaskList.md`](../plans/refactorTaskList.md); it
maps each requirement onto the packages it touches, states the migration path, and names the design
decisions that must be settled before a plan is written.

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

Each section below takes one requirement, states what exists today and names the file that shows it, states
what the requirement demands, gives the smallest migration that satisfies it without breaking a shipped
contract, and names any decision a plan must settle first. This document treats the contracts in
[`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md) as fixed, and rejects any
migration that breaks content-addressed task identity, the lossless scene round-trip, or the
single-write-path rule, even where that migration would be less code.

The renderer itself and the §UX pane/editor requirements are out of scope, and belong to the path.ux
rewrite plan. Everything a new editor would present is in scope, because the requirements' features (wiki
trees, backlinks, outfit pickers, shot reordering) all bottom out in packages, commands and index shapes on
this side of the IPC seam.

## Where the requirements already hold

This point comes first because it bounds the work:

- **Approval pipeline, base-assets-first, AI pre-check.** The P3 gate acts as a barrier and orders base
  assets ahead of scene rendering, and the P7 reviewer critiques generated art before a human sees it. This
  implements the "Approval Pipeline" section of the requirements.
- **Scene tree ordered by decisions.** Scenes form a graph through `choices` and `next`. The branch
  editor's `story.*` commands reorder scenes by editing those decisions.
- **The agent can drive the app.** The command registry, `view.*` effects, the JSON catalog and CDP
  implement the requirement that an AI agent be able to help the user drive the app. All four are shipped
  and tested.
- **Projects are stored in git repos.** `@vn/git` exists, vnauthor commits per approved plan, and undo is
  built on git plumbing. What is missing is policy (commit-on-save, multi-repo), not capability.

The gaps are therefore the story bible, tag-based entity discovery, the asset split, scene/shot outfits,
shot ordering, commit-on-save + multi-repo, context regeneration, the backlink index, and project
bootstrap. Each is taken in turn.

## 1. Entity discovery by meta tag

Today, `@vn/store` is the only reader, and discovery works by path convention:
`ProjectPaths.characterFile(id)` is hard-coded `characters/<id>/character.md`
(packages/store/src/paths.ts:18), locations are `locations/*.md`, and `loadInputs` walks those two
directories (packages/store/src/worktree.ts:45). The requirement instead says character and set-location
files are story bible files identified via some kind of meta tag, so they are discovered by content rather
than by location.

The file format barely moves. Character and location files are already markdown with YAML front-matter,
parsed by `parseFrontMatter` and validated by the zod schemas in `@vn/types`; the round-trip serializers
(`*ToDoc` / `apply*Edit`) and the byte-exact `splitFrontMatter` splice all survive unchanged. Only the way
the reader finds the files changes.

The structural gap is that `LoadedInputs.characterDocs` and `.locationDocs` are bare `FrontMatterDoc[]` and
carry no source path (packages/parse/src/inputs.ts:29-30). Only scenes carry `file` and `text`
(`SceneChunkDoc`). Path convention made that tolerable, because a writer can re-derive the path from the
id. Tag discovery does not, because the path is whatever file carries the tag. So the first change is
mechanical and wide: character and location docs move to the `SceneChunkDoc` shape (id + absolute `file` +
`doc` + `text`), and the writers retarget at the carried path. This also strengthens the shipped contract
that "a writer patches the file the model was built from" rather than weakening it. Today that contract
holds for scenes and is merely un-falsifiable for characters.

**Migration path.**

1. Add `type: character` / `type: location` (name the key in one place in `@vn/types`) to the
   front-matter schemas, optional at first.
2. 2. Extend `loadInputs` to scan the wiki subtree (§2) for tagged files as well as the conventional
   directories. A file in a conventional directory takes its tag from its location.
3. 3. Report diagnostics for the conflicts that tag discovery introduces: two files claiming the same
   character id, a tagged file that fails the schema, a conventional file and a tagged file for the same
   id. Follow the `stray_screenplay` precedent: report the conflict, prefer one file deterministically, and
   never guess silently.
4. 4. The conventional path becomes legacy only once the desktop and vnauthor both create entities through
   templates (§UX workflow). Existing projects are not migrated by force. This matches how `screenplay/`
   was retired: the old form is reported rather than read two ways forever.

**Decision to settle in the plan:** The plan must decide whether the id comes from the tag (`character:
ada`) or is derived from the filename as scenes do. A scene writes `scene: <id>` with an id matching the
filename, and the tag carries identity and nothing else. The recommendation is to apply the same rule as
scenes: the tag names the type, the id must match the filename, and a mismatch is a diagnostic. One
identity rule across the project is worth more than allowing filenames to be chosen freely.

## 2. The story bible (`wiki/`)

Today no package reads a `wiki/` tree. The agent's context is the built-in input contract plus
`AICONTEXT.md` (with nested files and `@import`s), loaded whole by `packages/authoring/src/context.ts`.

**Requirement.** The agent works against an arbitrary markdown tree under `wiki/`. It reaches that tree by
retrieval (embeddings or grep) and never pastes the tree whole into context. The tree may be its own git
repo. It holds two special file types, characters and set locations, described in §1.

**Where it lives in the layering.** Reading the wiki is input-side file reading, which is `@vn/store`'s
charter ("the only reader of a project's files"). The retrieval index differs. It has consumers (the agent)
and producers (the context-update command) but no place in the pipeline spine. The recommendation is to put
the wiki tree reader in `@vn/store` (walk, front-matter, tags, nothing clever) and retrieval in a new
`@vn/bible` package, which sits between `store` and `authoring` in the graph and is forbidden from
`pipeline`/`scheduler` like the rest of the input side. Keeping retrieval out of `store` keeps `store`
policy-free, and keeping it out of `authoring` lets the desktop main process serve wiki search to the UX
without importing the agent.

**Grep-first, embeddings later.** The requirement explicitly allows "grepping or whatever". Start with (a)
a walked index of wiki files with title/tags/headings, (b) a ripgrep-style search tool exposed to the agent
(`search_bible`) and to the UX as a command, and (c) the top-N excerpt convention the agent already uses
for scene chunks. An embedding store can replace grep later behind the same interface. Design `@vn/bible`'s
interface as `query(text) → ranked excerpts` from day one, so that swapping grep for embeddings never
touches a caller. Do not take a vector-DB dependency in the first plan.

§4 covers the own-repo option through the repo map. The bible package must never assume that `wiki/` and
the project root share a `.git`.

## 3. Base assets vs project assets

Today every generated byte lives in one flat content-addressed store at `vngen/build/assets/<hash>.<ext>`,
with one `manifest.json` written through the single-writer queue. The base/project distinction exists only
as `AssetKind` (`location_ref | portrait | model_sheet | outfit_sheet` vs `shot_image`) and in
`Asset.satisfies` (packages/types/src/entities.ts:201-222).

**Requirement.** Base assets (character sheets, location refs) live in their own folder subtree, and
optionally in their own git repo. Project assets are associated with specific scenes or shots (possibly
with more than one).

**What must not move.** Content addressing defines the dedupe and provenance contract. Task identity hashes
the normalized prompt, the ordered ref hashes, the model and the params (not paths), so splitting the store
into two roots leaves every task hash unchanged. Those unchanged task hashes are what make this migration
safe.

**Migration path.** Give the asset store a root per kind class. The four base kinds get a `base/` subtree
with its own `assets/` and manifest, and `shot_image` keeps the existing `vngen/build/`. Reads consult both
manifests. The two manifests cannot collide, because hashes are content hashes, so a byte that exists in
both is the same byte. The single-writer queue becomes one queue per manifest. `Asset.satisfies` already
carries the association, and supporting "possibly multiple scenes or shots" means `satisfies` grows from a
single record to a list. That change is a schema migration with a trivial reader shim (a lone record reads
as a one-element list).

The plan must settle two decisions. First, it must fix where the base root lives on disk. It could be
`assets/` at the project root (authored-side, committable, own-repo-able), or it could stay under `vngen/`;
the requirement's "own folder subtree… may optionally be in their own git repo" argues for the project
root. Second, it must say what `vngen status` and the FLOOR views report when the base repo is absent. A
clone without the asset submodule must degrade to "unavailable" rather than to "everything is stale —
regenerate", or a checkout error costs real money.

## 4. Repo map, commit-on-save, and undo

**Today.** One repo is assumed at the project root. `@vn/git` is already per-directory (every call takes a
cwd), so multi-repo needs no new plumbing. It needs a resolver that maps an absolute path to the repo root
that owns it. Under today's commit policy, vnauthor commits once per approved plan, desktop commands append
provenance to `commands.jsonl` without committing, and undo restores shadow snapshots under
`refs/vn/undo/<seq>`. Undo never touches HEAD or the index, and it refuses when the worktree drifted.

**Requirement.** Saving files also commits. The app auto-commits existing files at project
creation. Wiki and base assets may be separate repos.

This conflict needs an honest resolution. Commit-per-command was one of the five strategies surveyed in
[`../history/gitUndoOptions.md`](../history/gitUndoOptions.md), and it lost to shadow snapshots. It lost
under the constraint "don't pollute the author's history", and the requirement has now changed that
constraint, because the author's history is supposed to record every save. The survey's losing option and
the shipped option can coexist, which is the recommendation:

- **Every save or command commits to the owning repo.** The resolver names the repo. The commit message
  is small and carries a provenance id in its trailer, matching the `CommandRecord` already written to
  `commands.jsonl`.
- **Undo/redo keeps the shadow-ref mechanism** — the shadow ref is what makes undo refuse rather than
  guess, and undo never rewrites history. An undo after commit-on-save produces a new commit restoring the
  prior tree (revert-shaped), never a reset. The "worktree drifted" refusal holds more firmly under
  commit-on-save, because a clean worktree becomes the norm rather than the exception.
- Multi-repo undo snapshots and commits per repo. A command whose plan spans repos (rare, since the
  resolver should make most writes single-repo) refuses if any one repo drifted.

**Project bootstrap** (directory picker UI aside): `git.init` + `git.config` exist; add the step that
commits whatever files are already present, plus the resolver's initial map. This work is small and should
be included in whichever plan adds the resolver.

The plan must settle whether pipeline runs (which write hundreds of files under `vngen/build`) commit per
run, commit per wave, or are excluded from commit-on-save the way `vngen/build` and `vngen/state` are
already excluded from undo snapshots. The recommendation is that authored saves commit individually and
that a pipeline run commits once at exit, which records the run as a single event rather than five hundred.

## 5. Outfits at scene and shot level

Today, `Outfit` is a first-class entity with sheets, `Character.defaultOutfit` names the fallback, and
`ShotSubject.outfit` is already per-shot, but the P5 decomposer fills it rather than an author. There is no
scene-level outfit at all, and no authored way to say "Ada wears the uniform in this scene".

**Requirement.** Outfits are optional and may be specified at the scene level or the shot level.

Shot level costs almost nothing. `work/shots/<sceneId>.json` already follows the rule "authored fields at
top level, run output under `shotData`", and it has exactly two writers outside the planner. An authored
`subjects` override (or a per-subject `outfit` override) at top level, respected by `buildShotPrompt`,
extends that pattern naturally. Because outfit enters the prompt, changing it re-hashes the task and
re-renders the shot, which is the right cost model; `coversLines` deliberately does not enter the prompt.

The design question arises at scene level. A scene-level outfit is authored scene metadata, and the scene
chunk's front-matter currently carries identity only (the closed schema `scene: <id>`), with everything
semantic living as Fountain elements and `[[…]]` markers in the body.
[`../plans/index.md`](../plans/index.md#decisions-that-span-the-batch) already marks that decision for
revisit "once 4–7 had shipped, against working editors", and notes that no feature had required a field
there yet. Outfits are the first field that requires one. There are two options:

- Write `[[outfit: ada=uniform]]` as a body marker, like `[[scene:]]`/`[[next:]]`. This keeps
  front-matter closed and survives `vngen screenplay` round-trips for free, and it costs a parser
  extension.
- An `outfits:` map in front-matter would open the schema and would read better for a structured editor,
  but front-matter does not travel through the Fountain projection today.

Use the body marker. The export/import pair (`vngen screenplay` / `vngen import`) already round-trips
markers and would silently drop front-matter fields, so choosing front-matter means extending that pair as
well, which is strictly more work for the same meaning. The plan should record the front-matter revisit as
considered and declined again, or should adopt front-matter as a deliberate decision rather than by drift.

## 6. Shot ordering

Today, shots are a persisted decomposition keyed by `coversLines`. The scene's `lines` array is the only
order authority, and shot "order" is an artifact of which lines each shot covers. Nothing reorders shots
directly. The timeline reorders lines through `script.moveLine`, and `shotfallout` in `@vn/scriptedit`
carries coverage across split, merge, and delete.

**Requirement.** The requirement states that "Shots can be reordered inside of scenes". Its script model is
scenes → shots → lines, and shots are the containers, since "lines … are collected into shots". The
requirement calls this explicitly relevant to the manga/storyboarding ambition.

One decision must precede the plan. There are two readings, and their costs differ sharply:

- **A reorder moves the covered lines.** Reordering a shot reuses the existing line-move machinery: it
  moves the shot's covered block of lines as a unit, and order stays derived from coverage. This is cheap
  and needs no schema change or new invariant, but it also reorders the prose, which is an authorial act
  with real consequences (the playable's beat order changes).
- **Shots become first-class ordered containers.** The design adds an `order` field (or an ordered shot
  list) independent of line order. This contradicts the current model, in which lines are the base content
  and shots bind to them: two orderings of one scene must then be reconciled everywhere (playable
  projection, timeline, drift, coverage gaps), and the runner needs a defined meaning for "a shot covering
  lines that appear before another shot's lines, yet ordered after it".

The recommendation is the first reading, because in a visual novel the prose order is the presentation
order and a second ordering has no runtime meaning: the playable replays lines. Revisit that only when the
manga/storyboard mode arrives, where panels order independently of script order. Note it in the plan as the
known trigger for the second model. Either way the op belongs in `@vn/scriptedit` beside its siblings, so
the desktop and vnauthor share it.

## 7. Agent context regeneration

Today the agent loads its context rather than generating it: the built-in contract takes precedence over
`AICONTEXT.md` and its imports, which take precedence over inferred defaults. Nothing writes an index for
the agent.

**Requirement.** The user can manually invoke a context update that regenerates "whatever index files (or
tree of index files) or agents.md or whatever the ai agent uses". The update becomes automatic eventually.

The migration path is a command (working name `workspace.reindex`) that walks the wiki + tag index (§1–2)
and writes a generated context file. Generated means the file is marked as generated, can be regenerated at
will, is committed like everything else (§4), and is read through the existing precedence chain rather than
a new one: it sits below `AICONTEXT.md` and above inferred defaults, so a hand-written `AICONTEXT.md` still
wins. The `@vn/bible` index (§2) and this generated summary come out of the same walk, the index as
producer and the summary as cache, so one plan and one walker cover both. Making the command automatic
later means invoking it from the places that invalidate it (entity create/delete, wiki save), and
commit-on-save makes those invocations observable.

## 8. Backlink and document-tree index

Today `WorkspaceIndex` (served over `workspace:index`) carries titles, characters, and diagnostics. That is
enough for the current rail but not for the required sidebar, which needs a logical document tree (wiki
tree, assets, and script tree down to shots), a full-file-tree mode, and a characters tree where clicking a
character shows the bible file, the base assets, and every scene and shot the character appears in.

This is a projection rather than new state. Every edge already exists somewhere: character → scenes from
the model's cast lists; character → shots from `ShotSubject.characterId`; character → base assets from
`Asset.satisfies`; character → bible file from the tag index (§1). The work is one function that joins them
into a serializable index shape, an extension of `WorkspaceIndex` (or a sibling `workspace:doctree` channel
to keep the hot index small), and invalidation on the same events that already bump `revision`. It should
come near-last in sequence, because it reads what §1, §2, §3 and §5 produce, and it is pure enough to live
wherever `WorkspaceIndex` is assembled today, with tests beside it.

## Sequencing and the layering picture

The dependency order is also mirrored in [`../plans/refactorTaskList.md`](../plans/refactorTaskList.md):

1. 1. **§1 tag discovery + source-path-carrying `LoadedInputs`** — this is the foundation, and §2, §5's
   diagnostics and §8 all depend on it. Behavior does not change for existing projects.
2. 2. **§4 repo map + commit policy** — blocks §2's own-repo option, §3's own-repo option, and bootstrap.
   This is the only place the `gitUndoOptions` revisit happens.
3. 3. **§2 wiki + `@vn/bible` (grep-first)** and **§3 asset split** do not depend on each other, so they
   can run in parallel.
4. 4. §5 outfits and §6 shot ordering both touch `work/shots/<sceneId>.json` and the scene chunk grammar,
   so order them relative to each other when planned.
5. 5. **§7 context regeneration** — consumes the walker from §2.
6. 6. **§8 backlink index** — This step reads everything and changes nothing, so it runs last.

The new package is `@vn/bible`, which sits between `store` and `authoring` and is forbidden in the
pipeline. Everything else lands in existing packages: `types` (tags, `satisfies` list, outfit override),
`parse` (tag key, outfit marker), `store` (wiki walk, doc shape promotion, dual-root asset store), `git`
(resolver mechanism only; policy stays in the hosts), `scriptedit` (shot reorder), `authoring`
(`search_bible` tool, reindex), `commands`/desktop main (new commands + index shapes). The pipeline spine
is touched exactly once, and that change is deliberate: `buildShotPrompt` honors the authored outfit
override. Re-rendering shots is the intended effect of that change, and it happens through the existing
hash mechanism rather than around it.

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
