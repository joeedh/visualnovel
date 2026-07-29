# Scene chunk files

Status: **in progress** — steps 1–9 of 10 are shipped: the format exists, a `scenes/` project
loads, builds, validates and is **written** to by the branch and line-id writers, every
`@vn/testkit` fixture is one file per scene by default, and `examples/sample` is authored that
way. Only the docs outside this file still describe the old layout (step 10). Move two of
[`../research/scene-chunks-as-the-authored-unit.md`](../research/scene-chunks-as-the-authored-unit.md),
after [`allocated-line-ids.md`](allocated-line-ids.md) and
[`lossless-scene-serialization.md`](lossless-scene-serialization.md). It changes where a scene
lives, and nothing else: no editor, no new commands beyond the ones that must be retargeted.

<!-- toc -->

<!-- tocstop -->

## Why

`screenplay/*.fountain` is one contended document. Two writers collide on it, the branch editor's
surgical patcher exists partly to make that survivable, and adding "the author is typing in it"
makes the contention continuous rather than occasional. Per-scene chunks make it go away by
construction — the same move `work/shots/<sceneId>.json` already made for decompositions, for the
same reason.

The blast radius of a bad write shrinks with it. Today a malformed patch can damage every scene in
the project; with chunks it can damage one, and the scene it damages is the one being edited.

## The shape

**`scenes/<id>.md` at the project root, beside `characters/` and `locations/`.** Front-matter
carries the scene's **identity and nothing else**; the body is a one-scene Fountain screenplay,
heading included. Same loader (`@vn/parse`'s `frontmatter.ts`), same `fromDoc`/`toDoc` round-trip
the other two entities have, same "authored input lives at the root, generated output lives under
`vngen/`" rule.

```markdown
---
scene: arrival
---

EXT. SCHOOL GATE - AFTERNOON

= Aiko is waiting at the gate, and has been for a while.

[[nextline: 12]]

[[line: L1]]
Rain ticks off the gate.

AIKO
[[line: L4]]
Um… hello.

[[choice: "Introduce yourself" -> greet]]
[[next: rooftop]]
```

Three notes on the format, each of which is a decision rather than an accident:

- **The scene id is front-matter, not a `[[scene:]]` marker.** The filename and the `scene:` key
  must agree, and a mismatch is an error rather than one silently winning. `[[scene:]]` in a chunk
  body is ignored with a warning; it is the single-file form's mechanism, not this one's.
- **Every other field stays in the body, and the front-matter schema is closed.** `splitScenes`
  already recovers all of them from a body — `location` and its time-of-day variant and the heading
  prefix from the heading (`scenes.ts:112`), `synopsis` from the `=` element, `choices` / `next` /
  `nextLineId` / line ids from `[[…]]` markers — and `sceneToFountain` already writes all of them
  back losslessly. A front-matter copy of any one of them would be a second source of truth for a
  field that already has one, so an unrecognized front-matter key is an **error** rather than a
  silently ignored line. This settles the `next:` question below: it is a body marker, and a test
  pins that.
- **The body is a complete scene, heading and all.** So the chunk reader is
  `parseFountain(body)` → `splitScenes` → expect exactly one scene, and the writer is
  `sceneToFountain` unchanged. No second serializer, and plan 2's `parse(write(scene)) ≡ scene`
  keeps covering the whole file rather than covering the body while the fields drift.

An earlier draft of this plan put `location`, `heading`, `synopsis`, `next` and `nextLineId` in
front-matter, on the grounds that keeping the raw heading as a field means the body never has to be
re-derived from a slug. [`lossless-scene-serialization.md`](lossless-scene-serialization.md) took
that reason away — `Scene` now carries `headingPrefix` and `locationVariant`, and `headingFor` is
gone — so the body-only form gets the same guarantee without the duplication.
**Revisit this once plans 4–7 have shipped**: the editing commands and the STUDIO script mode are
what will show whether greppable structured fields are worth a second writer, and that is a
judgement best made against working editors rather than ahead of them.

### Scene order stops being a fact, and one thing depends on it

`buildModel` sets `const entry = sceneList[0]?.id` (`packages/model/src/build.ts:154`), documented
on `ProjectModel.entry` as "first scene in the screenplay". Files in a directory have no order —
`readdir` gives an arbitrary one that looks alphabetical until it isn't — so **the entry scene
becomes ambiguous the moment scenes are files**, and it silently becomes whichever scene sorts
first. Everything downstream inherits it: `computeReachable` starts there, dead-scene detection is
derived from it, and `story.play.json`'s `start` is it.

So chunking requires an explicit entry. `start:` in `project.yaml` is the right home — it is
scene-level project configuration, `@vn/config` already validates that file, and the playable
already has a `start` field to fill from it. A missing `start` is an **error diagnostic** naming
the fix, not a fallback to sorted-first: a project whose entry scene is chosen by filename
alphabetics is a project that will one day silently start somewhere else.

Nothing else depends on file order. There is no implicit fallthrough — `next` comes only from a
marker (`packages/model/src/scenes.ts:87`), so a scene with no `next` and no choices is a leaf
today and stays one.

### Both forms load, until the importer exists

`loadInputs` prefers `scenes/` when it exists and falls back to `screenplay/` when it does not.
Not forever — [`fountain-import-export.md`](fountain-import-export.md) is what retires the
fallback — but during this move it is what keeps `examples/sample`, every `@vn/testkit` fixture,
and every existing user project working while the chunk path is built. **A project with both is an
error**, not a merge: two sources of truth for one scene is the failure this whole direction
exists to prevent.

## What has to be retargeted

The format is the easy half. Four call sites duplicate the same
`loadInputs` → `parseFountain` → `buildModel` sequence, and they are the real scope:

| Call site | What it assumes |
| --- | --- |
| `apps/cli/src/project.ts:26` | one `scriptText` |
| `apps/desktop/src/main/session.ts:114` | one `scriptText` **and** `scriptPath`, carried on `LoadedProject` for the branch editor to patch |
| `packages/authoring/src/workspace.ts:89` | plus `screenplayFile()` for the index, and `INPUT_GLOBS` in `tools.ts:150` |
| `packages/testkit/src/project.ts:162` | `reload()`; and `makeProject` writes `screenplay/script.fountain` from `SCRIPTS` |

Four copies of one sequence is three too many for a change that alters it, so collapsing them is a
prerequisite of the move, not a tidy-up: doing it after means making the same edit four times and
discovering the fourth in a test that only runs on a machine with the asset corpus.

**Where the collapsed function lives is constrained by the layering.** `@vn/store` may import only
`types`, `util` and `parse` (`eslint.config.mjs:20`), so it cannot call `buildModel` — a single
`loadProjectModel` in `@vn/store` is not available without widening the graph, which would also
hand `@vn/model` to `taskgraph` and `scheduler` transitively, both of which exclude it on purpose.
So the sequence splits along the seam that already exists:

- **`@vn/parse` owns `LoadedInputs`** — it owns `FrontMatterDoc`, and `@vn/types` cannot name that
  shape without duplicating it. One declaration, imported by the reader and the builder alike.
- **`@vn/store` keeps `loadInputs(paths)`** — all of the disk reading, none of the model.
- **`@vn/model` gains `modelFromInputs(inputs, { title })`** — the one place `parseFountain` and
  `buildModel` are sequenced. It takes the config fields it needs rather than a `ProjectConfig`,
  because `@vn/model` does not depend on `@vn/config` either.

Each of the four call sites becomes two calls, and when `scenes/` arrives exactly two files change:
`store/worktree.ts` (read `scenes/`, fall back to `screenplay/`) and `model/build.ts` (consume
`sceneDocs`, take `entry` from `config.start`).

Then the writers:

- **`applySceneBranchEdit` patches one chunk instead of the screenplay.** Its total re-parse safety
  net survives intact and gets cheaper — re-parsing one scene rather than the file. The header
  comment's "Assumes a single screenplay file" (`branchpatch.ts:198`) is what changes.
- **`session.editBranches` and `story.setCoverage` are unaffected in shape**, but
  `LoadedProject.scriptPath` becomes per-scene. The rule it encodes — a writer patches the same
  file the model was built from, rather than re-deriving which file that is — is exactly the rule
  worth keeping when there are many files, so it becomes `Scene`-scoped rather than dropped.
- **`@vn/store` gets `scenes.ts`, sibling to `shots.ts`**, as the only place on-disk chunk maps to
  in-memory `Scene`. `shots.ts` is the model to copy, including its "the file is human-editable, so
  a malformed one throws rather than being silently rewritten" behaviour.

### A naming collision that already exists

`ProjectPaths.sceneFile(id)` returns `vngen/work/scenes/<id>.md` and `writeSceneFile` writes it —
both are **dead code**, with no callers outside `paths.ts` and `worktree.ts` themselves. Authored
chunks want the name `sceneFile`, at the project root. Delete the unused pair in this plan rather
than working around it, and do it in its own commit so the deletion is visible as a deletion.

## Failure modes

| Failure | What happens | Guard |
| --- | --- | --- |
| Filename and `scene:` disagree | two ids for one scene; shots bind to the loser | error diagnostic naming both |
| Front-matter names a field the body owns | two sources of truth; whichever the reader prefers wins silently | closed schema — an unrecognized key is an error |
| Two chunks claim one id | one silently wins by readdir order | error diagnostic listing both files |
| `scenes/` and `screenplay/` both present | model built from one, edits written to the other | error diagnostic; refuse to load |
| No `start:` in `project.yaml` | entry chosen alphabetically, project starts elsewhere after a rename | error diagnostic |
| `start:` names a missing scene | empty playable | error diagnostic, same class as `dangling_goto` |
| A chunk is malformed | scene silently absent; its shots orphaned | throw, as `readShots` does |

Every one of these is an error diagnostic rather than a throw except the last, and step 6 of
[`allocated-line-ids.md`](allocated-line-ids.md) is why that is now safe: diagnostics have a
surface. Before that plan lands they would be produced and rendered nowhere.

## Steps

1. ✔ **`modelFromInputs` in `@vn/model`**, `LoadedInputs` in `@vn/parse`, the four call sites
   converted, no behaviour change. Green `pnpm check` / `pnpm test` before anything else moves.
2. ✔ **Delete `sceneFile`/`writeSceneFile`.** The dead `work/scenes/` pair, on its own.
3. ✔ **`@vn/types`: the chunk schema.** `sceneFrontMatter` for the front-matter, named and validated
   like `characterFrontMatter` / `locationFrontMatter` but `.strict()`, since identity is all it
   holds. It replaces the dead schema of the same name — which was never imported anywhere and
   declared `choices` / `next` / `location` as front-matter, the opposite of the decision above.
   `start` added to the `project.yaml` schema (in `@vn/types`; `@vn/config` only parses it),
   optional at the schema level because the missing-`start` error is a model diagnostic in step 6
   and the `screenplay/` fallback path does not need one.
4. ✔ **`@vn/store`'s `scenes.ts`.** `readSceneChunk` / `readSceneChunks` / `writeSceneChunk` deal
   in docs, not `Scene`s — the same seam step 1 split along — and `sceneFromDoc` / `sceneToDoc` in
   `@vn/model` sit beside the other two entities' pair, reusing `sceneToFountain` for the body.
   `SceneChunkDoc` (`id` = filename stem, `file`, `doc`) joins `LoadedInputs` in `@vn/parse`. Two
   options were needed to keep one parser and one writer serving both formats:
   `splitScenes(script, { sceneId })` forces the id **before** line ids are composed, so a chunk's
   lines come out `${filename}:L<n>` rather than being renamed afterwards, and
   `sceneToFountain(scene, { sceneMarker: false })` omits the `[[scene:]]` line that front-matter
   now owns. `roundtrip.test.ts`'s `survives` checks both forms of every case it already had.
5. ✔ **`loadInputs` reads both forms.** `scenes/` preferred, `screenplay/` fallback, both-present an
   error. `LoadedInputs` grows scene docs; `scriptText`/`scriptPath` stay for the fallback path. It
   also grew `diagnostics`, because "this project holds both forms" is a verdict the loader reaches
   and only the model reports; a both-present project loads as **neither** form, not as one of them.
6. ✔ **`buildModel` takes scenes, not just a script.** `BuildInputs.sceneDocs` alongside `script`;
   `entry` from `config.start` with the diagnostics above. `splitScenes` is unchanged — it still
   handles the fallback path, and a chunk body goes through `parseFountain` + `splitScenes` per
   file, which is what keeps one parser rather than two. Shipped as **one commit with step 5**:
   separately, there is an intermediate state where a `scenes/` project loads to an empty model.
   `sceneDocs` / `start` / `diagnostics` are all optional on `BuildInputs` so the existing
   hand-built-inputs tests still compile. A chunk that fails to read is one error diagnostic and
   the other chunks still build.
7. ✔ **Retarget the writers.** `applySceneBranchEdit` takes an optional `sceneId`: a chunk body
   never names itself, so the id is forced onto the one scene the body may hold, and a body with
   two headings (or none) is a refusal rather than a guess. `session.editBranches` and
   `writeLineIds` work off a `SceneSource[]` derived from the same `loadInputs` result the model
   was built from — so a writer cannot re-decide which file is authoritative — and both **compute
   every patch before writing any**, because a splice spanning three chunks that is refused on the
   third has to leave the first two alone. `previewLineIds` and `writeLineIds` became wrappers over
   one `planLineIds`, which makes the preview literally the decision the write makes. Front-matter
   is **spliced, never re-serialized**: `SceneChunkDoc` carries the file's bytes and `@vn/parse`
   gained `splitFrontMatter`, so a rewire keeps the author's YAML — key order, spacing, comments —
   byte-exact, which round-tripping through `stringifyFrontMatter` would not. On the authoring
   side `scenes/` joined `INPUT_GLOBS`, the workspace index names the file each scene lives in and
   reports no screenplay when chunks are what the model was built from, and the built-in input
   contract in `context.ts` describes both forms and that a project holds exactly one.
8. ✔ **`@vn/testkit` writes chunks.** `makeProject` gained
   `{ format: 'chunks' | 'screenplay' }`, defaulting to **chunks**, with `SCRIPTS` converted by
   the same code path step 4 provides; `synthProject` inherits it, so the scale fixture is one
   file per scene too. Shipped in **two commits**: the option itself landed **before** step 7,
   because the writers can only be tested against a real chunk project and only testkit can build
   one, and flipping the default came after. Two desktop describes are pinned to
   `format: 'screenplay'` so the fallback keeps its coverage — branch editing there is every scene
   sharing one file, and a script written as one file is what arrives with no line-id marks. The
   acceptance criterion for step 9 is proved here at fixture scale: a full approve-and-run in each
   format plans **identical task hashes**.
9. ✔ **Convert `examples/sample`.** Five `scenes/<id>.md` files and `start: arrival`; each body is
   the screenplay block it came from, minus the `[[scene:]]` marker, so the diff is a move rather
   than a rewrite. Converted by hand rather than by the step-4 writer, deliberately: the writer
   would also stamp `[[line:]]`/`[[nextline:]]` on every line, and the shipped template is more
   useful showing the minimum a chunk may be — an unmarked body, which is also the input
   `assignLineIds` exists for.

   **Nothing rehashed.** A throwaway test planned both forms of the sample through two waves and
   compared sorted `kind + hash`: identical. So are `vngen graph`, `vngen cost` and the exported
   `story.play.json`, byte for byte, between a screenplay-form copy and the converted one.

   Three tests read the sample directly, and each moved to what it was actually testing:
   `branchpatch.test.ts`'s generated sweep is now two sweeps — the sample's chunks (one scene per
   file, id forced from front-matter) and `SCRIPTS.branching` for the multi-scene property that no
   _other_ scene's markers move; `lineids.test.ts` sweeps the sample's unmarked chunk bodies.
   `apps/desktop/src/main/tests/sample.test.ts` is new and is the only test that opens the
   **committed** template: `seedWorkspace` into a scratch dir, then index, graph and one rewire.
   The sample's `AICONTEXT.md` and its `new-character` skill described the screenplay form to the
   authoring agent and now describe chunks.

   An `examples/mySampleRepo` seeded before the conversion stays on `screenplay/`, which still
   loads — `seedWorkspace` never re-copies over a working copy, by design. Delete it to get the
   chunk form.
10. **Docs.** This file's As-shipped section; `CLAUDE.md`'s project-layout and `@vn/store` sections;
    `docs/vn-generator-report.md` §9.1; `docs/fountain.md` on what a chunk body may contain.

## Not in this plan

- **Editing.** No commands that change prose, no UI. This plan moves the file; it does not make
  anything write to it beyond the branch/coverage writers that already existed.
- **Retiring `screenplay/`.** The fallback stays until the importer exists. Deleting the only
  supported input format in the same change that introduces its replacement leaves no way back.
- **Splitting or merging scenes.** Creating and deleting chunk files is a
  [`scene-editing-commands.md`](scene-editing-commands.md) concern; this plan only reads and
  rewrites existing ones.
- **A directory layout per act, or nested `scenes/`.** Flat, one level, like `locations/`. Ordering
  and grouping are presentation and belong to `start` and the branch graph.

## Alternatives considered

- **Keep one file, add file locking.** Solves concurrent writes and not the blast radius, and a
  lock across an interactive editing session is a lock held for minutes.
- **One JSON file per scene.** Rejected in the research doc for the reason that governs the whole
  direction: prose stops being diffable, and a retyped paragraph becomes an unreadable diff.
- **`vngen/work/scenes/` instead of the project root.** Wrong tree. `vngen/` is output; a scene is
  authored input, and putting it under `work/` makes "delete `vngen/` and re-run" destroy the
  screenplay.
- **Derive the entry scene from the graph** — the scene nothing points to. Ambiguous in a story
  with more than one such scene, and wrong the moment a branch loops back to the opening.
