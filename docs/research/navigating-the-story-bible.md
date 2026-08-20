# Navigating the story bible

_Investigation. Not a plan — no steps, no waves committed to. It asks what it would take for the
agent to **list and search the wiki's file tree**, and finds that the data already exists, that
the surface which comes closest to exposing it is the one budget pressure deletes first, and that
the missing door pays for itself three times over in places that are not about listing at all._

_Status: **nothing built.** `@vn/bible` ships `files()` (metadata) and `query()` (passages); the
agent can reach the second and not the first. Companion to
[`retrieval-beyond-grep.md`](retrieval-beyond-grep.md), which covers the **ranking** half of the
same package and which this document corrects on one point (§H)._

<!-- toc -->

- [The question](#the-question)
- [What the agent can see today](#what-the-agent-can-see-today)
- [The map is the listing, and the map is truncated first](#the-map-is-the-listing-and-the-map-is-truncated-first)
  * [A correction to `retrieval-beyond-grep.md` §H](#a-correction-to-retrieval-beyond-grepmd-%C2%A7h)
- [What a listing door is](#what-a-listing-door-is)
- [Three things it changes that are not about listing](#three-things-it-changes-that-are-not-about-listing)
- [The boundary this must not cross](#the-boundary-this-must-not-cross)
- [Cost](#cost)
- [Alternatives considered and rejected](#alternatives-considered-and-rejected)
- [Open questions](#open-questions)

<!-- tocstop -->

## The question

The agent can search the bible's **prose** and cannot see its **shape**. It cannot ask what notes
exist, what is filed under `wiki/history/`, or whether there is a note _called_ something about
the war — only what passages mention the word.

That is a navigation gap, not a retrieval gap, and the two have different fixes. This document
asks what the listing door should be, what it must not become, and what else in the context system
changes once it exists.

## What the agent can see today

`Bible.files()` returns exactly the metadata a listing needs — path, title, tags, headings, byte
count, and **no body** (`packages/bible/src/types.ts`). It has three readers, and none of them is
a tool the agent can call.

- **The workspace index reports a count.** `bibleFiles: bible.files().length`
  (`packages/authoring/src/workspace.ts:225`), rendered as _"Story bible: 37 file(s) under wiki/ —
  search it with search_bible"_ (`workspace.ts:423-426`). The agent learns a bible exists and
  nothing about what is in it.
- **The generated map renders the table of contents** — one row per note, path, title, tags and up
  to six headings (`packages/authoring/src/generated.ts`, `bibleRow`). This is the real aiming
  mechanism, and it is loaded into every turn as part of `AICONTEXT.generated.md`.
- **The desktop's document tree nests the same paths** into the sidebar's Wiki branch. That is the
  _human's_ listing; the agent does not share it.

And two doors are deliberately shut. `search`'s `INPUT_GLOBS` excludes `wiki/` because `search`
has no budget and the bible is unbounded — merging them would put an unbounded tree behind a tool
that cannot bound it, which [`../reference/story-bible.md`](../reference/story-bible.md#who-reaches-it) states as
policy. `Bible` has no `read()`, which is the guarantee that the tree cannot be pasted.

Both of those are right. Neither of them is a reason the agent should be unable to _list_.

## The map is the listing, and the map is truncated first

This is the finding that turns a nice-to-have into a defect.

`renderGeneratedContext` pays for its sections **in order** — characters, locations, scenes, then
the bible — against `DEFAULT_BUDGET = 8000` characters. The bible is last, and the code's own
comment calls it "the one that grows without bound". A section that cannot print every row prints
what fits and then a line saying how many it dropped:

```
… and 24 more note(s); use search_bible.
```

So on any project large enough for a bible to be worth having, the agent is told: there are 37
notes, here are 13 of them, and for the other 24 use a tool **that cannot list files**. The
fallback names the only door there is, and that door answers a different question.

The ordering compounds it. The bible is starved by the _cast_ growing, not by itself growing — add
twenty characters and bible rows fall off the end of the map, silently, with no relationship
between the two. And a note's row is 60–200 characters, so the visible fraction is not a stable
property of the project; it moves every time anything else does.

### A correction to `retrieval-beyond-grep.md` §H

That report's §H ("Agentic search, which is nearly built already") says the aiming mechanism
exists, citing the generated TOC, and concludes that what is missing is a prompt paragraph and
richer `search_bible` output. **That is true only on small projects.** The TOC is not a tool, it
is a budgeted context section with the bible in the last-paid position — so the aiming mechanism
degrades exactly as the corpus that needs aiming grows. §H's two suggestions remain right; they
are just not sufficient, and the reason is structural rather than a matter of prompt wording.

## What a listing door is

Three questions, none of which is "what does this note say":

1. **What exists?** The table of contents, on demand, at whatever size it actually is.
2. **What is under here?** A subtree — `wiki/history/`, `wiki/factions/` — so an author's own
   folder structure becomes navigable instead of decorative.
3. **Which notes are _about_ X?** Matching against **paths, titles, tags and headings only**.
   "Is there a note about the war?" is a metadata question; "what were the casualties?" is a
   passage question. Today one tool answers both, and answers the first one badly.

A sketch of the shape, offered to be argued with rather than built from:

```
list_bible(match?, under?, tag?, limit?)
```

— no arguments meaning the whole contents grouped by directory; `match` ranking on metadata alone;
`under` scoping to a subtree; `tag` filtering exactly, which incidentally makes `type:`-tagged
entity sheets filed in the wiki findable as a class.

Four properties matter more than the argument list:

- **Metadata only.** No body text, ever, by any argument combination.
- **Flat paths, not tree art.** The agent hands a path straight back to `read_file`; ASCII tree
  drawing spends tokens on box characters to convey what a sorted path list already conveys.
- **Budgeted at the same door, and truncation stated** — the rule the generated map already
  follows: a partial answer says it is partial, because silence is the one answer that misleads.
- **Deterministic order**, and a walk before answering: `query` refreshes first
  (`GrepBible.query`), `files()` reports the last walk, and a listing that confidently names a
  note the author deleted a minute ago is worse than one that costs a `stat` per file.

It belongs in `@vn/bible` rather than in each caller, for the same reason `query`'s budget does:
enforced at one door, a caller cannot forget it, and two hosts (the agent and the desktop) get the
same answer.

## Three things it changes that are not about listing

**It lets the map shrink.** This is the largest effect and the one that bears on the context
system generally. The bible's TOC is currently carried into _every turn_ whether or not the turn
touches the wiki, and it is the section that grows without bound. Once a tool can answer "what
exists" on demand, the map can carry a summary — a count and the top-level folders — and the
agent fetches detail when it has a reason. Every-turn cost becomes on-demand cost, which is the
right shape for anything unbounded.

**It splits the metadata signal out of passage ranking.** `fileScore` (title ×3, tags ×2, headings
×1) is computed per file and added to **every** window that file yields
(`packages/bible/src/query.ts:44`, `:80`) — the defect `retrieval-beyond-grep.md` lists as §3, and
whose open question is whether it was deliberate. This reframes that question: the file bonus is
carrying metadata search on its back because metadata search has nowhere else to live. Give it its
own door and the bonus can fall back to a tiebreak, which is what it should have been. **The
listing feature and the ranking fix are the same edit**, approached from opposite ends.

**It turns a dead end into a redirect.** `search_bible` on no match says only _"Nothing in the
bible matches …"_ (`packages/authoring/src/tools.ts:357`), which an agent reasonably reads as
_the fact is not in this project_. `search` gets this right — its no-match names its own scope and
points at the tool that covers the rest. With a listing door the bible's no-match can do the same,
and the failure mode where a query missed because it used the author's word for a thing instead of
the note's becomes recoverable in one call.

## The boundary this must not cross

A listing door is the place the no-`read()` guarantee will be re-litigated, so it is worth saying
in advance where the line is and why it holds.

The guarantee is **structural, not disciplinary**: `BibleFile` has no field that can carry prose,
so no argument to a listing tool can be made to return a document. That is the same reason the
desktop's `doc.read` is not a `bible.read` — a person editing a note needs the whole thing, and a
registry holding a `bible.read` would put the whole-file door back in the one place the design
says it must not be.

What a listing door adds is a **path**, and a path is already public: the map prints them, the
document tree shows them, `read_file` accepts them. Listing makes the agent's existing reach
legible; it does not extend it. Worth writing into
[`../reference/story-bible.md`](../reference/story-bible.md#why-there-is-no-read) alongside the existing argument,
because the next person to read that section will be looking at a tool whose name starts with
`list_`.

## Cost

Small, and unusually well-bounded:

- `Bible` grows one method over data it already holds; the ranking function beside it is pure and
  node-testable, like `rank`.
- Adding an agent tool is cheap: `ALWAYS_LOADED` is pinned to six and everything else is deferred
  (`packages/authoring/src/loop.ts:244`), so a new tool costs a name and a description in the
  catalog until something loads it.
- The desktop half is one command, `bible.list` beside `bible.search`, and the palette, menus and
  CDP get it free. Its description is its tooltip, per the repo's rule that command-backed controls
  take the registry's own text.
- The map change is a rendering decision in `generated.ts`, guarded by the existing budget tests.

## Alternatives considered and rejected

- **Extend `search` to cover `wiki/`.** Rejected for the reason already written down: `search` has
  no budget, the bible is unbounded, and the merge puts one behind the other. The scope message
  that currently redirects to `search_bible` is a feature.
- **Make `list_workspace` print the table of contents.** It is loaded early and often; this makes
  an unbounded section a fixed cost on every turn, which is the problem the map already has rather
  than a fix for it.
- **Render an ASCII tree.** Prettier for a human, more expensive for a model, and the sidebar
  already serves the human.
- **Precompute backlinks over the wiki.** There is no link convention to traverse — `[[…]]` in
  this project is Fountain branch-marker syntax (`packages/parse/src/branch.ts`), and the desktop's
  backlinks are entity→document edges derived from the model in
  `apps/desktop/src/main/doctree.ts`, not wiki-to-wiki links. Making this work means first deciding
  the wiki has links, which is a feature, not a retrieval fix.
- **Expose `files()` raw, unbudgeted.** Tempting because it is metadata, and wrong for the same
  reason a 500-note bible is unbounded in a listing as surely as in a body search.

## Open questions

- **What does a listing do when it does not fit?** A truncated _passage set_ loses detail; a
  truncated _listing_ loses navigability, which is the thing being asked for. So the budget policy
  may need to differ from `query`'s — narrower defaults with filters that actually narrow, a
  directory-level summary as the overflow ("`history/` — 40 notes"), or pagination, which nothing
  else in this tool vocabulary does.
- **Does `match` rank or filter?** Ranking is friendlier to a vague query; filtering is
  predictable and cheap to test. `query` ranks, so ranking is the local idiom — but a listing that
  silently drops non-matches is a listing that lies about what exists.
- **Should the map keep a bible section at all?** If a tool answers on demand, the honest options
  are a count plus top-level folders, or nothing plus a sentence naming the tool. The second is
  cheaper and risks the agent never looking; the first is what makes it curious. This is a prompt
  question as much as a rendering one.
- **Does tag filtering know about entity types?** `type:` is folded into `tags` at index time
  (`indexer.ts`), so `tag: character` would find wiki-filed character sheets. That is either a
  useful coincidence or a confusing overload of the discovery contract, and which one it is depends
  on whether the agent is told.
- **Does the refresh cost matter?** A `stat` per file per call is nothing at 40 notes and
  noticeable at 4000. `query` already pays it, so this is not a new question — but a listing tool
  is the kind of thing an agent calls speculatively.
