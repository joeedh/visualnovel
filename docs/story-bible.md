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

`wiki/` is the author's story bible: an arbitrary markdown tree, in whatever shape they like —
lore, history, timelines, half-finished drafts, character notes. Nothing in it is an input to
the generative pipeline. `loadInputs` walks it for `type:`-tagged entity sheets (see
[Entity sheets](#entity-sheets-in-the-bible)) and otherwise ignores it entirely.

It exists because the pipeline's inputs are a **contract** — a character sheet has a schema, a
scene is a Fountain body — and an author's actual thinking is not. The bible is where the
un-schematized part lives, and the agent's job is to consult it, not to hold it.

## The retrieval seam

`@vn/bible` is a leaf package between `@vn/store` and its consumers, on the same allow-list as
`@vn/export` and `@vn/scriptedit`: input-side, and forbidden from `@vn/pipeline`/`@vn/scheduler`.

```ts
import { openBible } from '@vn/bible';

const bible = await openBible('/path/to/project/wiki');
const excerpts = await bible.query('who keeps the roof key?', { limit: 5, budget: 2000 });
```

`openBible` takes a **directory, not a `ProjectPaths`**. The bible may one day live in its own
git repo (`refactorTaskList.md` item 4), and nothing here may assume it shares one with the
project.

A root that does not exist is not an error: a project with no `wiki/` has an empty bible, and
every caller behaves exactly as it did before the bible existed.

### Why there is no `read()`

`Bible` has `files()` (metadata only — path, title, tags, headings, byte count) and `query()`.
It has **no API that returns a whole file**. That absence is the guarantee that the bible is
never pasted into a model's context: there is no door through which the whole tree can leave.
A surface that genuinely wants a file open — an editor — reads it from disk itself, at which
point a human is looking at it and no context window is paying for it.

That is exactly what the desktop app's `doc.read` is, and why it is not a `bible.read`: the wiki
editor takes a path and answers the whole document, because a person about to _edit_ a note needs
all of it and needs the hash their save will present back. Routing that through `@vn/bible` would
have put the whole-file door back in the one place the design says it must not be — an agent
holding the same registry would then be one `bible.read` away from pasting the tree. The two acts
are different, so they are two functions: `query` for the machine, `doc.read` for the human.

`files()` has three readers, and all of them stay on the metadata side of that line. The workspace
index reports its **length** — a count, so the agent knows a bible exists before it searches; the
generated project map (`AICONTEXT.generated.md`) renders it as a **table of contents**: path,
title, tags, headings, one line per note; and the [document tree](document-tree.md) nests the same
paths and titles back into the sidebar's Wiki branch. A table of contents is not an excerpt; it
says a note about the war has a `Casualties` heading and nothing about what is under it, which is
what turns a blind `search_bible` into an aimed one without pasting a word. See
[`plans/agent-context-regeneration.md`](plans/agent-context-regeneration.md).

The tree stops there for the same reason. A character's *own* sheet is linked, because the tag
index already knows where it was found — but "which other notes mention Aiko" stays a `query`,
ranked and budgeted, rather than becoming a precomputed backlink index over the one tree that was
deliberately given a budget.

### The budget

`query` returns excerpts totalling no more than `budget` characters (default 4000), the last one
truncated with `…` rather than the cap exceeded. `limit` (default 8) caps the count. Both are
enforced at the one door, so a caller cannot forget them.

## How a file is indexed

- **Lines are the whole file's**, front matter included, so a reported `file:line` is the line
  an editor shows.
- **Title** is front-matter `title:`, else `name:`, else the first heading, else the filename
  stem.
- **Tags** are front-matter `tags:` plus `type:`, so a tagged entity sheet is findable by its
  kind.
- **Headings** are collected, and each line remembers its nearest enclosing one, which is what
  an excerpt is attributed to.
- **Broken front matter is not an error.** A bible file is arbitrary prose; a note with an
  unclosed YAML fence is still a note, and it is indexed as the text it is.

The index is rebuilt per file by mtime, so editing one note does not re-read a hundred. `query`
re-walks first; `files()` reports the last walk, and `refresh()` forces one.

## Ranking

Grep-shaped and deliberately deterministic — a result order a test cannot pin is a test of
nothing. A file scores on its title (×3), tags (×2), and headings (×1); a line scores on how
many query terms it contains, doubled if it is a heading. The best non-overlapping windows are
taken (two lines of context either side, at most three per file so one long note cannot crowd
out the rest), sorted by score then path then line.

This is the layer an embedding store replaces **wholesale**, behind the same `query` function
and without a caller changing.

## Who reaches it

| Surface        | How                                                            |
| -------------- | -------------------------------------------------------------- |
| `vnauthor`     | the `search_bible(query, limit?)` tool                          |
| desktop app    | the `bible.search(query='…' limit=8)` command                   |
| `list_workspace` / `WorkspaceIndex` | `bibleFiles`, a **count** — so the agent knows a bible exists before it has a reason to search |

`search`'s `INPUT_GLOBS` deliberately does **not** include `wiki/`: `search` is for input files
and has no budget, `search_bible` is for the bible and does. Merging them would put an unbounded
tree behind a tool that cannot bound it.

## Entity sheets in the bible

A file anywhere under `wiki/` with `type: character` or `type: location` in its front matter is
a real entity sheet, discovered exactly as one under `characters/` or `locations/` would be —
see the entity-discovery contract in
[`pipeline-contracts.md`](pipeline-contracts.md#scenes-shots-and-lines). Discovery and retrieval
see the same file and neither changes the other's answer: a wiki-filed character appears in the
workspace index at the path it actually lives at, is patched in place by `edit_character`, and
is also reachable by `search_bible` like any other note.

Creating a *new* entity still writes to the conventional directory. Filing one under `wiki/` is
an authorial act the author performs; the tools follow it, they do not initiate it.

## What it is not

- **Not context.** `AICONTEXT.md` is the author's durable guidance and is loaded every turn; the
  bible is a place the agent goes and looks. `loadContext` does not touch it.
- **Not an input.** Nothing in it reaches the task graph except through a `type:`-tagged sheet,
  which is an entity, not bible content.
- **Not the archive.** `archive/` holds the author's own uploaded documents verbatim, outside every
  directory anything sweeps: `query` does not reach it, `search` does not either, and it is read
  only when someone names a path in it. The bible is retrievable; the archive is kept. See
  [`vnauthor.md`](vnauthor.md#the-archive).
- **Not versioned separately — yet.** A `wiki/` with its own `.git` is
  [`plans/refactorTaskList.md`](plans/refactorTaskList.md) item 4. This design only refrains
  from making it harder.
