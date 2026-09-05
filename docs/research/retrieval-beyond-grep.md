# Retrieval beyond grep

_This is an investigation, not a plan: it commits to no steps and no waves. It surveys
what could replace the ranking in `@vn/bible` and compares each option against the
constraints that already apply to that package._

_Status: nothing is built yet. `@vn/bible` ships the grep-shaped ranker described in
[`../reference/story-bible.md`](../reference/story-bible.md#ranking), behind the
`query(text) → ranked excerpts` seam that
[`../plans/archive/INDEX.md#story-bible-and-retrieval`](../plans/archive/INDEX.md#story-bible-and-retrieval)
settled. That plan named the successor, "grep now, embeddings behind the same function".
This document argues that the first move is not the one that plan named._

<!-- toc -->

- [The question](#the-question)
- [What the current ranker actually does](#what-the-current-ranker-actually-does)
    - [1. `hits` is a substring test, not a term match](#1-hits-is-a-substring-test-not-a-term-match)
    - [2. There is no IDF, so a rare term is worth exactly what a common one is](#2-there-is-no-idf-so-a-rare-term-is-worth-exactly-what-a-common-one-is)
    - [3. The file bonus is added to every window, so one good title takes the page](#3-the-file-bonus-is-added-to-every-window-so-one-good-title-takes-the-page)
    - [4. The tokenizer is ASCII-only, and silently so](#4-the-tokenizer-is-ascii-only-and-silently-so)
    - [5. The excerpt's heading is not always the excerpt's heading](#5-the-excerpts-heading-is-not-always-the-excerpts-heading)
- [The constraints any replacement inherits](#the-constraints-any-replacement-inherits)
- [The unit is wrong before the ranker is wrong](#the-unit-is-wrong-before-the-ranker-is-wrong)
- [The options](#the-options)
    - [A. BM25F over the fields that already exist](#a-bm25f-over-the-fields-that-already-exist)
    - [B. Heading-scoped chunks](#b-heading-scoped-chunks)
    - [C. Local embeddings, and why they are cheaper here than they look](#c-local-embeddings-and-why-they-are-cheaper-here-than-they-look)
    - [D. Hybrid, because a story bible is mostly proper nouns](#d-hybrid-because-a-story-bible-is-mostly-proper-nouns)
    - [E. Query expansion, which cannot live in this package](#e-query-expansion-which-cannot-live-in-this-package)
    - [F. Contextual chunk headers, as a reindex artifact](#f-contextual-chunk-headers-as-a-reindex-artifact)
    - [G. Entity signal, without a precomputed backlink index](#g-entity-signal-without-a-precomputed-backlink-index)
    - [H. Agentic search, which is nearly built already](#h-agentic-search-which-is-nearly-built-already)
- [Alternatives considered and rejected](#alternatives-considered-and-rejected)
- [What each costs](#what-each-costs)
- [If this were to proceed](#if-this-were-to-proceed)
- [Open questions](#open-questions)

<!-- tocstop -->

## The question

[`../history/designRequirementsEtc.md`](../history/designRequirementsEtc.md) permits
"vector embedding databases or grepping or whatever", and the retrieval plan read that as
two steps: grep ships first, and embeddings replace it later. That framing has since
become an assumption that the upgrade path is vector search and that the obstacle is cost
(a paid third-party embedding service the project would rather not depend on).

Both halves of that assumption are wrong, and they are wrong in opposite directions.

Embeddings do not require a vendor. A 384-dimension sentence encoder runs in-process, on
CPU, in this repo's existing Node and Electron processes, with one model download and no
network thereafter. There is no per-query cost and no service to keep alive. Price is not
the reason to avoid reaching for embeddings first.

The current ranker is not grep; it is an under-powered lexical scorer with five specific
defects. Four of the five are cheaper to fix than to replace. The fifth (a substring test
standing in for a term match) silently produces wrong answers today on queries an author
would plausibly type. Replacing the whole layer with vectors would fix some of the five by
accident and make one of them worse.

This document lists the changes to retrieval that are worth making, in order, and gives
the cost of each, taking `@vn/bible`'s existing allow-list, budget contract and
determinism requirement as given.

## What the current ranker actually does

`packages/bible/src/query.ts` is 118 lines. The five observations below describe that file
as it stands, and each names the query that produced it.

### 1. `hits` is a substring test, not a term match

```ts
function hits(haystack: string, tokens: string[]): number {
    const lower = haystack.toLowerCase();
    return tokens.reduce((n, t) => (lower.includes(t) ? n + 1 : n), 0);
}
```

`String.includes` does not respect word boundaries. `key` matches `monkey`, `whiskey` and
`keystone`; `art` matches `start`, `heart` and `particular`; `ash` matches `washed`. In a
story bible (a corpus of invented words that share substrings with real ones) these
collisions are common.

The ranker's prefix matching is also asymmetric, and the asymmetry produces the behavior
of broken stemming. A query term that is a prefix of a document word matches (`keep` finds
"keeps"), and a document word that is a prefix of a query term does not (`keeper` does not
find "keep"). Matching therefore looks like stemming until the author types the longer
form of the word, at which point it stops with no indication. A conditional failure of
this kind is worse than not stemming at all, because whether matching works depends on
which form the author typed.

The fix is a word-boundary match, and it is one line. It also makes results worse on the
queries that were accidentally working (`roof` will stop finding "rooftop"). That
regression is the argument for doing it together with real stemming (§A) rather than
alone.

### 2. There is no IDF, so a rare term is worth exactly what a common one is

`hits` returns the number of distinct query terms present, capped at `tokens.length`.
Every term is worth 1. In a bible where every third note contains the word "key", the
query `who keeps the roof key` scores a note that says only "key" the same as a note that
says "roof". The term "roof" is the one that discriminates between those notes.

Inverse document frequency is the single largest quality gain available to this file. The
index already holds the required data, and computing document frequency per term takes one
pass over `IndexedFile[]`.

Term-frequency saturation is not a problem here. Because `hits` counts distinct terms
rather than occurrences, the code already has it by accident: a line repeating "key" forty
times scores 1, not 40. BM25's `k1` would add nothing the code does not already have. The
length normalisation `b` would add more, but only once the unit stops being a line (§B):
five-line windows do not vary enough in length for it to matter.

### 3. The file bonus is added to every window, so one good title takes the page

```ts
const bonus = fileScore(file, tokens);
all.push(...windowsOf(file, tokens, bonus));
```

`fileScore` is up to `3n` for an _n_-term query (title ×3, tags ×2, headings ×1), and it
is added to the score of every window in that file — up to `PER_FILE = 3` of them. A note
whose title matches the whole query therefore contributes three excerpts, each scoring at
least `3n`. A match that occurs only in the body of some other file in the tree scores at
most `n`.

With `DEFAULT_LIMIT = 8`, one well-titled note can take three of the eight slots and push
every competitor below the fold, in the worst case including the note that answers the
question. The field weighting is correct, but adding it as a flat per-window constant
makes it dominate. Multiplying it (or adding it once to the file's best window) behaves
better.

### 4. The tokenizer is ASCII-only, and silently so

```ts
for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
  ...
  if (token.length > 1 && !STOPWORDS.has(token)) seen.add(token);
}
```

The character class is `a-z0-9'`. Every other character is a delimiter, so:

- **Accented Latin is truncated.** `café` tokenises to `caf`; `Zoë` to `zo`. The
  `includes` substring test still matches often enough after that truncation that the bug
  is easy to miss early.
- **CJK text yields no tokens.** Every Han, Kana or Hangul character is a delimiter, so a
  query in Japanese produces zero tokens and `rank` returns `[]` on the first line. A
  visual novel project has a real CJK corpus.
- `token.length > 1` drops single-character tokens. This is correct for English, but it
  discards whole words in languages where a single character is a word.

`\p{L}\p{N}` with the `u` flag fixes the first two. The third needs a segmenter
(`Intl.Segmenter` with `granularity: 'word'` is in Node and Electron already, and is
deterministic) or a character-bigram index for CJK. Neither is required today, and both
are cheap to add. Without them, the failure mode is an empty result rather than a wrong
one.

### 5. The excerpt's heading is not always the excerpt's heading

```ts
const start = Math.max(0, index - CONTEXT);
...
const heading = file.headingAt[index];
out.push({ file: file.file, line: start + 1, ...(heading ? { heading } : {}), text, score });
```

`line` is the start of the window (`index - 2`); `heading` is the nearest enclosing
heading of the matching line (`index`). A match often sits within two lines of a heading,
because a heading line scores double and so wins its own window. In that case the
excerpt's reported first line lies above the heading it is attributed to, under the
previous section.

The consequence is small, but it is exactly the kind of thing
[`../reference/story-bible.md`](../reference/story-bible.md#how-a-file-is-indexed)
promises does not happen: "a reported `file:line` is the line an editor shows". A reported
`file:line` still is the line an editor shows. The heading is what now describes a
different part of the file. Attributing from `start` rather than `index` fixes this.

## The constraints any replacement inherits

These are not preferences. Each rule is already load-bearing somewhere.

- **Determinism.** The header comment in `query.ts` states that a test cannot pin a result
  order that varies, which is the reason for the `(score, file, line)` tie-break. Any
  successor must produce an order that `packages/bible/src/tests/bible.test.ts` can pin
  without a tolerance.
- **The offline property.** `@vn/testkit` runs real projects through the real scheduler
  with mock providers and no network. Retrieval must run under those same conditions; if
  testing it requires a live service, `@vn/testkit` no longer runs offline.
- **The allow-list.** `eslint.config.mjs` sets
  `bible: ['types', 'util', 'parse', 'store']`. The list does not include `providers`,
  `config`, or `model`. This constraint governs more of this document than any other, and
  §E is where it takes effect.
- **No whole-file API, and one budgeted entry point.** `files()` returns metadata,
  `query()` enforces the budget, and there is no third function. A new ranker is added
  behind `query` or not at all.
- **`openBible(root)` takes a directory.** The bible may be its own git repo
  ([`../plans/refactorTaskList.md`](../plans/refactorTaskList.md) item 4), may live
  outside the project, and callers must not assume it is writable. Code that caches to
  disk has to specify where the cache goes; see [Open questions](#open-questions).
- **The index rebuilds per file by mtime.** Whatever replaces the ranker rebuilds at the
  same granularity. That granularity helps a replacement whose cost is high per file (§C,
  §F) and makes no difference to one whose cost is low.

## The unit is wrong before the ranker is wrong

Retrieval quality is usually more sensitive to the chunk than to the scoring function.
This index chunks by line: each window holds the matching line plus `CONTEXT = 2` lines
either side, a file contributes at most `PER_FILE = 3` windows, and overlapping windows
are merged.

A five-line window is a bad unit for markdown prose. It cuts mid-paragraph, it carries no
statement of what it is about, and a fact that takes six lines to state cannot be
retrieved whole. The reader gets the half that happened to contain the query term. The
indexer already collects headings and records `headingAt` per line, so the section
boundaries are already computed, and nothing new has to be parsed to chunk by them.

This interacts with the budget, and the interaction is unfavourable. A five-line window is
perhaps 300 characters and never approaches `DEFAULT_BUDGET = 4000`. A heading-scoped
section routinely exceeds the budget on its own. The existing policy truncates the last
excerpt with `…`, and that policy then applies on most queries rather than rarely, so
results start to depend on `MIN_EXCERPT = 120`. Section chunking therefore raises a second
question: when a section exceeds the budget, which part of it is returned? Two answers are
honest ones. The first returns the best window within the section with the section's
heading attached, which is the current behaviour plus a label. The second returns a
sub-chunk at a fixed target size with overlap.

That cost is real and worth paying, but it means §B is not the one-line change it appears
to be.

## The options

There are eight, roughly in ascending order of what they cost. They are not exclusive, and
§D explicitly composes two of them.

### A. BM25F over the fields that already exist

Add IDF, fix the substring test, fix the tokenizer, stem, and make the file bonus
multiplicative rather than additive. Stay in pure TypeScript, add no new `packages/`
dependency, and add no new npm dependency except a stemmer (either `snowball-stemmers` or
~120 lines of Porter2 vendored into `util`).

The field structure of BM25F is already in place (title ×3, tags ×2, headings ×1). What
the scoring lacks is the term weighting underneath it.

**Determinism:** This is unchanged. The arithmetic stays integer and rational, and the
tie-break is the same. **Allow-list:** This is unchanged. **Effort:** This takes a day,
including the tests that pin the new order. **Risk:** Results move. Every existing ranking
assertion in `bible.test.ts` will need rewriting, which is intended, because the current
assertions pin behaviour that §§1–3 say is wrong.

This is the highest value per unit effort available, and every other option in this list
is better with it than without it. §D in particular should not be built on top of the
current scorer, because the lexical half of a hybrid has to be good for the fusion to beat
either side.

### B. Heading-scoped chunks

Chunk by markdown section rather than by line window, and attach the heading to the
excerpt as a label rather than as metadata. Chunking this way requires answering the
budget question in
[The unit is wrong before the ranker is wrong](#the-unit-is-wrong-before-the-ranker-is-wrong).

Determinism is unchanged. The allow-list is unchanged. The effort was two days, most of it
spent deciding and testing the over-budget policy.

Do this task with §A rather than after it. This task and §A touch the same file and the
same tests, and splitting them means writing the ranking assertions twice.

### C. Local embeddings, and why they are cheaper here than they look

Embedding needs no vendor. Three approaches avoid a third party and carry no per-query
cost:

- **`@huggingface/transformers` (transformers.js)** runs ONNX models in-process in Node
  and Electron. `all-MiniLM-L6-v2` is ~23 MB quantised at 384 dimensions;
  `bge-small-en-v1.5` and `gte-small` are comparable; `EmbeddingGemma` is purpose-built
  for on-device use. The model downloads once and is cached, and needs no network after
  that.
- **`node-llama-cpp`** with a GGUF embedding model, if GPU support is required or the ONNX
  runtime's native dependency is not acceptable. Ships prebuilt binaries.
- **Ollama** is self-hosted and free, but it runs as a service, and a dependency on a
  running service breaks the offline-testkit property outright. Ollama works as an
  optional backend and is wrong as the default.

The vector store requires no special design. A story bible is on the order of 10³–10⁴
chunks. Brute-force cosine over a `Float32Array` is sub-millisecond at that size, and
needs no index structure, no database, and no new package. A bible of six figures of
chunks would call for a different approach; nothing in this project suggests the bible
will grow that large.

**Embedding an ONNX runtime is architecturally cheaper than §E.** An ONNX runtime is an
npm dependency, not a `packages/` one, so `@vn/bible` can embed it without touching
`ALLOWED` at all. An LLM call cannot be embedded that way. The lower cost inverts the
intuition that "add a local model" is the bigger change.

The main cost is determinism, and this repo already contains the approaches that address
it. Floating-point non-determinism across hardware and thread counts can reorder exact
ties. This repo has precedent for three mitigations:

1.  1. **A `StubEmbedder` in testkit** that hashes text to a fixed vector, injected
       exactly as `RecordedChatBackend` and `StubImageBackend` are (`@vn/providers`
       mock.ts). Ranking tests then pin an order that is deterministic by construction,
       and a separate test exercises the real encoder by asserting relevance rather than
       order.
2.  2. **Quantise scores** to a fixed number of decimals before sorting, so that the
       existing `(score, file, line)` tie-break decides near-ties instead of the FPU.
3.  3. **Pin the model id and the execution provider** in whatever config carries it.
       `config` is not on `bible`'s allow-list, so the pinned configuration arrives as an
       argument to `openBible` rather than as a `ProjectConfig` read.

The storage location for the vectors is unresolved, because `openBible(root)` takes a
possibly-read-only, possibly-foreign directory. See [Open questions](#open-questions).

**Effort:** three to four days, most of it spent on the cache and the determinism harness
rather than on the embedding itself.

### D. Hybrid, because a story bible is mostly proper nouns

§A ranks lexically and §C ranks semantically, and Reciprocal Rank Fusion combines the two
rankings:

```
score(d) = Σ_i  1 / (k + rank_i(d))          k = 60
```

The approach takes twenty lines, has no weights to tune and no score normalisation between
two incomparable scales, and it reliably beats either input alone.

A story bible is unusually dense in invented proper nouns (characters, factions, places,
artefacts), and invented proper nouns are exactly where a sentence encoder is weakest and
lexical matching is strongest, so lexical matching matters more here than in a generic
corpus. A pure-vector replacement would regress on "find every note mentioning Verrin",
which is close to the most common query an author will actually issue. Fusion keeps that
lexical strength and adds the paraphrase case ("who keeps the roof key" → a section headed
_Custodianship_) that lexical matching cannot reach.

The rule is that the lexical side stays permanently: it is not a fallback to be retired,
and it supplies half of every answer.

### E. Query expansion, which cannot live in this package

Rewrite the query before scoring, so that `who keeps the roof key?` expands to
`{roof, key, custodian, caretaker, access, lock, groundskeeper}`. One cheap LLM call makes
the lexical ranker score semantically, with no embedding, no model download and no cache.

`@vn/bible` may not do it either. `ALLOWED.bible` is
`['types', 'util', 'parse', 'store']`; `@vn/providers` is not on that list, and adding it
would pull `config` in as well and put a network call behind a function that is guaranteed
to be deterministic and offline.

This is a placement decision rather than a blocker. Expansion belongs at the caller, above
the seam. Both callers are already in packages that may reach providers — `search_bible`
in `@vn/authoring`, and `bible.search` in the desktop main process. Each expands, then
calls the same unchanged `query(text)`. `@vn/bible` stays deterministic, stays offline,
stays testable, and never references an LLM.

This repo already uses the same deterministic fallback everywhere else (P1 enrichment, P5
decomposition): any failure produces no expansion and leaves the raw query, which is
exactly today's behaviour. Retrieval degrades to the current ranker rather than to
nothing.

Expansion inflates the term set, and every term added is a term that can match. Against
§1's substring `hits` it would make precision worse, not better. §E is only safe after §A.

Each caller takes half a day. The allow-list is unchanged, because nothing moves.

### F. Contextual chunk headers, as a reindex artifact

Prepend a generated one-line statement of context to each chunk before indexing (for
example, "From the note on the Verrin siege; concerns supply lines through the eastern
pass") so that a chunk states its subject even when the chunk's own text never names that
subject. The retrieval gain is large and well-attested, and it is paid once per file edit
rather than per query.

§E raises the same allow-list problem and takes the same shape of answer, but through a
different mechanism. A build step writes an artifact that `@vn/bible` reads, rather than a
call made at query time. The project already uses this pattern:
[`../plans/archive/INDEX.md#agent-context-regeneration`](../plans/archive/INDEX.md#agent-context-regeneration)'s
`workspace.reindex` writes `AICONTEXT.generated.md`, is budgeted, and refuses to overwrite
a file it did not write. Contextual headers are a second artifact from the same act.

This fits better here than in most codebases for two reasons:

- **The cache key is already solved.** A header is valid for exactly one version of one
  file, and this repo already uses a content hash for that case. Key on the file's content
  hash, and an edit invalidates exactly the headers it should.
- The index already rebuilds per file by mtime, so incremental updates need no new
  machinery. A file whose mtime changed gets new headers, and a hundred untouched notes
  cost nothing.

**Effort:** takes two days on top of §B, because headers only make sense against sections.
**Caveat:** puts generated text into retrieval results. A header must be visibly a header
(attributed and separable), or an author reading an excerpt cannot tell their own words
from the generated ones. This project has been careful about that distinction everywhere
else.

### G. Entity signal, without a precomputed backlink index

[`../reference/story-bible.md`](../reference/story-bible.md#why-there-is-no-read) already
rules out one version of this:

"which other notes mention Aiko" stays a `query`. The query is ranked and budgeted, and is
not a precomputed backlink index over the one tree that was deliberately given a budget.

The refusal concerns adding a second index and a second entry point, and it should stand.
Entity names may still serve as a ranking signal inside the single entry point that
exists. A query naming a character could weight notes that name the same character,
without any new API, any new artifact, and without letting a caller get more than `budget`
characters out.

The allow-list permits exactly enough for this and no more. `store` is available, so
`discoverEntities` and the `type:`-tagged sheets are reachable. `model` is not available,
so the story graph, `reachable`, and anything scene-derived are unreachable. A signal can
report that a note names a character the query named, and cannot report that a note names
a character in a scene downstream of the one being edited. The allow-list draws a sharper
boundary than it first appears to, and probably the right one, because a scene-downstream
relation belongs to the caller's context rather than to the bible.

**Effort:** a day. **Value:** unclear. This is the most speculative item here. Spike it
against a real bible before writing a plan.

### H. Agentic search, which is nearly built already

The last option is to improve the loop rather than the ranker. An agent with a table of
contents and a budgeted search tool can aim, look, read what it found, and search again.
That iteration routinely beats one-shot retrieval, whatever ranker sits underneath.

Most of this exists. `AICONTEXT.generated.md` lists the path, title, tags, and headings of
each bible file, which lets the agent aim a search.
[`../reference/story-bible.md`](../reference/story-bible.md#why-there-is-no-read) already
describes it as "what turns a blind `search_bible` into an aimed one". `list_workspace`
reports the count so the agent knows a bible exists.

Two pieces are missing, and together they are smaller than a retrieval project. The first
is a system prompt that tells the agent a second search is normal. The second is a
`search_bible` result carrying enough structure (which files were considered, what else
scored close) for a second query to be better aimed than a re-roll of the first. Both are
cheap, and both compound with everything above.

## Alternatives considered and rejected

**SQLite FTS5.** Provides BM25, porter stemming, phrase and `NEAR` queries, a trigram
tokenizer for substring and typo tolerance, and `snippet()` / `highlight()`, which
reproduce almost exactly the excerpt-window logic in `windowsOf`. `node:sqlite` ships in
Node core, so it adds no native dependency.

This approach is rejected for this corpus. It buys a binary index that must be built,
invalidated, kept out of git, and placed somewhere `openBible(root)` is allowed to write
(the whole of [Open questions](#open-questions)) in exchange for a ranker that §A writes
in a day and that the tests can pin exactly. At a few hundred markdown files the
in-memory, mtime-invalidated index is not the bottleneck and is not going to become one.
Revisit if the bible reaches a scale where the walk itself is slow, which would also be
the point where §C's brute-force cosine stops being free.

**A vector database** (`sqlite-vec`, LanceDB, hnswlib, or anything hosted) is rejected
outright at this corpus size. An approximate-nearest-neighbour index avoids a linear scan,
and that scan costs under a millisecond here. A vector database would add a dependency, a
build artifact, a placement question and a source of non-determinism, and gain nothing
measurable.

**Hosted embedding APIs.** Rejected, though this option is where the question started.
Cost is the smaller objection. The larger objection is that a hosted API makes retrieval
the single part of this system that cannot run in `@vn/testkit` without a network, and
that property is worth more than the ranking improvements such an API would deliver.

**Replacing lexical search with vectors outright** — this option reads "the layer an
embedding store replaces **wholesale**" in
[`../reference/story-bible.md`](../reference/story-bible.md#ranking) literally. The §D
argument rejects it, because it regresses proper-noun search, and proper-noun queries are
the class this corpus is densest in. The seam is still right and no caller changes. The
seam gets a hybrid implementation, not a vector one. That sentence in the as-shipped guide
should be softened when any of this lands.

## What each costs

| #   | Option                           | Effort          | New npm dep                 | `ALLOWED` change             | Deterministic | Offline                |
| --- | -------------------------------- | --------------- | --------------------------- | ---------------------------- | ------------- | ---------------------- |
| A   | BM25F + tokenizer + boundary fix | ~1 day          | stemmer (or vendor it)      | none                         | yes           | yes                    |
| B   | Heading-scoped chunks            | ~2 days         | none                        | none                         | yes           | yes                    |
| C   | Local ONNX embeddings            | ~4 days         | `@huggingface/transformers` | **none**                     | with a stub   | yes, after first fetch |
| D   | Hybrid RRF over A + C            | ~0.5 day        | none                        | none                         | inherits      | inherits               |
| E   | LLM query expansion              | ~0.5 day/caller | none                        | none — _lives at the caller_ | fallback is   | fallback is            |
| F   | Contextual chunk headers         | ~2 days after B | none                        | none — _reindex artifact_    | yes (cached)  | yes (cached)           |
| G   | Entity ranking signal            | ~1 day          | none                        | none                         | yes           | yes                    |
| H   | Aimed agentic search             | ~1 day          | none                        | none                         | n/a           | n/a                    |

Read the two columns together. Nothing in this list requires touching `ALLOWED.bible`, but
only because §E and §F are placed outside the package rather than inside it. This document
decides that placement; the rest of it works out the ranking arithmetic.

## If this were to proceed

The list below gives an order and the reasoning behind it, not a schedule:

1.  1. **§A and §B together.** They share one file, one set of tests, and one rewrite of
       the ranking assertions. Doing them apart pins the order twice. Together they carry
       the whole of the near-term value and cost three days.
2.  2. **§E at both callers.** Each caller takes half a day, and the work must follow §A,
       because applying §E against the current substring `hits` would reduce precision.
       The deterministic no-expansion fallback keeps the seam's guarantees intact.
3.  3. **§H.** Adds a prompt paragraph and slightly richer tool output, and combines with
       everything else.
4.  4. **§C behind the seam, with §D fusing it to §A.** This is worth four days once §1–§3
       have landed and the failures that remain are paraphrase failures, where a query's
       answer exists under different words. Until the lexical half is good, there is
       nothing for a hybrid to fuse.
5.  5. **§F**, only if §C's cache placement is already settled — both ask where derived
       artifacts for a foreign, possibly read-only bible root live, and the answer has to
       be the same in each case.
6.  6. **§G** comes only after a spike against a real bible.

One requirement is not on the list. No step uses a vector database.

## Open questions

- **Where does a derived artifact for the bible live?** `openBible(root)` may be handed a
  directory outside the project, in its own git repo and possibly read-only. Embeddings
  (§C) and contextual headers (§F) both need somewhere to cache, keyed by content hash.
  The candidates are `vngen/work/bible/` in the project (breaks when two projects share a
  bible), a sibling of the root (requires the root to be writable), or the OS cache
  directory keyed by the root's absolute path (invisible to git, which may be correct for
  a derived artifact). This question blocks §C and §F and nothing else.
- **Should the budget be characters or tokens?** `budget` is a character count, and its
  purpose is to avoid overrunning a context window. A character count and a token count
  match only for English prose; 4000 characters of CJK, or of anything code-shaped, is a
  great many more tokens. The seam would not change (only the accounting behind it), but
  the default would need re-choosing.
- **Is §3 a bug or a preference?** Flattening the file bonus to a per-window constant may
  have been deliberate. If it was, the reasoning is not written down anywhere, and that
  missing reasoning needs to be recorded.
- **Should §B use overlap?** Sub-chunking an over-budget section with a sliding overlap is
  standard practice and would put the same sentence in two chunks. The budget is enforced
  at a single point, so duplicated text consumes budget twice. The answer is probably no
  overlap, and the decision is worth stating either way.
- **What establishes §C's quality?** The determinism harness (a `StubEmbedder`) checks
  ordering, not relevance. Judging whether the real encoder helps requires a small
  labelled set of query → expected-note pairs over a real bible, and this repo has no
  fixture of that shape. The recorded-asset corpus in `@vn/testkit` is the nearest
  precedent for building one.
