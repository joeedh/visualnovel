# Agent context regeneration

Status: **shipped** (deviations in [As shipped](#as-shipped)). Item 8 of [`refactorTaskList.md`](../refactorTaskList.md), from §7 of the
[migration report](../../research/codebase-migration-for-new-requirements.md). Sits on item 2 (tag
discovery) and item 3 ([`story-bible-and-retrieval.md`](story-bible-and-retrieval.md)) — it is
their walk, projected.

<!-- toc -->

<!-- tocstop -->

## What the requirement asks for

> The user can manually invoke a context update that regenerates whatever index files (or tree of
> index files) or `agents.md` or whatever the AI agent uses; eventually automatic.

## Where the code already is

Context today is **loaded, never generated**. `packages/authoring/src/context.ts` assembles
`SYSTEM_PROMPT` (the built-in input contract) + `AICONTEXT.md` (first of
`AICONTEXT.md`/`AGENTS.md`/`CLAUDE.md` that exists, with nested files and `@import`s resolved,
cycle-guarded to depth 8) and hands the pair to `composeSystem`. Nothing writes a word of it.

Both halves of the walk a generated summary needs already exist and are already paid for:

- `Workspace.index()` (`packages/authoring/src/workspace.ts`) → `WorkspaceIndex`: characters with
  status and **file**, locations with `mined`, scenes with location/cast/choices/reachability,
  `entry`, `bibleFiles`, `baseAssets`, `repos`, `diagnostics`. Every row already carries the path
  the entity was discovered in, which is item 2's doing.
- `Bible.files()` (`packages/bible/src/index.ts`) → `BibleFile[]`: `file`, `title`, `tags`,
  `headings`, `bytes` per note, off the mtime-cached index `query()` uses. **Metadata only** — the
  one API `@vn/bible` offers that is not an excerpt, and the reason it exists.

So there is no new walker to write. What is missing is a projection of those two into prose, a
file to put it in, and a rule that reads that file back without letting it outrank the author.

## The shape of the thing

**One generated file, not a tree.** The requirement says "index files (or tree of index files)",
and a tree is the wrong answer here for a concrete reason: the loader inlines what it finds, so a
tree would either be inlined whole — which is the pasting the bible was built to avoid — or
reached by a second retrieval mechanism nobody asked for. One bounded file, regenerated whole, is
what a context window can afford.

**It is a map, not content.** Nothing in the generated file is prose the author wrote. It is:

- the cast — id, name, status, file, default outfit and the rest of the wardrobe;
- the locations — id, name, variants, file, or `(mined)` for one with no sheet;
- the story graph — the entry scene, then each scene's location, cast, and where it goes, with
  unreachable ones marked;
- **the bible's table of contents** — one line per note: path, title, and its top-level headings.

The last is the point of the whole item. `search_bible` is a good tool aimed blindly: the agent
knows a bible exists (`bibleFiles` is a count) but not that `wiki/history/the-war.md` has a
`Casualties` heading in it, so it queries for words it hopes are there. A table of contents is the
smallest thing that turns a blind query into an aimed one, and it is *still* not the bible — no
line of a note's body appears in it.

**Diagnostics stay out.** They are per-load and already answered live by `list_workspace`; baking
a stale error into the system prompt would have the agent arguing with the file in front of it.

## Decisions

**1. It lives at `AICONTEXT.generated.md`, in the project root.** Not under `vngen/`: that tree is
the output of a *run*, and the agent branch is forbidden from the pipeline for reasons this file
should not quietly undo. The author is meant to read this file and to see it in a diff, so it
belongs where they already look — beside the hand-written one, loaded by the same loader.

**2. Generated, and it says so in a way a machine can check.** The file opens with a fixed banner
naming the command that writes it and stating that edits are lost. That banner is not decoration:

- `workspace.reindex` **refuses to overwrite** a file at that path that does not carry it, rather
  than assuming an author who wrote one there meant to donate it. Same "refuse rather than guess"
  the undo journal uses when the worktree has drifted.
- `loadContext` **ignores** a file at that path without the banner, so a half-migrated project
  cannot silently feed the agent something nobody generated.

**3. Precedence: below `AICONTEXT.md`, above nothing.** The loader gains one step — after the
hand-written root file and its imports, before the nested per-character files — and the composed
system message labels the section, as it already labels the `AICONTEXT.md` one. A hand-written
instruction always wins, because the generated file states facts and the author states policy, and
policy about a fact is the author's to set. `@import`s inside the generated file are not resolved:
it is generated, so it has nothing to import that the generator could not have inlined.

**4. It is budgeted, and says what it dropped.** A project with four hundred wiki notes must not
produce a four-hundred-line system prompt. One character budget over the whole file (default
`8000`, the same order as `query`'s `4000` and for the same reason), spent in section order —
cast, locations, scenes, then the bible TOC, which is the section that grows without bound. A
truncated section ends with a counted line (`… and 312 more notes; use search_bible`), which is
strictly better than silence: the agent learns the map is partial and reaches for the tool.

**5. The command is `workspace.reindex`, and it is `mutating` and not `undoable`.** It writes one
generated file; undoing it means running it again, and the shadow-snapshot machinery is for
documents the author authored. Commit-on-save picks it up like any other write, which is item 4's
job and needs nothing here.

**6. No automatic invalidation in this plan** — see [Out of scope](#out-of-scope). The generated
file carries the timestamp and the counts it was built from, so a surface that later wants to say
"the map is stale" has something to compare against without this plan guessing what that surface
is.

## Steps

### 1. The projection, in `@vn/authoring`

`packages/authoring/src/generated.ts`: `renderGeneratedContext(index, bibleFiles, opts) → string`,
pure, no I/O — the two walks are already done by the time it is called, and a pure function is what
lets the budget and the truncation lines be tested without a project on disk. Plus
`GENERATED_BANNER`, `isGenerated(text)`, and the file's name as a constant so the writer, the
loader and the refusal all name it once.

`Workspace.writeGeneratedContext()` is the impure half: `index()` and `bible().files()`, render,
refuse if a non-generated file is in the way, `writeFileAtomic`, return the path and the counts.

### 2. The loader reads it

`loadContext` gains the step from decision 3 — read `AICONTEXT.generated.md` after the root file,
skip it unless `isGenerated`, no `@import` resolution — and `LoadedContext` gains a
`generatedContext` field so `composeSystem` can label its own section rather than concatenating
two things the model cannot tell apart. `files` keeps reporting every file that contributed,
generated one included, because `/status` shows that list.

### 3. The two surfaces

- `vnauthor`: a `regenerate_context` tool (**M**), next to `update_context`. Mutating, so plan
  mode blocks it, which is right — regenerating is an act with a diff.
- Desktop: `workspace.reindex`, beside `workspace.index`, over `session.writeGeneratedContext()`.
  A `check` that reports whether the file exists and what it would replace, so the palette can say
  so before the write.

### 4. Tests

- `generated.ts` unit tests: the banner round-trips through `isGenerated`; a project with no wiki
  renders no TOC section rather than an empty heading; the budget truncates the TOC first and the
  counted line names the remainder; a mined location renders as such.
- `context.test.ts`: the generated file is loaded, is labelled separately, and **loses to**
  `AICONTEXT.md` on a contradicting line; a file at that path without the banner is ignored.
- A `makeProject` test for the writer: refuses over a hand-written file, writes over its own
  output, and the second write of an unchanged project is byte-identical (which is what makes it
  safe to run from a save hook later).

### 5. Docs

- [`../vnauthor.md`](../../vnauthor.md) — the precedence chain gains a rung; `regenerate_context` in
  the tool table.
- [`../command-system.md`](../archive/command-system.md) — `workspace.reindex` in the table, and the
  counts.
- [`../story-bible.md`](../../story-bible.md) — the TOC is the second thing that reads `files()`, and
  the note that a TOC is not an excerpt belongs beside the no-whole-file rule.
- `CLAUDE.md` — the context-precedence line under "Authoring agent" gains the generated rung.
- `refactorTaskList.md` / [`index.md`](../index.md) — status.

## As shipped

Five things differ from the plan above, all decided while writing the code.

**The projection takes a `ProjectMap`, not a `WorkspaceIndex`.** Step 1 said
`renderGeneratedContext(index, bibleFiles, opts)`. `WorkspaceIndex` is an IPC-shipped shape and it
does not carry wardrobes, location variants, or branch labels; widening it for one consumer would
have made every surface pay. Instead `generated.ts` owns two pure functions —
`projectMap(root, model, inputs, bibleFiles) → ProjectMap` and `renderGeneratedContext(map, opts)`
— and the renderer is testable from a plain object literal with no project on disk.

**Paths in the file are relative to the project root, `/`-separated.** `projectMap` takes `root` as
its first argument for exactly this: the index's `file` fields are absolute, and an absolute path in
a committed file is both unportable and fatal to the byte-identity test.

**No timestamp in the body.** Decision 6 said the file carries the timestamp it was built from.
Step 4 said the second write of an unchanged project is byte-identical, and the two cannot both be
true. Byte-identity won — it is what makes the command safe to run from a save hook — and the
file's mtime is the timestamp anyway. The counts stay, in the line under the heading.

**The refusal is a `VnError('GENERATED_CONTEXT')`, and there is a separate state query.**
`Workspace.generatedContext()` answers `{ file, exists, generated }` without writing, so the
desktop `check` can say what a run would replace before one happens;
`Workspace.writeGeneratedContext()` throws over a file that exists without the banner, naming the
file and stating that nothing was written.

**`isGenerated` matches the mark, not the banner.** It tests the stable
`<!-- vn:generated-context` prefix rather than the whole `GENERATED_BANNER` string, so bumping the
banner's version never turns "mine, replace it" into "someone else's, refuse".

## Out of scope

- **Automatic regeneration.** The report's own framing is that "automatic later" reduces to calling
  this command from the places that invalidate it — entity create/delete, wiki save — which
  commit-on-save makes observable. That is a second decision (what debounces it, what happens when
  a save races a turn), and it is cheap to add once the command exists and is idempotent.
- **Embedding the generated map in the bible index.** `@vn/bible` returns excerpts; a project map
  is not one, and putting the projection there would give the bible a whole-file-shaped API by the
  back door.
- **A per-directory generated tree.** Decision on the shape, above. The nested-context mechanism
  already exists for hand-written files and is not extended to generated ones.
- **Generating `AICONTEXT.md` itself.** The author's file stays the author's; the generator never
  writes to it. `update_context` remains the only thing that appends there, one line at a time.
