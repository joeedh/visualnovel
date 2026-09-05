# Navigating the story bible

_This is an investigation rather than a plan, and it commits to no steps and no waves. It
asks what it would take for the agent to list and search the wiki's file tree. It finds
that the data already exists, that the surface which comes closest to exposing it is the
first surface deleted under budget pressure, and that adding the missing entry point is
worth its cost three times over in places that are not about listing at all._

_Status: nothing is built. `@vn/bible` ships `files()` (metadata) and `query()`
(passages); the agent can reach `query()` but not `files()`. Companion to
[`retrieval-beyond-grep.md`](retrieval-beyond-grep.md), which covers the ranking half of
the same package and which this document corrects on one point (§H)._

<!-- toc -->

- [The question](#the-question)
- [What the agent can see today](#what-the-agent-can-see-today)
- [The map is the listing, and the map is truncated first](#the-map-is-the-listing-and-the-map-is-truncated-first)
    - [A correction to `retrieval-beyond-grep.md` §H](#a-correction-to-retrieval-beyond-grepmd-%C2%A7h)
- [What a listing door is](#what-a-listing-door-is)
- [Three things it changes that are not about listing](#three-things-it-changes-that-are-not-about-listing)
- [The boundary this must not cross](#the-boundary-this-must-not-cross)
- [Cost](#cost)
- [Alternatives considered and rejected](#alternatives-considered-and-rejected)
- [Open questions](#open-questions)

<!-- tocstop -->

## The question

The agent can search the bible's prose but cannot see its structure. It cannot ask what
notes exist, what is filed under `wiki/history/`, or whether a note is titled something
about the war. A search returns only the passages that mention the word.

The gap is in navigation rather than retrieval, and the two have different fixes. This
document describes what the listing interface should be, what it must not become, and what
else in the context system changes once it exists.

## What the agent can see today

`Bible.files()` returns exactly the metadata a listing needs: path, title, tags, headings,
and byte count, but not the body (packages/bible/src/types.ts). Three readers call
`Bible.files()`, and none of them is a tool the agent can call.

- **The workspace index reports a count.** `bibleFiles: bible.files().length`
  (packages/authoring/src/workspace.ts:225) renders as "Story bible: 37 file(s) under
  wiki/ — search it with search_bible" (workspace.ts:423-426). The agent learns that a
  bible exists and learns nothing about its contents.
- **The generated map renders the table of contents** — one row per note, path, title,
  tags and up to six headings (`packages/authoring/src/generated.ts`, `bibleRow`). Aiming
  depends on this map, which is loaded into every turn as part of
  `AICONTEXT.generated.md`.
- The desktop's document tree nests the same paths into the sidebar's Wiki branch. The
  tree is the listing for the human reader, and the agent does not share it.

Two restrictions are deliberate. `search`'s `INPUT_GLOBS` excludes `wiki/` because
`search` has no budget and the bible is unbounded. Merging them would put an unbounded
tree behind a tool that cannot bound it, and
[`../reference/story-bible.md`](../reference/story-bible.md#who-reaches-it) states this as
policy. `Bible` has no `read()`, so the tree cannot be pasted.

Both of those are right. The agent should still be able to list.

## The map is the listing, and the map is truncated first

This finding turns a nice-to-have into a defect.

`renderGeneratedContext` fills its sections in order — characters, locations, scenes, then
the bible — drawing on `DEFAULT_BUDGET = 8000` characters. The bible comes last, and the
code's own comment calls it "the one that grows without bound". A section that cannot
print every row prints what fits and then a line stating how many rows it dropped:

```
… and 24 more note(s); use search_bible.
```

So on any project large enough for a bible to be worth having, the agent is told that
there are 37 notes, that 13 of them are included, and that the other 24 must be reached
through a tool that cannot list files. The fallback names the only tool available, and
that tool answers a different question.

The ordering compounds the problem. The cast growing, not the bible growing, is what
squeezes the bible: adding twenty characters drops bible rows off the end of the map with
no warning, and nothing ties the size of the cast to the size of the bible. A note's row
is 60–200 characters, so the visible fraction is not a stable property of the project; it
changes whenever another section changes size.

### A correction to `retrieval-beyond-grep.md` §H

That report's §H ("Agentic search, which is nearly built already") says the aiming
mechanism exists, citing the generated TOC, and concludes that what is missing is a prompt
paragraph and richer `search_bible` output. That conclusion holds only on small projects.
The TOC is not a tool. It is a budgeted context section with the bible in the last-paid
position, so the aiming mechanism degrades as the corpus that needs aiming grows. §H's two
suggestions remain right, but they are not sufficient, and the reason is structural rather
than a matter of prompt wording.

## What a listing door is

Three questions follow, none of which is "what does this note say":

1.  1. **What exists?** A table of contents is available on demand, and it has whatever
       size it actually is.
2.  2. **What is under here?** The answer is a subtree, such as `wiki/history/` or
       `wiki/factions/`, so an author's own folder structure becomes navigable rather than
       decorative.
3.  3. **Which notes are about X?** Matches against paths, titles, tags and headings only.
       "Is there a note about the war?" is a metadata question; "what were the
       casualties?" is a passage question. Today one tool answers both, and it answers the
       metadata question badly.

This sketch of the shape is meant to be argued with rather than built from:

```
list_bible(match?, under?, tag?, limit?)
```

— no arguments means the whole contents grouped by directory. `match` ranks on metadata
alone, `under` scopes to a subtree, and `tag` filters exactly. Exact `tag` filtering also
makes `type:`-tagged entity sheets filed in the wiki findable as a class.

Four properties matter more than the argument list:

- **Metadata only.** No argument combination produces body text.
- **Flat paths, not tree art.** The agent hands a path straight back to `read_file`. An
  ASCII tree costs extra tokens for box characters, which convey no more than a sorted
  path list does.
- **Budgeted at the same entry point, and truncation stated** — the generated map already
  follows this rule. A partial answer states that it is partial, because an answer that
  omits the truncation misleads the reader.
- **Deterministic order.** Every query walks before it answers: `query` refreshes first
  (`GrepBible.query`), and `files()` reports the last walk. A listing that names a note
  the author deleted a minute ago is worse than one that costs a `stat` per file.

It belongs in `@vn/bible` rather than in each caller, for the same reason `query`'s budget
does. `@vn/bible` enforces it at a single entry point, so a caller cannot forget it, and
the two hosts (the agent and the desktop) get the same answer.

## Three things it changes that are not about listing

**The map shrinks.** This effect is the largest, and it bears on the context system
generally. The bible's TOC is currently carried into every turn whether or not the turn
touches the wiki, and the TOC grows without bound. Once a tool can answer "what exists" on
demand, the map can carry a summary (a count and the top-level folders) and the agent
fetches detail when it has a reason. The cost is then paid on demand rather than on every
turn, which suits anything that grows without bound.

It splits the metadata signal out of passage ranking. `fileScore` (title ×3, tags ×2,
headings ×1) is computed per file and added to every window that file yields
(`packages/bible/src/query.ts:44`, `:80`) — the defect that retrieval-beyond-grep.md lists
as §3, whose open question is whether it was deliberate. That question changes shape here:
the file bonus stands in for metadata search because no separate metadata search exists.
Giving metadata search its own entry point lets the bonus fall back to a tiebreak, which
is what it should have been. The listing feature and the ranking fix are one edit,
approached from opposite ends.

A no-match reply can direct the agent elsewhere instead of ending the search.
`search_bible` on no match returns only "Nothing in the bible matches …"
(packages/authoring/src/tools.ts:357), which an agent reasonably reads as a statement that
the fact is not in this project. `search` handles this better: its no-match reply names
its own scope and names the tool that covers the rest. A listing door lets the bible's
no-match reply do the same, so a query that missed because it used the author's word for a
thing rather than the note's word becomes recoverable in one call.

## The boundary this must not cross

A listing door is where the no-`read()` guarantee will be questioned most often, so this
section states in advance what the guarantee covers and why it holds.

The guarantee is structural rather than a matter of discipline: `BibleFile` has no field
that can carry prose, so no argument to a listing tool can be made to return a document.
The desktop's `doc.read` is not a `bible.read` for the same reason. A person editing a
note needs the whole file, and a registry holding a `bible.read` would restore whole-file
reads in the one place the design forbids them.

A listing door adds a path, and a path is already public: the map prints them, the
document tree shows them, `read_file` accepts them. Listing shows what the agent can
already reach; it does not extend that reach. Write this into
[`../reference/story-bible.md`](../reference/story-bible.md#why-there-is-no-read)
alongside the existing argument, because the next person to read that section will be
looking at a tool whose name starts with `list_`.

## Cost

Small, and unusually well-bounded:

- `Bible` takes one new method over data it already holds. The ranking function alongside
  `Bible` is "pure" (free of side effects) and node-testable, like `rank`.
- A new agent tool costs a name and a description in the catalog until something loads it.
  `ALWAYS_LOADED` is pinned to six entries and everything else is deferred
  (packages/authoring/src/loop.ts:244).
- The desktop half adds one command, `bible.list`, alongside `bible.search`, and the
  palette, menus and CDP expose it without extra work. The tooltip text comes from the
  command's description, following the repo's rule that command-backed controls use the
  registry's own text.
- The map change belongs to the rendering code in `generated.ts`, and the existing budget
  tests guard it.

## Alternatives considered and rejected

- **Extend `search` to cover `wiki/`.** Rejected for the reason already written down:
  `search` has no budget, the bible is unbounded, and the merge puts one behind the other.
  The scope message that currently redirects to `search_bible` is deliberate and should
  stay.
- **Make `list_workspace` print the table of contents.** `list_workspace` is loaded early
  and often, so printing the table of contents charges an unbounded section as a fixed
  cost on every turn. The map already has that problem, so this repeats it rather than
  fixing it.
- **Render an ASCII tree.** The tree is prettier for a human and more expensive for a
  model, and the sidebar already serves the human.
- **Precompute backlinks over the wiki.** There is no link convention to traverse. In this
  project `[[…]]` is Fountain branch-marker syntax (`packages/parse/src/branch.ts`), and
  the desktop's backlinks are entity→document edges derived from the model in
  `apps/desktop/src/main/doctree.ts` rather than wiki-to-wiki links. Making this work
  would require first deciding that the wiki has links, which is a feature rather than a
  retrieval fix.
- **Expose `files()` raw, unbudgeted.** The result is metadata, which makes this option
  tempting. It is wrong because a 500-note bible is unbounded in a listing just as it is
  in a body search.

## Open questions

- **What does a listing do when it does not fit?** A truncated passage set loses detail. A
  truncated listing loses navigability, which is the thing being asked for. So the budget
  policy may need to differ from `query`'s: narrower defaults with filters that actually
  narrow, a directory-level summary on overflow ("`history/` — 40 notes"), or pagination.
  Nothing else in this tool vocabulary paginates.
- **Does `match` rank or filter?** Ranking handles a vague query better; filtering is
  predictable and cheap to test. `query` ranks, so ranking is the local idiom. A listing
  that filters drops non-matches silently, so its output omits entries that exist.
- **Should the map keep a bible section at all?** If a tool answers on demand, the honest
  options are a count plus top-level folders, or nothing plus a sentence naming the tool.
  Naming the tool alone is cheaper and risks the agent never looking. A count plus
  top-level folders is what prompts the agent to look. The choice is a question about the
  prompt as much as about the rendering.
- **Does tag filtering include entity types?** `type:` is folded into `tags` at index time
  (`indexer.ts`), so `tag: character` would find wiki-filed character sheets. This overlap
  is a useful coincidence if the agent is told about it, and a confusing overload of the
  discovery contract if the agent is not.
- **Does the refresh cost matter?** A `stat` per file per call is nothing at 40 notes and
  noticeable at 4000. `query` already pays it, so this is not a new question, but an agent
  may call a listing tool speculatively.
