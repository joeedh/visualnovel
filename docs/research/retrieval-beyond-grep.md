# Retrieval beyond grep

_Investigation. Not a plan — no steps, no waves committed to. It surveys what could replace the
ranking in `@vn/bible`, and prices each option against the constraints that package already
carries._

_Status: **nothing built.** `@vn/bible` ships the grep-shaped ranker described in
[`../story-bible.md`](../story-bible.md#ranking), behind the `query(text) → ranked excerpts` seam
[`../plans/story-bible-and-retrieval.md`](../plans/archive/story-bible-and-retrieval.md) settled. That
plan named the successor — "grep now, embeddings behind the same function" — and this document
argues the first move is **not** the one it named._

<!-- toc -->

- [The question](#the-question)
- [What the current ranker actually does](#what-the-current-ranker-actually-does)
  * [1. `hits` is a substring test, not a term match](#1-hits-is-a-substring-test-not-a-term-match)
  * [2. There is no IDF, so a rare term is worth exactly what a common one is](#2-there-is-no-idf-so-a-rare-term-is-worth-exactly-what-a-common-one-is)
  * [3. The file bonus is added to every window, so one good title takes the page](#3-the-file-bonus-is-added-to-every-window-so-one-good-title-takes-the-page)
  * [4. The tokenizer is ASCII-only, and silently so](#4-the-tokenizer-is-ascii-only-and-silently-so)
  * [5. The excerpt's heading is not always the excerpt's heading](#5-the-excerpts-heading-is-not-always-the-excerpts-heading)
- [The constraints any replacement inherits](#the-constraints-any-replacement-inherits)
- [The unit is wrong before the ranker is wrong](#the-unit-is-wrong-before-the-ranker-is-wrong)
- [The options](#the-options)
  * [A. BM25F over the fields that already exist](#a-bm25f-over-the-fields-that-already-exist)
  * [B. Heading-scoped chunks](#b-heading-scoped-chunks)
  * [C. Local embeddings, and why they are cheaper here than they look](#c-local-embeddings-and-why-they-are-cheaper-here-than-they-look)
  * [D. Hybrid, because a story bible is mostly proper nouns](#d-hybrid-because-a-story-bible-is-mostly-proper-nouns)
  * [E. Query expansion, which cannot live in this package](#e-query-expansion-which-cannot-live-in-this-package)
  * [F. Contextual chunk headers, as a reindex artifact](#f-contextual-chunk-headers-as-a-reindex-artifact)
  * [G. Entity signal, without a precomputed backlink index](#g-entity-signal-without-a-precomputed-backlink-index)
  * [H. Agentic search, which is nearly built already](#h-agentic-search-which-is-nearly-built-already)
- [Alternatives considered and rejected](#alternatives-considered-and-rejected)
- [What each costs](#what-each-costs)
- [If this were to proceed](#if-this-were-to-proceed)
- [Open questions](#open-questions)

<!-- tocstop -->

## The question

[`../designRequirementsEtc.md`](../designRequirementsEtc.md) permits "vector embedding databases
or grepping or whatever", and the retrieval plan read that as a two-step: ship grep, swap in
embeddings later. The framing has since hardened into an assumption that the upgrade path is
*vector search*, and that the obstacle is *cost* — a paid third-party embedding service the
project would rather not depend on.

Both halves of that assumption are wrong, and in opposite directions.

**Embeddings do not require a vendor.** A 384-dimension sentence encoder runs in-process, on
CPU, in this repo's existing Node and Electron processes, with one model download and no network
thereafter. There is no per-query cost and no service to keep alive. The reason not to reach for
embeddings first is not price.

**And the current ranker is not grep.** It is an under-powered lexical scorer with five specific
defects, four of which are cheaper to fix than to replace, and one of which — a substring test
standing in for a term match — produces wrong answers today, silently, on queries an author would
plausibly type. Replacing the whole layer with vectors would fix some of those by accident and
make one of them worse.

So the question this document actually answers is: **given `@vn/bible`'s existing allow-list,
budget contract and determinism requirement, what is the ordered list of things worth doing to
retrieval, and what does each cost?**

## What the current ranker actually does

`packages/bible/src/query.ts` is 118 lines. The five observations below are against that file as
it stands, and each is stated with the query that exposes it.

### 1. `hits` is a substring test, not a term match

```ts
function hits(haystack: string, tokens: string[]): number {
  const lower = haystack.toLowerCase();
  return tokens.reduce((n, t) => (lower.includes(t) ? n + 1 : n), 0);
}
```

`String.includes` does not respect word boundaries. `key` matches **monkey**, **whiskey** and
**keystone**; `art` matches **start**, **heart** and **particular**; `ash` matches **washed**.
In a story bible — which is exactly a corpus of invented words that share substrings with real
ones — this is not a rare event.

It is also **asymmetric in a way that reads as broken stemming**. A query term that is a prefix
of a document word matches (`keep` finds "keeps"), and a document word that is a prefix of a
query term does not (`keeper` does not find "keep"). So the ranker appears to stem, right up
until the author types the longer form of the word, at which point it silently stops. That is
worse than not stemming, because the failure is conditional on which form the author happened to
reach for.

The fix is a word-boundary match, and it is one line. It also **makes results worse** on the
queries that were accidentally working — `roof` will stop finding "rooftop" — which is the
argument for doing it together with real stemming (§A) rather than alone.

### 2. There is no IDF, so a rare term is worth exactly what a common one is

`hits` returns *how many distinct query terms are present*, capped at `tokens.length`. Every term
is worth 1. In a bible where every third note contains the word "key", a query of
`who keeps the roof key` scores a note that merely says "key" identically to one that says
"roof" — and "roof" is the term that actually discriminates.

Inverse document frequency is the single largest quality gain available to this file, and the
index already holds what it needs: document frequency per term is one pass over `IndexedFile[]`.

Note what is **not** wrong here. Because `hits` counts distinct terms rather than occurrences,
term-frequency saturation is already present by accident — a line repeating "key" forty times
scores 1, not 40. BM25's `k1` would be buying something the code already has. The length
normalisation `b` buys more, but only once the unit stops being a line (§B): five-line windows do
not vary enough in length for it to matter.

### 3. The file bonus is added to every window, so one good title takes the page

```ts
const bonus = fileScore(file, tokens);
all.push(...windowsOf(file, tokens, bonus));
```

`fileScore` is up to `3n` for an *n*-term query (title ×3, tags ×2, headings ×1), and it is added
to the score of **every** window in that file — up to `PER_FILE = 3` of them. A note whose title
matches the whole query therefore contributes three excerpts, each scoring at least `3n`, against
a body-only match anywhere else in the tree scoring at most `n`.

With `DEFAULT_LIMIT = 8`, one well-titled note can take three of the eight slots and push every
competitor below the fold — including, in the worst case, the note that actually answers the
question. The field weighting is right; adding it as a flat per-window constant is what makes it
dominate. Multiplying, or adding it once to the file's best window, both behave better.

### 4. The tokenizer is ASCII-only, and silently so

```ts
for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
  ...
  if (token.length > 1 && !STOPWORDS.has(token)) seen.add(token);
}
```

The character class is `a-z0-9'`. Every other character is a delimiter, so:

- **Accented Latin is cut in half.** `café` tokenises to `caf`; `Zoë` to `zo`. The `includes`
  substring test then papers over this often enough that it will not be noticed early.
- **CJK is destroyed entirely.** Every Han, Kana or Hangul character is a delimiter, so a query
  in Japanese produces zero tokens and `rank` returns `[]` on the first line. For a visual novel
  project this is not a hypothetical corpus.
- **`token.length > 1` drops single-character tokens**, which is correct for English and fatal
  for languages where a single character is a word.

`\p{L}\p{N}` with the `u` flag fixes the first two. The third needs a segmenter
(`Intl.Segmenter` with `granularity: 'word'` is in Node and Electron already, and is
deterministic) or a character-bigram index for CJK. Neither is required today; both are cheap
insurance, and the failure mode without them is an empty result rather than a bad one, which at
least is honest.

### 5. The excerpt's heading is not always the excerpt's heading

```ts
const start = Math.max(0, index - CONTEXT);
...
const heading = file.headingAt[index];
out.push({ file: file.file, line: start + 1, ...(heading ? { heading } : {}), text, score });
```

`line` is the start of the window (`index - 2`); `heading` is the nearest enclosing heading of the
**matching** line (`index`). When the match sits within two lines of a heading — which is common,
since a heading line scores double and therefore wins its own window — the excerpt's reported
first line lies *above* the heading it is attributed to, under the previous section.

The consequence is small but is exactly the kind of thing
[`../story-bible.md`](../story-bible.md#how-a-file-is-indexed) promises does not happen: "a
reported `file:line` is the line an editor shows". It still is. It is the *heading* that is now
describing a different part of the file. Attributing from `start` rather than `index` is the fix.

## The constraints any replacement inherits

These are not preferences; each is already load-bearing somewhere.

- **Determinism.** "A result order a test cannot pin is a test of nothing" — `query.ts`'s own
  header comment, and the reason for the `(score, file, line)` tie-break. Any successor must be
  pinnable by `packages/bible/src/tests/bible.test.ts` without a tolerance.
- **The offline property.** `@vn/testkit` runs real projects through the real scheduler with mock
  providers and no network. Retrieval must not become the one thing that needs a service to be
  tested, or that property is gone.
- **The allow-list.** `eslint.config.mjs` gives `bible: ['types', 'util', 'parse', 'store']`.
  Not `providers`. Not `config`. Not `model`. This is the constraint that decides more of this
  document than any other, and §E is where it bites.
- **No whole-file API, budget at one door.** `files()` is metadata, `query()` is budgeted, and
  there is no third function. Any new ranker enters behind `query` or not at all.
- **`openBible(root)` takes a directory.** The bible may be its own git repo
  ([`../plans/refactorTaskList.md`](../plans/refactorTaskList.md) item 4), may live outside the
  project, and **must not be assumed writable**. Anything that wants a cache on disk has to
  answer where it goes; see [Open questions](#open-questions).
- **The index rebuilds per file by mtime.** Whatever replaces the ranker inherits that
  granularity, which is good news for anything expensive-per-file (§C, §F) and irrelevant to
  anything cheap.

## The unit is wrong before the ranker is wrong

Retrieval quality is usually more sensitive to the **chunk** than to the scoring function, and
this index chunks by line: the matching line plus `CONTEXT = 2` either side, at most `PER_FILE = 3`
windows per file, merged when they overlap.

A five-line window is a bad unit for markdown prose. It cuts mid-paragraph, it carries no
statement of what it is about, and a fact that takes six lines to state cannot be retrieved
whole — the reader gets the half that happened to contain the query term. The indexer already
collects headings and records `headingAt` per line, so the section boundaries are **already
computed**; nothing new has to be parsed to chunk by them.

The catch is that this interacts with the budget, and not in the direction that flatters it. A
five-line window is perhaps 300 characters and never approaches `DEFAULT_BUDGET = 4000`. A
heading-scoped section routinely exceeds it on its own, at which point the existing policy —
truncate the last excerpt with `…` — stops being a rare edge and becomes the common path, and
`MIN_EXCERPT = 120` starts deciding results. Section chunking therefore comes with a second
question it must answer: **when a section exceeds the budget, which part of it is returned?**
(The honest answers are: the best window within the section, with the section's heading attached
— which is the current behaviour plus a label — or a sub-chunk at a fixed target size with
overlap.)

That is a real cost, and it is still worth paying. But it means §B is not the one-line change it
looks like.

## The options

Eight, roughly in ascending order of what they cost. They are not exclusive; §D is explicitly a
composition of two of them.

### A. BM25F over the fields that already exist

Add IDF, fix the substring test, fix the tokenizer, stem, and make the file bonus multiplicative
rather than additive. Pure TypeScript, no new `packages/` dependency, no new npm dependency
except a stemmer (`snowball-stemmers`, or ~120 lines of Porter2 vendored into `util`).

This is BM25F in all but name — the field structure (title ×3, tags ×2, headings ×1) is already
there; what is missing is the term weighting underneath it.

**Determinism:** unchanged. Integer and rational arithmetic, same tie-break.
**Allow-list:** unchanged.
**Effort:** a day, including the tests that pin the new order.
**Risk:** results move. Every existing ranking assertion in `bible.test.ts` will need rewriting,
and that is the point — the current assertions pin behaviour that §§1–3 say is wrong.

This is the highest value per unit effort available, and every other option in this list is
better with it than without it. §D in particular is *not worth building* on top of the current
scorer, because the lexical half of a hybrid has to be good for the fusion to beat either side.

### B. Heading-scoped chunks

Chunk by markdown section rather than line window, attaching the heading to the excerpt as a
label rather than as metadata. Requires answering the budget question in
[The unit is wrong before the ranker is wrong](#the-unit-is-wrong-before-the-ranker-is-wrong).

**Determinism:** unchanged. **Allow-list:** unchanged. **Effort:** two days, most of it in
deciding and testing the over-budget policy.

Do this with §A, not after it — they touch the same file and the same tests, and splitting them
means writing the ranking assertions twice.

### C. Local embeddings, and why they are cheaper here than they look

The vendor question is a non-question. Three ways to embed with no third party and no per-query
cost:

- **`@huggingface/transformers` (transformers.js)** runs ONNX models in-process in Node and
  Electron. `all-MiniLM-L6-v2` is ~23 MB quantised at 384 dimensions; `bge-small-en-v1.5` and
  `gte-small` are comparable; `EmbeddingGemma` is purpose-built for on-device. The model
  downloads once and caches. After that: no network.
- **`node-llama-cpp`** with a GGUF embedding model, if GPU is wanted or the ONNX runtime's native
  dependency is unwelcome. Ships prebuilt binaries.
- **Ollama**, self-hosted and free — but it is a *running service*, and depending on one breaks
  the offline-testkit property outright. Viable as an optional backend, wrong as the default.

**The vector store is not a problem to solve.** A story bible is on the order of 10³–10⁴ chunks.
Brute-force cosine over a `Float32Array` is sub-millisecond at that size. No index structure, no
database, no new package. If the bible ever reaches six figures of chunks the answer changes;
nothing in this project suggests it will.

**The layering surprise: this is architecturally *cheaper* than §E.** An ONNX runtime is an npm
dependency, not a `packages/` one, so `@vn/bible` can embed without touching `ALLOWED` at all. An
LLM call cannot. That inverts the intuition that "add a local model" is the bigger change.

**Determinism is the real cost, and the project already owns the answer.** Floating-point
non-determinism across hardware and thread counts can reorder exact ties. Three mitigations, all
of which this repo has precedent for:

1. **A `StubEmbedder` in testkit** that hashes text to a fixed vector, injected exactly as
   `RecordedChatBackend` / `StubImageBackend` are (`@vn/providers` `mock.ts`). Ranking tests then
   pin an order that is deterministic by construction, and the real encoder is exercised
   separately by a test that asserts *relevance*, not *order*.
2. **Quantise scores** to a fixed number of decimals before sorting, so near-ties fall to the
   existing `(score, file, line)` tie-break rather than to the FPU.
3. **Pin the model id and the execution provider** in whatever config carries it — note that
   `config` is *not* on `bible`'s allow-list, so this arrives as an argument to `openBible`, not
   as a `ProjectConfig` read.

**Where the vectors live** is the unresolved part, and it is a consequence of `openBible(root)`
taking a possibly-read-only, possibly-foreign directory. See
[Open questions](#open-questions).

**Effort:** three to four days, most of it in the cache and the determinism harness rather than
the embedding itself.

### D. Hybrid, because a story bible is mostly proper nouns

Rank twice — §A lexically, §C semantically — and fuse with Reciprocal Rank Fusion:

```
score(d) = Σ_i  1 / (k + rank_i(d))          k = 60
```

Twenty lines, no weights to tune, no score normalisation between two incomparable scales, and it
reliably beats either input alone.

This matters more here than in a generic corpus. **A story bible is unusually dense in invented
proper nouns** — characters, factions, places, artefacts — and invented proper nouns are exactly
where a sentence encoder is weakest and lexical matching is strongest. A pure-vector replacement
would *regress* on "find every note mentioning Verrin", which is close to the most common query
an author will actually issue. Fusion keeps that, and buys the paraphrase case ("who keeps the
roof key" → a section headed *Custodianship*) that lexical cannot reach.

Stated as a rule: **the lexical side is not a fallback to be retired. It is half the answer,
permanently.**

### E. Query expansion, which cannot live in this package

Rewrite the query before scoring: `who keeps the roof key?` →
`{roof, key, custodian, caretaker, access, lock, groundskeeper}`. One cheap LLM call converts the
lexical ranker into something that behaves semantically, with no embedding, no model download and
no cache.

**And `@vn/bible` may not do it.** `ALLOWED.bible` is `['types', 'util', 'parse', 'store']`;
`@vn/providers` is not on it, and adding it would drag `config` in behind it and put a network
call behind a function whose whole guarantee is that it is deterministic and offline.

That is not a blocker, it is a placement decision: **expansion belongs at the caller, above the
seam.** Both callers are already in packages that may reach providers —
`search_bible` in `@vn/authoring`, and `bible.search` in the desktop main process. Each expands,
then calls the same unchanged `query(text)`. `@vn/bible` stays deterministic, stays offline,
stays testable, and never learns that an LLM exists.

The deterministic fallback is the one this repo already uses everywhere else (P1 enrichment, P5
decomposition): **on any failure, no expansion** — the raw query, which is exactly today's
behaviour. Retrieval degrades to the current ranker rather than to nothing.

One caution worth writing down: expansion inflates the term set, and every term added is a term
that can match. Against §1's substring `hits` it would make precision *worse*, not better. **§E
is only safe after §A.**

**Effort:** half a day per caller. **Allow-list:** unchanged, because nothing moves.

### F. Contextual chunk headers, as a reindex artifact

Prepend a generated one-line statement of context to each chunk before indexing — *"From the note
on the Verrin siege; concerns supply lines through the eastern pass"* — so that a chunk carries
what it is about even when the chunk itself never names it. This is a large and well-attested
retrieval gain, and it is paid once per file edit rather than per query.

The same allow-list problem as §E applies, and the same shape of answer, but a different
mechanism: this is not a call at query time, it is **a build step that writes an artifact
`@vn/bible` reads**. The project already has the pattern —
[`../plans/agent-context-regeneration.md`](../plans/archive/agent-context-regeneration.md)'s
`workspace.reindex` writes `AICONTEXT.generated.md`, is budgeted, and refuses to overwrite a file
it did not write. Contextual headers are a second artifact from the same act.

Two things make this fit better here than it fits most codebases:

- **The cache key is already solved.** A header is valid for exactly one version of one file, and
  this repo's reflex for that is a content hash. Key on the file's content hash, and an edit
  invalidates precisely the headers it should.
- **The index already rebuilds per file by mtime**, so the incremental story needs no new
  machinery — a file whose mtime moved gets new headers, and a hundred untouched notes cost
  nothing.

**Effort:** two days on top of §B, since headers only make sense against sections.
**Caveat:** it puts generated text into retrieval results. The header must be visibly a header —
attributed and separable — or an author reading an excerpt cannot tell their own words from the
machine's, which is a line this project has been careful about everywhere else.

### G. Entity signal, without a precomputed backlink index

[`../story-bible.md`](../story-bible.md#why-there-is-no-read) already refuses one version of this:

> "which other notes mention Aiko" stays a `query`, ranked and budgeted, rather than becoming a
> precomputed backlink index over the one tree that was deliberately given a budget.

That refusal is about **a second index and a second door**, and it should stand. It does not
forbid using entity names as a **ranking signal inside the one door there is**. A query naming a
character could weight notes that name the same character, without any new API, any new artifact,
or any way for a caller to get more than `budget` characters out.

The allow-list permits exactly enough for this and no more: `store` is available, so
`discoverEntities` and the `type:`-tagged sheets are reachable. `model` is **not**, so the story
graph, `reachable`, and anything scene-derived are not — the signal can be "this note names a
character the query named", and cannot be "this note names a character in a scene downstream of
the one you are editing". That is a sharper boundary than it first appears, and it is probably
the right one: the second thing is the caller's context, not the bible's.

**Effort:** a day. **Value:** unclear, and the most speculative item here. Worth a spike against
a real bible before it is worth a plan.

### H. Agentic search, which is nearly built already

The last option is to improve the *loop* rather than the ranker. An agent with a table of
contents and a budgeted search tool can aim, look, read what it found, and search again — and
that iteration routinely beats one-shot retrieval, whatever the ranker underneath.

Most of this exists. `AICONTEXT.generated.md` renders the bible as a table of contents — path,
title, tags, headings — which is precisely the aiming mechanism, and
[`../story-bible.md`](../story-bible.md#why-there-is-no-read) already describes it as "what turns
a blind `search_bible` into an aimed one". `list_workspace` reports the count so the agent knows
a bible exists.

What is missing is smaller than a retrieval project: the system prompt telling the agent that
*searching twice is normal*, and `search_bible` returning enough structure (which files were
considered, what else scored close) for a second query to be better aimed than a re-roll of the
first. Cheap, and it compounds with everything above.

## Alternatives considered and rejected

**SQLite FTS5.** Gives BM25, porter stemming, phrase and `NEAR` queries, a trigram tokenizer for
substring and typo tolerance, and `snippet()` / `highlight()` — which is, almost exactly, the
excerpt-window logic in `windowsOf`. `node:sqlite` is in Node core, so it need not even be a
native dependency.

Rejected, for this corpus. It buys a binary index that must be built, invalidated, kept out of
git, and placed somewhere `openBible(root)` is allowed to write — the whole of
[Open questions](#open-questions) — in exchange for a ranker that §A writes in a day and that the
tests can pin exactly. At a few hundred markdown files the in-memory, mtime-invalidated index is
not the bottleneck and is not going to become one. Revisit if the bible reaches a scale where the
walk itself is slow, which would also be the point where §C's brute-force cosine stops being
free.

**A vector database** — `sqlite-vec`, LanceDB, hnswlib, or anything hosted. Rejected outright at
this corpus size: an approximate-nearest-neighbour index is a technique for avoiding a linear
scan that costs under a millisecond here. It would add a dependency, a build artifact, a
placement question and a source of non-determinism, and buy nothing measurable.

**Hosted embedding APIs.** Rejected, and this is the one the question started from. Cost is the
smaller objection; the larger one is that it makes retrieval the single part of this system that
cannot run in `@vn/testkit` without a network, and that property is worth more than any ranking
improvement on offer.

**Replacing lexical search with vectors outright** — the literal reading of "the layer an
embedding store replaces **wholesale**" in [`../story-bible.md`](../story-bible.md#ranking).
Rejected on the §D argument: it regresses proper-noun search, which is the query class this
corpus is densest in. The seam is still right and no caller still changes; what the seam gets is
a *hybrid* implementation, not a vector one. That sentence in the as-shipped guide should be
softened when any of this lands.

## What each costs

| # | Option | Effort | New npm dep | `ALLOWED` change | Deterministic | Offline |
| --- | --- | --- | --- | --- | --- | --- |
| A | BM25F + tokenizer + boundary fix | ~1 day | stemmer (or vendor it) | none | yes | yes |
| B | Heading-scoped chunks | ~2 days | none | none | yes | yes |
| C | Local ONNX embeddings | ~4 days | `@huggingface/transformers` | **none** | with a stub | yes, after first fetch |
| D | Hybrid RRF over A + C | ~0.5 day | none | none | inherits | inherits |
| E | LLM query expansion | ~0.5 day/caller | none | none — *lives at the caller* | fallback is | fallback is |
| F | Contextual chunk headers | ~2 days after B | none | none — *reindex artifact* | yes (cached) | yes (cached) |
| G | Entity ranking signal | ~1 day | none | none | yes | yes |
| H | Aimed agentic search | ~1 day | none | none | n/a | n/a |

Two columns deserve to be read together. **Nothing in this list requires touching
`ALLOWED.bible`** — but only because §E and §F are placed outside the package rather than inside
it. That placement is the design content of this document; the rest is ranking arithmetic.

## If this were to proceed

An order, with the reasoning rather than a schedule:

1. **§A and §B together.** One file, one set of tests, one rewrite of the ranking assertions.
   Doing them apart means pinning the order twice. This is the whole of the near-term value and
   it costs three days.
2. **§E at both callers.** Half a day each, strictly after §A — against the current substring
   `hits` it would reduce precision. The deterministic no-expansion fallback keeps the seam's
   guarantees intact.
3. **§H.** A prompt paragraph and slightly richer tool output. Compounds with everything.
4. **§C behind the seam, with §D fusing it to §A.** The point at which this is worth four days is
   when §1–§3 have landed and the *remaining* failures are paraphrase failures — a query whose
   answer exists under different words. Until the lexical half is good, a hybrid has nothing to
   fuse.
5. **§F**, only if §C's cache placement is already settled — they want the same answer to the same
   question about where derived artifacts for a foreign, possibly read-only bible root live.
6. **§G**, only after a spike against a real bible.

And one thing that is not on the list: **no vector database, at any step.**

## Open questions

- **Where does a derived artifact for the bible live?** `openBible(root)` may be handed a
  directory outside the project, in its own git repo, possibly read-only. Embeddings (§C) and
  contextual headers (§F) both need somewhere to cache, keyed by content hash. Candidates:
  `vngen/work/bible/` in the project (breaks when two projects share a bible), a sibling of the
  root (requires it to be writable), or the OS cache directory keyed by the root's absolute path
  (invisible to git, which for a derived artifact may be correct). This question blocks §C and §F
  and nothing else.
- **Should the budget be characters or tokens?** `budget` is a character count, and its purpose
  is not to overrun a context window. Those are the same thing only for English prose; 4000
  characters of CJK, or of anything code-shaped, is a great many more tokens. The seam would not
  change — only the accounting behind it — but the default would need re-choosing.
- **Is §3 a bug or a preference?** Flattening the file bonus to a per-window constant may have
  been deliberate. If it was, the reasoning is not written down anywhere, which is itself
  something to fix.
- **Does §B want overlap?** Sub-chunking an over-budget section with a sliding overlap is standard
  practice and would put the same sentence in two chunks. Against a budget enforced at one door,
  duplicate text is spent budget. Probably no overlap; worth stating either way.
- **What pins §C's quality?** The determinism harness (a `StubEmbedder`) pins *order*, not
  *relevance*. Judging whether the real encoder helps needs a small labelled set of
  query → expected-note pairs over a real bible, and this repo has no fixture of that shape. The
  recorded-asset corpus in `@vn/testkit` is the nearest precedent for how to build one.
