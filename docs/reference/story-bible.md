# The story bible (`wiki/`)

<!-- toc -->

- [What it is](#what-it-is)
- [The retrieval seam](#the-retrieval-seam)
  * [Why there is no `read()`](#why-there-is-no-read)
  * [The budget](#the-budget)
- [How a file is indexed](#how-a-file-is-indexed)
- [Ranking](#ranking)
- [Who reaches it](#who-reaches-it)
- [Entity sheets in the bible](#entity-sheets-in-the-bible)
- [What it is not](#what-it-is-not)

<!-- tocstop -->

## What it is

`wiki/` is the author's story bible. It is an arbitrary markdown tree that the author may shape
however they like, holding lore, history, timelines, half-finished drafts and character notes.
Nothing in it is an input to the generative pipeline. `loadInputs` walks it for `type:`-tagged
entity sheets (see [Entity sheets](#entity-sheets-in-the-bible)) and otherwise ignores it entirely.

It exists because the pipeline's inputs follow a contract (a character sheet has a schema, a scene
is a Fountain body) and an author's thinking does not. The bible holds the un-schematized part, and
the agent consults it rather than holding it.

## The retrieval seam

`@vn/bible` is a leaf package between `@vn/store` and its consumers, and it sits on the same
allow-list as `@vn/export` and `@vn/scriptedit`. The package is input-side and is forbidden from
`@vn/pipeline`/`@vn/scheduler`.

```ts
import { openBible } from '@vn/bible';

const bible = await openBible('/path/to/project/wiki');
const excerpts = await bible.query('who keeps the roof key?', { limit: 5, budget: 2000 });
```

`openBible` takes a directory rather than a `ProjectPaths`. The bible may one day live in its own
git repo (refactorTaskList.md item 4), so no code here assumes it shares a repo with the project.

A missing root is accepted rather than reported as an error. A project with no `wiki/` has an empty
bible, and every caller behaves exactly as it did before the bible existed.

### Why there is no `read()`

`Bible` has `files()` (metadata only: path, title, tags, headings, byte count) and `query()`. No
API returns a whole file. That absence guarantees that the bible is never pasted into a model's
context, because no call can return the whole tree. A surface that needs a file open, such as an
editor, reads it from disk itself. At that point a human is looking at it and it does not consume a
context window.

The desktop app's `doc.read` works exactly this way, and that is why there is no `bible.read`. The
wiki editor takes a path and answers with the whole document, because a person about to edit a note
needs all of it and needs the hash their save will present back. Routing that through `@vn/bible`
would have restored whole-file access in the one place the design forbids it. An agent holding the
same registry could then call `bible.read` and paste the tree. The two acts differ, so they are two
functions. `query` serves the machine and `doc.read` serves the human.

`files()` has three readers, and all of them read only metadata. The workspace index reports its
length, a count, so the agent knows a bible exists before it searches. The generated project map
(`AICONTEXT.generated.md`) renders it as a table of contents: path, title, tags, headings, one line
per note. The [document tree](document-tree.md) nests the same paths and titles back into the
sidebar's Wiki branch. A table of contents lists structure only: it says a note about the war has a
`Casualties` heading and says nothing about what is under it, which lets the agent aim
`search_bible` at a specific note without copying any note text. See
[`../plans/archive/INDEX.md#agent-context-regeneration`](../plans/archive/INDEX.md#agent-context-regeneration).

The tree stops there for the same reason. A character's own sheet is linked, because the tag index
already knows where that sheet was found. The question of which other notes mention Aiko stays a
`query`, ranked and budgeted, rather than becoming a precomputed backlink index over the one tree
that was deliberately given a budget.

### The budget

`query` returns excerpts totalling no more than `budget` characters (default 4000). If the total
would exceed that cap, `query` truncates the last excerpt with `…`. `limit` (default 8) caps the
number of excerpts. `query` applies both limits in one place, so a caller cannot skip them.

## How a file is indexed

- Line numbers count from the start of the file and include the front matter, so a reported
  `file:line` is the line an editor shows.
- **Title** is taken from front-matter `title:` when that key is present. Otherwise it is taken
  from `name:`, then the first heading, then the filename stem.
- **Tags** are front-matter `tags:` plus `type:`, so a tagged entity sheet is findable by its
  kind.
- **Headings** are collected, and each line is mapped to its nearest enclosing heading. An
  excerpt is attributed to that heading.
- **Broken front matter is not an error.** A bible file is arbitrary prose. A note with an
  unclosed YAML fence is still a note, and it is indexed as the text it contains.

The index is rebuilt per file by mtime, so editing one note re-reads only that note. `query`
re-walks first. `files()` reports the last walk, and `refresh()` forces a new walk.

## Ranking

Search is grep-shaped and deliberately deterministic, so a test can pin the result order. A file
scores on its title (×3), tags (×2), and headings (×1); a line scores on how many query terms it
contains, doubled if the line is a heading. The best non-overlapping windows are taken, with two
lines of context either side and at most three per file (which keeps one long note from filling the
results), sorted by score, then path, then line.

An embedding store replaces this layer entirely behind the same `query` function, and no caller
changes.

## Who reaches it

| Surface        | How                                                            |
| -------------- | -------------------------------------------------------------- |
| `vnauthor`     | the `search_bible(query, limit?)` tool                          |
| desktop app    | the `bible.search(query='…' limit=8)` command                   |
| `list_workspace` / `WorkspaceIndex` | `bibleFiles`, a **count** — so the agent knows a bible exists before it has a reason to search |

`search`'s `INPUT_GLOBS` deliberately excludes `wiki/`. `search` covers input files and has no
budget, while `search_bible` covers the bible and has one. Merging them would put an unbounded tree
behind a tool that cannot bound it.

## Entity sheets in the bible

Any file under `wiki/` with `type: character` or `type: location` in its front matter is a real
entity sheet, discovered exactly as one under `characters/` or `locations/` would be. The
entity-discovery contract is in
[`pipeline-contracts.md`](pipeline-contracts.md#scenes-shots-and-lines). Discovery and retrieval
read the same file, and neither changes the other's result: a wiki-filed character appears in the
workspace index at the path it actually lives at, is patched in place by `edit_character`, and is
also reachable by `search_bible` like any other note.

Creating a new entity still writes to the conventional directory. Filing one under `wiki/` is a
choice the author makes; the tools follow that choice rather than making it.

## What it is not

- **Not context.** `AICONTEXT.md` is the author's durable guidance and is loaded every turn. The
  agent reads the bible only when it goes to look at it. `loadContext` does not load the bible.
- **Not an input.** Bible content reaches the task graph only through a `type:`-tagged sheet,
  which is an entity rather than bible content.
- **The archive is separate.** `archive/` holds the author's own uploaded documents verbatim,
  outside the directories that `query` and `search` cover: neither command reaches it, and it is
  read only when someone names a path in it. The bible is retrievable; the archive is preserved
  unchanged. See [`vnauthor.md`](vnauthor.md#the-archive).
- **Not yet versioned separately.** A `wiki/` with its own `.git` is
  [`../plans/refactorTaskList.md`](../plans/refactorTaskList.md) item 4. This design does not make
  that change harder.
