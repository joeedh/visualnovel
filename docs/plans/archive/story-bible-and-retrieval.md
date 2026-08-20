# The story bible (`wiki/`) and retrieval

Status: **shipped** — see [As shipped](#as-shipped). Item 3 of
[`refactorTaskList.md`](../refactorTaskList.md); §2 of the
[migration report](../../research/codebase-migration-for-new-requirements.md#2-the-story-bible-wiki).
Sits directly on [`entity-discovery-by-meta-tag.md`](entity-discovery-by-meta-tag.md), which
already made `wiki/**` a place the loader looks.

<!-- toc -->

<!-- tocstop -->

## Why

[`../designRequirementsEtc.md`](../../designRequirementsEtc.md) gives the bible one sentence of
requirement and one sentence of prohibition:

> The story bible is an arbitrary collection of markdown files that is provided to the AI
> agent as context (this can be done through vector embedding databases or grepping or
> whatever, **the bible is _not_ directly pasted into the context window**).

Both halves matter. The bible is the author's world — notes, timelines, factions, history —
and it is unbounded by design, so the agent must be able to _reach_ it without the loader ever
being tempted to _carry_ it. `AICONTEXT.md` is the shape that would be tempting: today
`loadContext` reads it whole, inlines its `@import`s, and concatenates the result into the
system message (`packages/authoring/src/context.ts:116-133`). That is right for a page of
durable project guidance and wrong for a hundred files of world-building; the difference must
be a structural one, not a convention someone remembers.

Item 2 already taught the loader that `wiki/**` exists — a file tagged `type: character` there
is a character. Everything else in the tree is currently walked, checked for a tag, and passed
over in silence. This plan gives that "everything else" a reader, an index, and a way in.

## What is missing today

- **No package reads the wiki as prose.** `discoverEntities` walks it (`packages/store/src/entities.ts`)
  but only to answer "is this an entity". A file with no entity tag reaches nothing.
- **The agent cannot search it.** `search` collects `characters`, `locations`, `scenes`,
  `screenplay`, plus `AICONTEXT.md` and `project.yaml` (`INPUT_GLOBS`,
  `packages/authoring/src/tools.ts:164`). `wiki/` is not in the list, so even grep does not
  reach the bible.
- **The system prompt does not mention it.** `SYSTEM_PROMPT` states the input contract as
  four paths (`context.ts:20-31`); an agent told those four paths has no reason to believe a
  bible exists, let alone that it should look things up in one.
- **Nothing owns the "never paste it whole" rule.** There is no seam that could enforce it,
  because there is no bible reader at all.

## The design

### A new package, `@vn/bible`

Reading the tree is file reading and belongs to `@vn/store` ("the only reader of a project's
files"). _Retrieval_ — ranking, excerpting, budgeting — is policy, and policy in `store` is
what the layering exists to prevent. It does not belong in `@vn/authoring` either: the desktop
main process must be able to serve bible search to the UX without importing the agent.

So: the walk goes in `@vn/store`; a new **`@vn/bible`** sits between `store` and `authoring`,
input-side, with the same allow-list as `@vn/export`/`@vn/scriptedit` and the same prohibition
— never `pipeline`, never `scheduler`.

```
  model store ──── export  scriptedit  bible    git ──── commands
                                          │
                                     authoring
```

### The seam is `query(text) → ranked excerpts`

The requirement names embeddings and grep in the same breath, which is the report's cue: build
grep, and make the interface one an embedding store could satisfy without touching a caller.

```ts
export interface Excerpt {
  file: string; // relative to the bible root
  line: number; // 1-based, the first line of the excerpt
  heading?: string; // nearest enclosing markdown heading
  text: string; // the excerpt itself, already trimmed to the budget
  score: number;
}

export interface BibleFile {
  file: string;
  title: string; // front-matter `title:`, else the first H1, else the filename stem
  tags: string[]; // front-matter `tags:`, plus `type:` when present
  headings: string[];
  bytes: number;
}

export interface Bible {
  files(): BibleFile[];
  query(text: string, opts?: { limit?: number; budget?: number }): Promise<Excerpt[]>;
}

export function openBible(root: string): Promise<Bible>;
```

`openBible` takes a **directory, not a `ProjectPaths`** — the bible may be its own git repo
(§4's problem), and a package that can only be pointed at `<project>/wiki` would have to be
rewritten to allow that. Nothing in `@vn/bible` may assume the root shares a `.git` with the
project, or that it is inside the project at all.

### The budget is the guarantee

`query` returns at most `limit` excerpts (default 8) totalling at most `budget` characters
(default 4000), truncating the last one rather than exceeding it. **There is no API that
returns a whole file** — a caller that wants a whole bible file reads it with `read_file` and
takes responsibility, exactly as it does for any other file. That absence is what makes "not
pasted into the context window" a property of the code rather than a habit.

### Ranking, grep-first

Tokenize the query (lowercase, split on non-word, drop stopwords). Score each file by matches
in `title`/`headings`/`tags` (weighted high — they are what a human would have skimmed) plus
body-line matches; take the best lines per file with ±2 lines of context, merging overlapping
windows. Deterministic tie-break on `(score, file, line)`, because a test that cannot pin the
order is a test of nothing.

An index is built on `openBible` and reused; a rebuild is triggered by any file's `mtime`
changing. No vector-DB dependency in this plan — the upgrade is a second `Bible`
implementation behind the same function, and the day it lands, no caller changes.

## Steps

### 1. `@vn/store`: the tree walk becomes public

`listMarkdownTree` is already written and already deterministic — it is private to
`entities.ts`. Move it to `packages/store/src/tree.ts`, export `listWikiFiles(paths)` beside
it, and have `discoverEntities` call the moved function. No behavior change; the entity tests
pin that.

### 2. `@vn/bible`: the package

`package.json` (deps: `types`, `util`, `parse`, `store`), the `ALLOWED` entry in
`eslint.config.mjs`, the name in `jest.config.cjs`'s `PACKAGES`. Then `index.ts` /
`indexer.ts` (walk → `BibleFile[]`, front-matter via `@vn/parse`, headings by regex) and
`query.ts` (tokenize, score, excerpt, budget). Unit tests in `src/tests/`: ranking order,
the budget cap, the heading attribution, a query matching nothing, a tree with no `wiki/` at
all.

### 3. `@vn/authoring`: the agent gets a way in

- **`search_bible(query, limit?)`** — read-only tool over `Bible.query`, output as
  `file:line` blocks the way `search` already formats matches.
- **`SYSTEM_PROMPT` gains a paragraph**: `wiki/` is the story bible, it is arbitrary markdown,
  character and location sheets may live in it (tagged `type:`), and it is reached with
  `search_bible` — *never* read whole. Precedence is unchanged: input contract >
  `AICONTEXT.md` > inferred. The bible is **not** context; it is a place to look.
- **`list_workspace`** reports the bible's file count, so the agent knows one exists before
  it has a reason to search.
- `search`'s `INPUT_GLOBS` stays as it is: `search` is for input files, `search_bible` is for
  the bible, and merging them would put an unbounded tree behind a tool with no budget.

### 4. The desktop app: one command

`bible.search(query='…' limit=8)` in a new `apps/desktop/src/main/commands/bible.ts`, over the
same `Bible`, non-mutating, no `check`. The UX that consumes it (sidebar tree, the bible
editor) is items 1 and 9; this plan ships the command and its catalog entry so those have
something to call.

### 5. Tests

`makeProject({ files: { 'wiki/…': … } })` already writes arbitrary files, so the fixtures need
nothing new. Assert: a query finds a file by heading and by body, the budget truncates rather
than overflows, `search_bible` reaches a file `search` does not, and an entity sheet in the
wiki is visible to *both* discovery and retrieval without either one changing the other's
answer.

### 6. Docs

`CLAUDE.md`'s package table and layering diagram, the tool row in `docs/vnauthor.md`, the
command in `docs/command-system.md`, a new `docs/story-bible.md` listed in `docs/index.md`,
this plan's As-shipped section, and the rows in [`index.md`](../index.md) and
[`refactorTaskList.md`](../refactorTaskList.md).

## Decisions settled here

- **Retrieval is a package, not a helper.** The desktop main process needs bible search
  without the agent; that alone rules out putting it in `@vn/authoring`, and keeping `store`
  policy-free rules out putting it there.
- **`openBible(dir)`, not `openBible(paths)`** — the own-repo option must not require a
  rewrite when §4 lands.
- **No whole-file API.** The budget is enforced at the only door.
- **Grep now, embeddings behind the same function.** No vector dependency in this plan.
- **The bible is not context.** `loadContext` is untouched: `AICONTEXT.md` stays the author's
  durable guidance, the bible stays a thing the agent goes and looks in.

## Not in scope — and who should own it

- **Own-repo wiki** (a separate `.git` under `wiki/`): [`refactorTaskList.md`](../refactorTaskList.md)
  item 4, the repo map. This plan only refrains from making it harder.
- **Entity templates** ("the user creates a new character, the app initializes it with a
  template") and **creating entities into `wiki/`**: neither item 2 nor this plan owns them.
  Recommendation: they land with item 10 (project bootstrap), which is already the plan about
  scaffolding a project's files.
- **The sidebar document tree** that displays the bible: items 1 and 9.
- **`nestedContextDirs`** (`packages/authoring/src/context.ts:167`) still derives
  `characters/<id>` to find a nested `AICONTEXT.md`. It is a context lookup, not a writer, and
  it degrades silently when the directory is absent — but a wiki-filed character has no such
  directory, so nested guidance is unreachable for one. Small, and it belongs with whichever
  plan next touches context assembly (item 8, agent context regeneration).

## Acceptance

`pnpm check`, `pnpm test`, `pnpm lint` green. A project with no `wiki/` behaves exactly as it
does today. A query never returns more than its budget, and no API in `@vn/bible` returns a
whole file.

## As shipped

All six steps landed as designed. The as-shipped guide is [`../story-bible.md`](../../story-bible.md);
what follows is only what the plan above left open or decided differently.

**The walk moved, it did not fork.** `listMarkdownTree(dir)` + `listWikiFiles(paths)` now live in
`packages/store/src/tree.ts`; `entities.ts` imports the first rather than keeping its own private
copy. `@vn/bible` walks with the same function `loadInputs` does, so discovery and retrieval can
never disagree about which files are in the bible.

**`Bible` gained `refresh()`.** `query` re-walks for itself, but `files()` reports the last walk,
and the workspace index needs a current count — a `Bible` handle held across edits would otherwise
report a stale one. `refresh()` is the only addition to the seam the plan sketched; there is still
no API that returns a file.

**The index holds the whole file's lines, front matter included**, so a reported `file:line` is
the line an editor shows rather than an offset into a body. Unparseable front matter is swallowed
deliberately: a bible file is arbitrary prose, and a note with a broken YAML fence is still a note.

**Title precedence is `title:` → `name:` → first heading → filename stem**, and tags are `tags:`
plus `type:` — so a `type: character` sheet under `wiki/` is findable by its kind as well as by
its prose, which is what makes an entity sheet in the bible one thing to both surfaces.

**Ranking constants**, all in `query.ts`: title ×3, tags ×2, headings ×1 for the file; a heading
line scores double; two lines of context either side; at most three windows per file; defaults
`limit: 8`, `budget: 4000`. Below 120 characters of remaining budget the loop stops rather than
emitting a stub. Sort is `score desc, file asc, line asc` — pinnable, which is the point.

**Where the handle lives.** `Workspace.bible()` opens once and reuses (`packages/authoring`), and
`WorkspaceSession.searchBible` holds one `Workspace` purely for the bible — every other session
method rebuilds, because every other method reads authored input a command may just have written.
The bible is the one thing no command writes.

**Types cross to the renderer, the package does not.** `apps/desktop/src/shared/ipc.ts` re-exports
`BibleFile`/`Excerpt` as `export type`, so `bible.search` results have a name in the browser
bundle without `@vn/bible` (which reads the filesystem) entering it.

**Not done, as scoped:** the sidebar tree, the own-repo wiki, entity templates, and
`nestedContextDirs` all remain with the items named under
[Not in scope](#not-in-scope--and-who-should-own-it).

Green at 80 suites / 1036 tests, with `pnpm check` (both passes) and `pnpm lint` clean.
