# Fountain import and export

Status: **planned**. Move three of
[`../research/scene-chunks-as-the-authored-unit.md`](../research/scene-chunks-as-the-authored-unit.md).
It depends on [`lossless-scene-serialization.md`](lossless-scene-serialization.md) for the writer
and [`scene-chunk-files.md`](scene-chunk-files.md) for the target, and it is what lets that plan's
`screenplay/` fallback finally be retired.

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

1. **`sceneChunksFromScript` in `@vn/model`.** Pure: a `FountainScript` plus config in, a list of
   `{ id, doc }` out, with the id-allocation and the round-trip comparison. No I/O, so it is
   testable against every fixture in `@vn/testkit`'s `SCRIPTS`.
2. **`scriptFromScenes` in `@vn/model`.** The inverse projection: graph-ordered scenes in, one
   Fountain string out, `{ clean }` option. Built on `sceneToFountain`, not beside it.
3. **`vngen import`.** The CLI command, the `.imported` rename, refusal on an existing `scenes/`,
   and the abort-on-divergence path. Usage text updated for both exports.
4. **`vngen screenplay`.** The CLI command, `-o` / `-` / `--clean`.
5. **Desktop `workspace.import` and `story.screenplay`.** Both `mutating`, both with a `check`
   (`workspace.import` refuses when `scenes/` exists or no screenplay is present;
   `story.screenplay` refuses on an empty model, like `story.export`). Neither is `undoable`:
   `workspace.import` restructures the whole worktree, which is what a shadow snapshot is worst at,
   and the `.imported` rename is the reversal a user can actually perform.
6. **Retire the fallback.** `loadInputs` stops reading `screenplay/`, and a project with one and no
   `scenes/` gets an error diagnostic naming `vngen import`. The `screenplay` fixture kept by
   `scene-chunk-files.md` step 8 converts to chunks, and its test becomes an import test.
7. **Convert `examples/sample` by running the importer on it.** The conversion in
   `scene-chunk-files.md` step 9 was by hand or by the writer; redoing it through `vngen import`
   is the real end-to-end proof, and the diff against the hand conversion is the test. Task hashes
   must not move — same stop condition, same reason.
8. **Docs.** This file's As-shipped section; `CLAUDE.md`'s CLI table and project-layout section;
   `docs/vn-generator-report.md` §9.1; `docs/fountain.md` gains "what an exported screenplay looks
   like"; `docs/command-system.md`'s command table and counts.

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
