# Fountain import and export

Status: **shipped** — every step is ticked and [As shipped](#as-shipped) records what changed on
the way. Move three of
[`../../research/scene-chunks-as-the-authored-unit.md`](../../research/scene-chunks-as-the-authored-unit.md).
It depends on [`lossless-scene-serialization.md`](lossless-scene-serialization.md) for the writer
and [`scene-chunk-files.md`](scene-chunk-files.md) for the target, and it is what retired that
plan's `screenplay/` fallback.

<!-- toc -->

<!-- tocstop -->

## Why

"Import once, export always." Two separate obligations that happen to share a serializer:

- **Import** is a migration. Every project that exists today is a `screenplay/*.fountain`, and
  `scene-chunk-files.md` deliberately keeps reading them rather than stranding them. Something has
  to convert one, once, and it should be the tool rather than the user.
- **Export** is an escape hatch, and it is the reason the chunk format is defensible at all. A
  bespoke on-disk layout that only this app can read is a lock-in; one that reconstitutes a
  standard screenplay on demand is a working format. The cost of offering it is low — the
  serializer already exists for other reasons — and the cost of *not* offering it is a question
  every author will eventually ask.

The second is why this lands early rather than whenever it becomes convenient. Export is cheap
now and gets more expensive the longer chunks accumulate fields that Fountain cannot say.

## A name is already taken

`vngen export` writes `vngen/build/story.play.json`, and `story.export` is the desktop command that
does the same (`apps/desktop/src/main/commands/story.ts:251`). Neither may be repurposed, and
"export" without a qualifier is now ambiguous in both surfaces. The names this plan uses:

| Surface | Import | Fountain out |
| --- | --- | --- |
| CLI | `vngen import [dir]` | `vngen screenplay [dir]` |
| Desktop | `workspace.import` | `story.screenplay` |

`screenplay` is the noun the directory already uses, it is unambiguous against `export`, and it
reads correctly as a verbless command ("give me the screenplay"). Whatever is chosen, **the CLI
usage text and the command descriptions must both say which artifact they mean** — the existing
`export` line in `usage()` becomes actively confusing next to a second export.

## Import

**One direction, one time, and it refuses to run twice.** `vngen import [dir]` reads
`screenplay/*.fountain` through the existing `parseFountain` → `splitScenes` path, writes one
`scenes/<id>.md` per scene through the step-4 writer from `scene-chunk-files.md`, and stops.

Four rules, each of which is a way this could go wrong:

- **It refuses if `scenes/` already exists.** Non-empty means either a previous import or authored
  work; re-running would silently overwrite the latter. `--force` is not offered. Deleting the
  directory is a thing the user can do, understands, and cannot misfire.
- **It does not delete the screenplay.** The `.fountain` stays exactly where it is, and the user
  removes it once satisfied. Since `scene-chunk-files.md` makes both-present an **error**, the
  import must therefore leave the project in a state that does not load — which is the wrong
  outcome. Resolve it by moving the original to `screenplay/<name>.fountain.imported` (an extension
  `loadInputs` does not look at), and print the path. A destructive migration that succeeds is
  still destructive if the author disagrees with the result.
- **It allocates line ids as it goes.** The chunks it writes carry `[[line:]]` markers and
  `nextLineId`, via `allocated-line-ids.md`'s allocator rather than a second copy of it. An import
  that wrote unmarked prose would just defer the allocation to first load, which works, but means
  the file the user first opens is not the file the app will keep.
- **It runs the round-trip check before writing anything.** Parse the source, write chunks to
  memory, re-read them, compare the scene list against the intended one. Any divergence aborts the
  whole import with a diagnostic and touches no file. This is exactly the safety net
  `branchpatch.ts` already uses for a far smaller edit, and the reasoning is identical — the user
  cannot review a conversion they have not seen, so the tool proves it rather than asking.

**Shots survive, and that is the point of doing it this way.** `work/shots/<sceneId>.json` binds to
line ids and scene ids, both of which the import preserves. If a scene id changes during import,
its decomposition and its generated art detach — so scene ids are carried through unchanged,
including the `[[scene:]]` overrides, and an import that would rename any scene stops instead. A
`vngen status` before and after must report the same task counts.

## Export

**`vngen screenplay [dir]` writes one Fountain file from the chunks, and never round-trips back.**
It is a projection, in the same sense `@vn/export` is: read-only over the model, no claim that
re-importing its output reproduces the project.

- **Order comes from the graph, not the directory.** A breadth-first walk from `config.start`
  following `next` then `choices`, unreachable scenes appended afterwards under a
  `# Unreachable` section marker. Alphabetical order would produce a screenplay nobody can read;
  the graph order is at least the order a playthrough tends to encounter.
- **Machine markers are kept by default.** `[[scene:]]`, `[[choice:]]`, `[[next:]]` and
  `[[line:]]` are Fountain notes — every renderer ignores them — so keeping them costs the
  human reader nothing and makes the output a valid input to `vngen import`. `--clean` drops them
  for the case where the destination is a human or Final Draft, and that output is explicitly
  one-way.
- **It writes where it is told.** Default `<dir>/screenplay.fountain` at the project root, `-o` to
  override, `-` for stdout. Not into `screenplay/`, which would recreate the both-present error the
  chunk plan defines.
- **`nextLineId` has nowhere to go.** It is the one front-matter field with no Fountain
  representation — a note carrying it would be re-parsed as junk. Round-tripping through
  `--clean` and back therefore restarts the allocator, which re-points nothing (ids in the file are
  what shots bind to, and a re-import preserves them) but can eventually reuse a retired id. Emit
  it as `[[nextline: N]]` in the default form, accept the loss under `--clean`, and say so in the
  command's help rather than in a comment nobody reads.

## Steps

1. ✔ **`sceneChunksFromScript` in `@vn/model`.** Pure: a `FountainScript` plus config in, a list of
   `{ id, doc }` out, with the id-allocation and the round-trip comparison. No I/O, so it is
   testable against every fixture in `@vn/testkit`'s `SCRIPTS`. Shipped in
   `packages/model/src/screenplay.ts`; it also reports the `entry` the chunk form needs for
   `start:`, and the comparison projection `branchpatch.ts` and `lineids.ts` each kept privately
   is now the shared `canonicalScenes`.
2. ✔ **`scriptFromScenes` in `@vn/model`.** The inverse projection: graph-ordered scenes in, one
   Fountain string out, `{ clean }` option. Built on `sceneToFountain`, not beside it. Shipped
   taking the graph rather than a pre-ordered list — the reading order is part of the contract, so
   it belongs where it can be tested — over a `SceneGraph` (`scenes` + `entry`) that a
   `ProjectModel` satisfies without the projection asking for fields it will not write.
3. ✔ **`vngen import`.** The CLI command, the `.imported` rename, refusal on an existing `scenes/`,
   and the abort-on-divergence path. Usage text updated for both exports. Shipped as `cmdImport`
   in `apps/cli/src/commands.ts`; it deliberately does not go through `loadProject`, which would
   build a model and report the leftover screenplay instead of fixing it. The screenplay file is
   found by the same finder the loader uses rather than a second glob (`loadInputs` at first, then
   step 6's exported `findScreenplay`), so the importer cannot disagree with the loader about which
   file it is. Writing `start:` needed a writer for `project.yaml`:
   `@vn/config`'s `setStartScene` splices the one line and leaves every other byte — including
   hand-written comments — alone, the same way the prose writers splice front-matter. The rename is
   **last**, because until it happens the project holds both formats and does not load.
4. ✔ **`vngen screenplay`.** The CLI command, `-o` / `-` / `--clean`. Shipped as `cmdScreenplay`;
   `parseArgs` grew a short-flag rule for `-o` (a listed short flag takes the next argument, an
   unlisted one is a boolean — one rule rather than a parser that guesses from what follows). It
   also **refuses an `-o` inside `screenplay/`**, not just defaulting away from it: a `.fountain`
   there is a second source of truth for every scene. (Step 6 kept the refusal — see its note.)
5. ✔ **Desktop `workspace.import` and `story.screenplay`.** Both `mutating`, both with a `check`
   (`workspace.import` refuses when `scenes/` exists or no screenplay is present;
   `story.screenplay` refuses on an empty model, like `story.export`). Neither is `undoable`:
   `workspace.import` restructures the whole worktree, which is what a shadow snapshot is worst at,
   and the `.imported` rename is the reversal a user can actually perform. Shipped as thin wrappers
   over three new `WorkspaceSession` methods, following the `planLineIds` shape: a private
   `planImport` decides the whole conversion and both `previewImport` (the check) and
   `importScreenplay` (the run) read it, so a refused check reports the sentence the run would
   have given. `writeScreenplay(clean)` mirrors `exportPlayable` and always writes
   `<dir>/screenplay.fountain` — the app offers no `-o`, so the CLI's "not inside `screenplay/`"
   refusal has nothing to guard here. The registry test's `mutating` and `check` lists grew by
   two; `undoable` did not. `docs/command-system.md`'s table and counts (28/12/11) and
   `CLAUDE.md`'s definition count were updated with the code rather than deferred to step 8.
6. ✔ **Retire the fallback.** `loadInputs` stops reading `screenplay/`, and a project with one and no
   `scenes/` gets an error diagnostic naming `vngen import`. The `screenplay` fixture kept by
   `scene-chunk-files.md` step 8 converts to chunks, and its test becomes an import test. Shipped
   with four decisions worth naming:
   - **One decider.** `findScreenplay` is exported from `@vn/store` and is the only thing that
     answers "which file is the screenplay" — the reader that reports it, `Workspace.index`, and the
     importer that converts it all call it, replacing three separate globs. `LoadedInputs` carries
     the answer as `legacyScreenplay` (an absolute path), so nothing downstream takes a second look
     at the directory.
   - **A leftover beside chunks is a *warning*, not the old hard error.** `two_input_formats` is
     gone. A `screenplay/` that builds nothing cannot contend with `scenes/`, so the both-present
     case is a `stray_screenplay` warning telling the author to delete it or rename it
     `.fountain.imported`; screenplay-and-no-chunks is the `legacy_screenplay` **error** naming
     `vngen import`. This is a deliberate departure from `scene-chunk-files.md` step 5, and it is
     also what lets `vngen import` finish: the rename is no longer racing a project that fails to
     load in between.
   - **`cmdScreenplay` keeps its `screenplay/` refusal**, against step 4's prediction. The reason
     changed rather than expired: a `.fountain` there is no longer a second source of truth, but it
     is a permanent diagnostic on every load, which is not a state a command should write a project
     into.
   - **`SceneSource` in the desktop session collapsed** to `{ id, file, prefix, script }` and
     `patchOptions` is gone — every scene now comes from a one-scene chunk, so the branch patcher
     and the line-id allocator no longer need to be told which scene inside a file they are aimed
     at. `BuildInputs.script` stayed (optional): no reader produces one, but Fountain is still a
     form scenes can be *given* in, which is what the model's own tests use.

   Fixtures converted with it: `@vn/authoring`'s `tools`/`loop` suites (both hand-built
   `screenplay/script.fountain` projects), the desktop `session` suite's branch-editing and line-id
   describes, and `@vn/store`'s worktree tests, which now pin the two diagnostics. `@vn/testkit`'s
   `format: 'screenplay'` survives as "an **unimported** project" — the fixture for testing the
   diagnostic and the importer, not an alternative input form. Its 60-second "plans byte-identical
   work either way" test moved to the CLI suite as an imported-vs-hand-authored task-hash
   comparison, which is where `cmdImport` is actually reachable — and is the property step 7 needs.
7. ✔ **Convert `templates/basic` by running the importer on it.** The conversion in
   `scene-chunk-files.md` step 9 was by hand or by the writer; redoing it through `vngen import`
   is the real end-to-end proof, and the diff against the hand conversion is the test. Task hashes
   must not move — same stop condition, same reason. Done by rebuilding the pre-conversion project
   out of git (`c1e0cdb^`), running the real `vngen import` on it, and diffing the result against
   the committed chunks. Three differences, all of them the writer's canonical form: the branch
   markers move to the top of the body, choice labels are quoted, and every line gets a `[[line:]]`
   mark under a `[[nextline:]]` allocator. **The stop condition held** — a throwaway test ran both
   forms through the real scheduler twice (gate, approve, gate cleared) and compared sorted
   `kind hash`: 21 tasks each, identical sets. So the importer's output is what ships.
   - That reverses step 9's deliberate choice to leave the template unmarked ("the minimum a chunk
     may be"). The reason it reverses: the marked form makes the template a **fixed point** of the
     two projections — `scriptFromScenes` then `sceneChunksFromScript` reproduces the committed
     files byte for byte, which the unmarked form cannot claim, because an import always stamps
     ids. That round trip is now a test in `screenplay.test.ts`, so the shipped template fails the
     build if either projection drifts.
   - `lineids.test.ts`'s sample sweep keeps the sample as its corpus by stripping the marks first,
     which is the input the writer exists for either way.
   - `vngen graph` was re-run: the committed `story.graph.mmd` had been stale since chunk loading
     made scene order alphabetical. Same nodes, same edges, one line moved.
   - The sample's `AICONTEXT.md` gained the rule the marks imply — art binds to line ids, so take
     the next one the allocator names and never renumber.
8. ✔ **Docs.** This file's As-shipped section; `CLAUDE.md`'s CLI table and project-layout section;
   `docs/vn-generator-report.md` §9.1; `docs/fountain.md` gains "what an exported screenplay looks
   like"; `docs/command-system.md`'s command table and counts. Landed as written, plus four pages
   that named the fallback in passing and would otherwise have been the only remaining claim that
   it loads: `pipeline-contracts.md`'s scene contract, `desktopAppState.md`'s worktree tree,
   `desktop-app.md`'s seeded-workspace note, and `authoring-agent-report.md`'s as-shipped aside.
   `docs/command-system.md` was already done in step 5.

## As shipped

Everything above is built. What a reader should take from it that the steps do not say on their own:

- **The two names stuck, and they had to.** `export`/`story.export` mean the playable;
  `screenplay`/`story.screenplay` mean Fountain. Both surfaces say which artifact they write in
  their own help text, because "export" alone is now ambiguous in a way no amount of docs fixes.
- **Import is one direction, once, and it proves itself before it writes.** The whole conversion
  runs in memory and is compared back through `canonicalScenes` — the same safety net
  `branchpatch.ts` uses for a one-line edit — so a divergence aborts having touched nothing. Scene
  ids are carried through unchanged, which is why generated art survives the migration, and the
  `.fountain` is moved aside rather than deleted, **last**, because that rename is what stops the
  project reporting it.
- **Retirement was subtraction, not a flag.** Nothing reads `screenplay/`; `findScreenplay` only
  *reports* it. The old both-present hard error became a warning in the process, because a file that
  builds no scenes cannot contend with the ones that do — and that softening is what let the
  importer finish without a window where the project fails to load.
- **The escape hatch is tested by the template.** `templates/basic` was converted by running the
  importer, and it is a fixed point of the pair: export it, import that, and the committed bytes
  come back. That is the claim that makes the chunk format a working format rather than lock-in, and
  it now fails the build if either projection drifts.
- **What the export cannot say, it says out loud.** `--clean` output is one-way and the help says
  so; sections, page breaks, dual dialogue and the title page are warnings naming what will be
  absent, not silent drops.

## Not in this plan

- **Importing anything but Fountain.** No Final Draft, no PDF, no Markdown-with-headings. One
  format in, and it is the one the repo already parses.
- **Continuous two-way sync.** The `.fountain` is not a mirror kept up to date. It is produced on
  request and goes stale immediately, which is the honest arrangement — the alternative is a second
  writer for every scene and a merge policy for when they disagree.
- **Re-import as an edit path.** Importing over an existing project is refused, not merged. "Edit
  the screenplay in another tool and re-import" is a feature that sounds cheap and requires
  scene-level diffing, id reconciliation, and a shots-detachment story.
- **Fidelity beyond what `lines` retains.** Sections, page breaks and dual dialogue are dropped by
  the model, so they are absent from the export. The importer should warn when the source contains
  them rather than dropping them silently.

## Alternatives considered

- **Import as a one-off script under `scripts/`.** It is a user-facing migration on a user's own
  project, not a maintainer chore — it belongs in the CLI, with usage text and a refusal path.
- **Auto-import on first load.** Rewriting an author's project layout because they opened it is the
  kind of helpfulness that is indistinguishable from data loss. The error diagnostic in step 6
  names the command; the author runs it.
- **Keep `screenplay/` as the source of truth and generate chunks from it.** That is the current
  arrangement with more steps: the contended file remains, and every edit needs a patcher.
- **Export to `story.play.json` only and call that the escape hatch.** The playable is a runner
  format — flattened, asset-keyed, choice-resolved. It is not something an author can open in a
  screenwriting tool, which is what the request actually is.
