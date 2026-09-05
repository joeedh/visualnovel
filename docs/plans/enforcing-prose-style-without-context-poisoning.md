# Enforcing prose style without context poisoning

Status: **planned**

## Context

[`../reference/proseStyle.md`](../reference/proseStyle.md) states the rules that govern
every comment and every page under `docs/`. Readers apply these rules inconsistently,
because an inverted clause or a metaphorical equation reads fine to the person who wrote
it, so a model that applies them systematically is worth having.

A model's output style is shaped by the prose it has just read, and that is what makes
this difficult. A reviser that reads a document written in the style being removed will
reproduce that style in its replacement. This plan treats that contamination as the
governing constraint.

The premise justifies exactly one thing: the tool builds a fresh `messages` array per
Markdown block. No call outlives one block, so contamination does not carry from one block
to the next. Everything else in this plan is either deterministic code or an option that
has to earn its place against a measurement. An earlier draft built three further
mechanisms on the premise (a sequential revised-neighbour context, a whole-document final
pass, and a schema-confined fact-checker), and a pressure-test found that the premise
justified none of the three. The findings are recorded at the end.

The tool is a deterministic loop that makes one plain `messages.create` call per block, so
it is a workflow rather than an agent. It needs no tool use, no memory and no agent loop,
so neither the Claude Agent SDK nor Managed Agents applies. It also cannot be a Claude
Code skill, because a skill is instructions loaded into the orchestrating model's context
and that model already holds the whole document. The isolation has to be structural. A
thin skill that wraps the script is added at the end.

### Relationship to `commentlint`

`pnpm lint:comments` already runs a model-backed prose checker over documentation rather
than only over code comments: [`../../.commentlintrc.json`](../../.commentlintrc.json)
carries a `markdownFiles` whitelist of six documents including `CLAUDE.md`, with
`disableRules: ["P10","P4"]`. Extending that whitelist is one line, and it is the cheaper
way to find a violation.

The two tools differ in what they produce. `commentlint` flags a line against a fixed rule
set and runs as part of `pnpm lint`, where it must be fast, deterministic enough to gate a
commit, and silent on prose that passes. This tool proposes a rewrite of a specific block
against proseStyle.md, costs money per run, and produces a diff a person reads. It is not
a lint step and will not become one.

Before writing any code, note that `commentlint .` excludes only `vendor/**`, so it will
begin scanning the comments in whatever this plan adds under `scripts/`.

## Decisions this plan settles

- **The unit of revision is a Markdown block, and the block taxonomy comes from a survey
  of `docs/**`, not from generic Markdown.\*\* Stage 3 states what that survey found.
- **Revising bad prose is worth more than leaving good prose alone.** The tool exists to
  catch violations, so missing one is the failure that matters; a needlessly rewritten
  paragraph costs a person only a moment in the diff. The output contract states this
  directly — revise when the call is close — and the two fixture sets in stage 2 are
  weighted accordingly: the violation set gates the plan, and the conformance set reports
  a number. Two consequences follow, and both are accounted for below. The diff a person
  reviews gets longer, and the fact-checker matters more, because each extra rewrite can
  introduce factual drift.
- **A revision call sees one block and nothing else by default.** The call receives no
  neighbouring context, structural or otherwise, until a fixture demonstrates that
  referents break without it. If a fixture demonstrates that, revised-neighbour context is
  preferred over the enclosing heading path, because a heading is unedited prose and a
  revised neighbour is not. Revised-neighbour context costs parallelism and defeats prompt
  caching for every call after the first, so it is not built on speculation.
- **There is no whole-document pass.** A whole-document pass has no stated job that a
  per-block pass does not do, its output-token ceiling is a real limit on this repo's
  longer pages (`docs/reference/command-system.md` is 991 lines), and its guard could not
  detect a dropped sentence. If cross-block flow turns out to need attention, a second
  per-block pass over revised neighbours addresses it with the same isolation and the same
  limited scope.
- No model call ever receives the original document as a whole. That invariant survives
  the removal of the final pass, and the code asserts it.
- **The fact-checker returns no model-authored text.** Its response schema is a verdict
  enum and integer character offsets into the revised block. This repo has no
  provider-side schema enforcement:
  [`../../packages/providers/src/structured.ts`](../../packages/providers/src/structured.ts)
  is `extractJson` plus zod over the result, which validates field shape and cannot stop a
  model putting quoted source prose inside a string field. The schema therefore gives the
  model no string field to leak through, and the caller drops anything unrecognised before
  the repair call.
- **The tool proposes and a person applies.** The script refuses to write over its input,
  for the same reason that
  [`../../scripts/audit-key-instructions.mjs`](../../scripts/audit-key-instructions.mjs)
  refuses to write `docs/guides/api-keys.md`.
- **Output goes outside `docs/`.** The revised file and the diff are written to a
  gitignored `.prosestyle/` directory at the repo root. A proposal landing under `docs/`
  would trip `pnpm check:doclinks` and the "every new `docs/` page is listed in
  `docs/index.md`" rule in
  [`../reference/conventions.md`](../reference/conventions.md#documentation).
- **The script prints a path rather than prose.** A unified diff contains the original
  text as well as the revision, so printing one to the terminal puts both into the calling
  agent's context and undoes the isolation at the last step. The script prints the output
  path, the block count, and how many blocks changed. The skill in stage 6 prints those
  same three values.
- **Re-wrapping is deterministic and happens per block.** A revised block is re-wrapped to
  the width its own original used, rather than to a repo-wide number. There is no such
  number, because `.prettierignore` excludes `docs/**` entirely, and
  docs/reference/desktop-app.md has lines running to 209 characters where a link target
  cannot be broken. An unchanged block is emitted byte for byte, so the diff a person
  reviews shows only real changes.
- **Each role uses a fixed model, and either the first-party API or OpenRouter can serve
  it.** Revision uses `claude-opus-5` with adaptive thinking. The fact-checker and the
  stage 2 judge use `claude-sonnet-5`, and both compare two short texts and emit a fixed
  shape. Model routing is specified below.
- **Scope is one file per invocation, from an allow-list.** The allow-list covers
  `docs/**` excluding `docs/plans/archive/**`, plus `CLAUDE.md`. The tool never revises
  `todos.md`, which [`../reference/conventions.md`](../reference/conventions.md#plans)
  protects as hand-written shorthand that must not be reformatted, and it never revises a
  generated file.

### Where the logic lives, and why the precedent does not cover it

The logic goes in `scripts/prosestyle/**.ts`, outside the package layering graph. This is
repository tooling rather than product code, and a new `@vn/` package would have to earn a
place in the boundaries graph for no benefit.

This approach departs from `audit-key-instructions.mjs`, and the plan should not claim
otherwise. That script keeps its tested logic in `apps/desktop/src/main/keyaudit.ts`
(inside an app that is already typechecked and tested), which is exactly why it needed no
configuration changes. There is no equivalent location for docs tooling; putting a
Markdown splitter in the desktop app to inherit its jest project would be worse than
paying for a new one. The cost is five edits, not the two an earlier draft claimed:

1. `scripts/**/*.ts` joins `include` in [`../../tsconfig.json`](../../tsconfig.json),
   whose current value covers only `packages/*/src`, `apps/*/src` and `plugins/*`.
2.  2. A jest project in [`../../jest.config.cjs`](../../jest.config.cjs) matching
       `**/scripts/**/tests/*.test.ts` and spreading `shared`. The spread is what applies
       the esbuild transform and the `.js`-extension stripping in `moduleNameMapper`; a
       project that omits it runs no tests.
3. `scripts/**/*.ts` needs its own `@typescript-eslint/no-unused-vars` override. The
   `argsIgnorePattern: '^_'` relaxation in
   [`../../eslint.config.mjs`](../../eslint.config.mjs) sits inside a block scoped to
   `packages/**` and `apps/**`, so a `_unused` parameter would be an error under
   `scripts/` and nowhere else in the repo.
4.  4. Adds a `prose:style` script to the root `package.json` and a row to `CLAUDE.md`'s
       command table.
5. `.prosestyle/` is listed in `.gitignore`.

The boundaries rules need no change: `eslint-plugin-boundaries` is scoped to
`packages/**/*.ts` and `apps/**/*.ts`, so nothing under `scripts/` is classified or
rejected.

`scripts/prose-style.mjs` is the entry point, and it loads the logic by bundling
`scripts/prosestyle/main.ts` to a temporary CJS file with esbuild and requiring it, the
way `audit-key-instructions.mjs` does. The temporary file goes in the same directory
`audit-key-instructions.mjs` uses rather than at the repo root, because
`@anthropic-ai/sdk` is listed in `EXTERNAL` in
[`../../scripts/aliases.mjs`](../../scripts/aliases.mjs) and must resolve from a directory
where pnpm's isolated layout has actually installed it.

### Model routing and keys

The three model roles are each declared as a constant at the top of
`scripts/prosestyle/main.ts`, and each holds a `<route>/<model>` string:

```ts
const REVISE_MODEL = "anthropic/claude-opus-5";
const CHECK_MODEL = "anthropic/claude-sonnet-5";
const JUDGE_MODEL = "anthropic/claude-sonnet-5";
```

There are two routes, and the route is the part before the first slash only. OpenRouter's
own model ids contain slashes, so `openrouter/anthropic/claude-opus-4.6` has to parse as
the `openrouter` route carrying the model `anthropic/claude-opus-4.6`. Splitting on every
slash breaks the case this feature exists for.

- **`anthropic/<model>`** — calls the first-party API. Reads the key from
  `ANTHROPIC_API_KEY`, falling back to `claude.txt` or `anthropic.txt` in the `keys/`
  directories that `secretDirsFor(repoRoot)` names.
- **`openrouter/<model>`** — OpenRouter's Anthropic-shaped endpoint, reached by giving the
  same `@anthropic-ai/sdk` client a `baseURL` override, so there is one request builder
  rather than two. The key comes from `OPENROUTER_API_KEY`, falling back to
  `keys/openrouter.txt`, which is present at this repo root today.

The exact base URL is left to the implementation, which should confirm it against
OpenRouter's current documentation rather than record it here from memory. Verify that
`new Anthropic({ baseURL, apiKey })` works with a base URL the SDK appends `/v1/messages`
to. A plan that hardcodes a guessed path produces a script that fails at the first call,
and the cause is hard to find.

The script does not go through `resolveKeys`, which takes a `ProjectConfig` and reads
env-var names out of a project's `project.yaml` — this repo root has none, so `loadConfig`
has nothing to load. `audit-key-instructions.mjs` reads `process.env` directly for the
same reason. The script also defines its own filename map: `KEY_VENDORS` and
`SECRET_FILES` in [`../../packages/config/src/keys.ts`](../../packages/config/src/keys.ts)
cover `gemini` and `anthropic` only, and `openrouter` is not a `ChatVendor`. Adding
`openrouter` to product code to serve a docs script would be a disproportionate change.

The OpenRouter route has three consequences, and the code must handle each one rather than
discover it:

- **Adaptive thinking and `output_config.effort` go only on the `anthropic` route.** They
  are first-party request fields, and a non-Anthropic model behind OpenRouter will reject
  or ignore them. The OpenRouter route sends a plain request.
- **Prompt caching assumes the first-party route.** The `cache_control` breakpoint on the
  system prompt, and the cost estimate below that depends on it, apply to the direct
  route. The first OpenRouter run should check `usage` to learn whether a cache read gets
  through the broker, rather than assuming an answer.
- **It sends repository documentation to a third party.** That is a different
  data-handling decision from calling Anthropic directly, and this repo has already
  written the tradeoff up once in
  [`../research/openrouter-vs-direct-image-api-privacy.md`](../research/openrouter-vs-direct-image-api-privacy.md).
  The default stays `anthropic/`. Using OpenRouter requires editing the constant.

## Stage 1 — repairing `proseStyle.md`

`proseStyle.md` sits in the system prompt of every call the tool makes, so its defects
propagate. That is a reason to fix it, but it does not justify this stage. An earlier
draft proposed restructuring every rule into `Avoid:` / `Write:` pairs so the conforming
version always came last, on the theory that a rule ending on the pattern it forbids
leaves that pattern most recently read. The effect is asserted, the rules file sits in the
system prompt rather than adjacent to generation, and nothing in this plan can measure the
change in isolation. The restructuring is dropped. What remains are defects that stand on
their own merits as an ordinary documentation fix, and this stage is no longer a
dependency of the stages below.

Rules are cited by name. The file has uncommitted working-tree changes, so line numbers
would be wrong by the time anyone acts on the citations.

- **Add the missing rewrites.** _Double negatives_ quotes "the palette cannot be relied on
  not to" and tells the reader to state the positive claim without stating it. _Pronouns
  and ellipses that point outside the sentence_ quotes two bad fragments and supplies no
  rewrite. Both rules end on an instruction rather than on an example. That defect is
  smaller than an earlier draft of this plan claimed, but a reader still finishes the rule
  without the answer.
- **Give _inverted syntax and personification_ its own example.** The bullet has none. A
  personification example with a conforming rewrite appears immediately above it, in the
  jargon-substitute bullet ("wanted" → "requested"), so the defect is placement rather
  than absence. A reader scanning for the rule finds a bare assertion.
- **Fix the one rule that ends on the forbidden construction.** _Non-assertive words under
  a definite_ closes on the clause "the next pointerdown anywhere" does not. Two rules an
  earlier draft praised have the same shape: _fragment openers_ ends on two bad examples,
  and _a head noun that is not what the thing is_ ends on quoted bad forms. That shared
  shape shows the ordering criterion was not doing real work. Fix the rule that leaves the
  construction dangling without a rewrite in the bullet, and leave the other two, whose
  rewrites are present and adjacent.
- **Balance the metaphorical equations bullet.** The bullet gives three bad examples and
  one rewrite. Add rewrites for the other two.
- **Trailing whitespace** on four lines within the uncommitted jargon bullets.

The casing and punctuation of the _Quote Ambiguous Jargon Words_ label, and the trailing
whitespace, are all inside an uncommitted edit. Raise them with the author rather than
fixing them in this plan, since the edit may still be in progress and a plan must not
quietly rewrite work in flight.

## Stage 2 — the fixtures

The acceptance test for the design was built before any plumbing. It has three sets, and
they do not carry equal weight.

**The violation set decides whether the prompt works.** It holds thirty blocks drawn from
`docs/` and from this repository's history, each carrying a known violation and each
tagged with the rule it breaks. The measurement is recall: how many violations the reviser
removes. An earlier draft of this plan did not have this set at all and measured only that
conforming prose survived, which is the property that matters less.

Grading it is harder than grading the conformance set, because a violation has many valid
repairs and byte-equality cannot decide which repair is correct. Three options follow, in
the order they should be tried:

- **A targeted assertion** applies where the violation is a construction that can be
  matched — a double negative, a `, else` clause, bold inside a sentence. Such an
  assertion is cheap and exact, and it covers perhaps half the rules.
- **A judge call** names the rule and asks whether the construction is still present in
  the revision. Each fixture costs one call, and the judge is a model grading a model, so
  the judge needs its own small validation: run the judge against the unrevised fixtures
  and confirm it finds the violation it was told about.
- **A hand-written expected output** applies only where neither of the others works. It is
  brittle, because it fixes one wording out of many correct ones.

**The conformance set reports a number and does not gate anything.** Twenty blocks are
certified as already conforming. Each rewrite of one is reported as churn, and churn is a
cost to watch rather than a failure. The author certifies these blocks by judgement, and
disagreement is itself a finding: if a person calls a block conforming and the model
rewrites it, either the block has a defect or the file states a rule badly. The
circularity is real, and recording the judgement in the fixture file resolves it rather
than pretending a neutral source exists.

The context set holds five blocks whose referents genuinely depend on their neighbours,
each expected to be revised wrongly when sent alone. The outcome on these five blocks
settles whether any neighbour context gets built. If the reviser handles them unaided, the
sequential loop is never written.

The prompt under test is `proseStyle.md` verbatim as the system prompt, plus an output
contract. The contract asks for the revised block and nothing else, and states that a
revision should be made when the call is close.

Each fixture costs a model call (more where the judge is used), so this runs as a
`--fixtures` mode on the script rather than in `pnpm test`. Nothing mechanical stops
stages 3 to 6 from proceeding past a failure, so the gate is a decision recorded here. If
the violation set's recall is poor, the prompt is wrong and the rest of the plan is not
worth building. A high churn number on the conformance set is a reason to tune the
contract, not a reason to stop.

### What the first run found

The run was on 2026-09-05. `anthropic/claude-opus-5` revised and
`anthropic/claude-sonnet-5` judged.

- **Recall read 71%, and the number is unreliable.** All twelve assertion-graded fixtures
  passed. Every failure was judge-graded.
- The judge reports a violation in 52% of conforming blocks, against 84% sensitivity on
  unrevised ones. On judged rules the judge performs barely better than chance, so a
  perfect reviser would score around 48% and the recall figure measures the judge rather
  than the prompt. `--audit-judge` produced both numbers, and it should have run first.
- **Inspection confirms the judge produces the false positives.** The revision of the
  backticks fixture correctly removed the backticks and was still scored as violating. The
  unquoted-jargon revision correctly quoted and glossed the term and was scored the same
  way.
- **Four fixtures were miscategorised, and the mistake is instructive.** The
  dangling-pronoun and adverb fixtures ("the second case", "the handler above", "the other
  two") point to referents outside the block, so no reviser can repair them from the block
  alone. They belong in the context set but carry violation-set labels, and they are
  evidence for the stage 2 context question rather than against the prompt.

### Fixing the judge

The yes/no judge was replaced by one that must quote the offending words. A verdict counts
only when the quoted span appears in the passage. `spanSupported` performs that check and
is unit-tested. An answer of NONE, an empty answer, and a quotation the passage does not
carry each count as no violation, because the judge has not shown the construction it
reports.

Measurement takes three steps, and each step is an `--audit-judge` run:

| judge prompt                                     | finds violations | false positives |
| ------------------------------------------------ | ---------------- | --------------- |
| yes/no                                           | 84%              | 52%             |
| quote the span, "reply NONE when unsure"         | 53%              | 1%              |
| quote the span, borderline instances still count | 58%              | 3%              |
| the above, with concrete rule descriptions       | 84%              | 2%              |

The first change fixed the false positives and cost most of the sensitivity. Loosening the
caution clause recovered almost none of it. The fault lay in the rule descriptions, which
were too abstract to recognise an instance by. Giving four of them a concrete example
(drawn from `proseStyle.md`'s own illustrations rather than from the fixtures) restored
sensitivity in full while keeping the false-positive rate at 2%.

The lesson applies beyond this tool. A judge asked whether prose contains a fuzzy
construction answers yes to almost anything. A judge asked to point at the construction
must name a location, and that location can be checked without a model.

### Three revisers, measured the same way

The same 30 fixtures and the same prompt were judged at 76% sensitivity and 2% false
positives.

| reviser                         | recall | churn |
| ------------------------------- | ------ | ----- |
| `anthropic/claude-opus-5`       | 93%    | 50%   |
| `anthropic/claude-sonnet-5`     | 83%    | 30%   |
| `openrouter/z-ai/glm-5.3-flash` | 100%   | 50%   |

- **All three fix every assertion-covered violation.** Each one fixes twelve of twelve.
  The rules a regular expression can find are also the rules every model handles, so the
  assertions measure the floor rather than the differences between the models.
- **Personification survives revision most often.** Both of Opus's failures and three of
  Sonnet's five break that one rule. The pattern indicates a problem with the rule and the
  prompt rather than with the models: the reviser reliably replaces "remembers" with
  "stores" and then leaves "requires" or "decides" alone, because the rule as stated does
  not say where standard engineering usage ends.
- The cheap third-party model scored highest on recall and had half the churn discipline.
  Under the stated priority, recall is the number that counts. The result is uncomfortable
  and is worth re-testing on a larger violation set before anything is decided on it.
- Every recall figure overstates the real rate, because the judge misses roughly a quarter
  of real violations. The ordering between the three figures is more trustworthy than the
  absolute numbers.
- **The OpenRouter route works.** These runs confirm `https://openrouter.ai/api` with the
  SDK appending `/v1/messages`, so `model.ts` no longer carries an unverified base URL.

That leaves the gate as follows:

- **Passes, with the accuracy of the instrument stated.** Recall runs between 83% and 100%
  against a judge at 76%/2%, and every assertion-covered rule scores 100%. Stages 3 to 6
  are worth building.
- **Assertions are worth more than the plan assumed.** They scored twelve for twelve for
  every model at no cost per run, and a self-test caught two mis-written patterns before
  any money was spent. Widening assertion coverage beats improving the judge wherever a
  construction can be matched.
- **The personification rule needs work before the tool ships.** No reviser applies it
  reliably, and the cause is in proseStyle.md rather than in the prompt. The rule does not
  say that ordinary engineering usage ("requires", "returns", "holds") is exempt. Fixing
  it belongs with the stage 1 repairs.

## Stage 3 — the splitter and the reassembler

`scripts/prosestyle/` holds pure functions, with `tests/` siblings and no model. The case
list below comes from a pass over `docs/**` rather than from a generic Markdown checklist,
and the earlier draft's list was wrong in both directions.

Passes through untouched:

- **Fenced code blocks**, including fences indented inside a list item.
  `docs/guides/debugGuide.md` has several. A list item that contains a fence splits into
  prose parts and a fence part, which breaks the naive rule that a list item plus its
  continuation lines is one block.
- **Generated tables of contents.** 78 files carry a `<!-- toc -->` … `<!-- tocstop -->`
  pair. The bullet list between the markers is a bullet list, so a splitter that only
  passes through HTML comments will hand it to a reviser and break `pnpm markdown-toc` and
  `pnpm check:doclinks`.
- **Tables.** `docs/plans/index.md` is a forty-row table. A consequence worth stating: on
  that file the tool would do almost nothing, which is correct behaviour and also a sign
  that this tool is not the right one for index pages.
- **Headings.** The prose rules do apply to a heading, but rewriting one breaks every
  `#anchor` link across `docs/` and `CLAUDE.md`, and `pnpm check:doclinks` runs inside
  `pnpm lint`, so the failure surfaces far from its cause. Headings pass through, and
  changing one stays a human act.
- **Checkbox list items.** `docs/plans/desktop-editors-tracking.md` and the tracker files.
  The marker is state, not prose.
- **HTML comments** and **link-only lines**.

Handled as prose: paragraphs, list items (minus any fence they contain), and blockquotes,
which appear in ten or more files and the earlier draft omitted entirely.

Dropped from the earlier draft: **YAML front matter** and **link-reference definitions**
occur nowhere under `docs/`, and a link-reference detector would misfire on the
hand-written `[ ]:` todo shorthand in
`docs/plans/provider-credentials-and-the-ai-usage-ledger.md`.

The functions:

- `splitBlocks(markdown)` → blocks with byte offsets and a kind.
- `reassemble(source, revisions)` → splices revisions back at the recorded offsets.
- `rewrap(text, indent, width)` → re-wraps to the width the block's original used, never
  breaking a line with no break opportunity, never touching a table row.
- `structure(markdown)` → the counts the stage 4 guard compares.

**The round-trip test runs over every file in `docs/**`,\*\* not over a fixture: splitting
a file and reassembling it with every revision equal to its original reproduces the file
byte for byte. A corpus this size will find the cases a hand-written fixture set does not.

### As built

- **Blocks tile the document.** Every line belongs to exactly one block, blank runs
  included, and reassembly concatenates them. Byte-exact round-trip therefore holds
  whatever the grouping, which makes a grouping mistake cost revision quality and never
  content. This was not in the plan and is the decision that makes the round-trip test
  cheap to satisfy.
- **A nested bullet is its own block.** The first implementation kept a sub-list with its
  parent item, which collapsed the whole of `proseStyle.md`'s rule list into one block —
  the file states one rule per nested bullet, and a reviser handed all of them at once is
  being handed a document. Any list marker now opens a block whatever its indent.
- **The trailing newline comes from the original block, not from the model's output.** It
  is structural under tiling, and taking it from the revision ran blocks together.
- The corpus round-trip, the nested-bullet granularity, and both of those fixes are
  covered by tests in `scripts/prosestyle/tests/split.test.ts`.

## Stage 4 — the script

`scripts/prose-style.mjs`, taking one input path from the allow-list.

- Split, then revise each prose block. Each call gets a fresh `messages` array: system is
  `proseStyle.md` plus the output contract, user message is the block. Calls run in
  parallel, since nothing carries between them.
- Reassemble, re-wrapping only blocks whose text changed.
- **The guard** compares `structure()` before and after: block count, bullet count, table
  rows, checkbox states, heading count, fenced-block count and total length. These are
  what this repo's documentation is actually made of; the earlier draft compared headings,
  fences and link targets, which are precisely the things the splitter already passes
  through, so it policed a class of change that could not occur. A guard failure aborts
  with a non-zero exit and writes nothing — the run is cheap to repeat and a partial write
  is not.
- Write the revised file and the diff to `.prosestyle/`. Print the path, the block count,
  and how many blocks changed.

### As built

The allow-list is `allowsRewrite`, with tests: `CLAUDE.md` and `docs/**.md`, minus
`docs/plans/archive/**` (history rather than prose to improve), `todos.md`, and the two
generated command tables. The diff comes from `git diff --no-index` rather than a
hand-written differ.

First run on `docs/guides/testkit.md` — 35 blocks, 15 prose, **15 changed**:

- **The wrap width was read wrongly and is fixed.** `wrapWidth` took the longest prose
  line in the document, and that file carries a 125-character line holding a link that
  cannot be broken, so every revised paragraph was re-wrapped to 125 columns. It now reads
  only the lines the author actually broke — every line of a prose block except its last —
  because a final line stops where the text ran out and an unbreakable line exceeds the
  width by necessity. Both cases are tested.
- **Every prose block changed.** That is the churn cost arriving in full: this
  repository's documentation is written in the voice the rules now forbid, so under a
  contract that says revise when the call is close, a real page comes back rewritten
  throughout. The revisions themselves are right — the opening fragment becomes a
  sentence, the rhetorical bold goes, an unquoted "pure" gains its gloss — but a reviewer
  of that page is reading a rewrite rather than a patch. Nothing here is a defect; it is
  the tradeoff the stated priority buys, and the number to watch when the tool is used in
  earnest.
- **The structural guard passed and the refusals fire.** Pointing the tool at `todos.md`
  or at an archived plan is declined by name.

## Stage 5 — the fact-checker

A separate process, the only component that reads the original. It carries more weight
than its position suggests: a reviser told to revise when the call is close rewrites more,
and every rewrite is an opportunity to change what a sentence claims. This is the check on
the cost of that priority, so it is not optional and it runs over every block, not only
over the ones a person finds suspicious.

- Input: pairs of original and revised block.
- Output: for each pair, a verdict enum (`unchanged` / `equivalent` / `drifted` /
  `unverifiable`) and, for `drifted`, integer character offsets into the revised block. No
  string fields. Anything the model returns outside that shape is dropped rather than
  parsed.
- A `drifted` finding is repaired by a fresh revision call over the revised block plus the
  offsets. The checker's own output never reaches a reviser as text, because there is no
  text.
- It reports and does not edit, so a run finding nothing costs nobody anything to clear.

### As built

The model quotes the drifted words, `locateSpan` converts the quotation to offsets into
the revised block, and the string is dropped, so the finding carries a verdict and two
integers and no model-authored text. A quotation the revision does not carry reads as
`unverifiable` rather than as drift, which surfaces a checker that is guessing instead of
believing it.

First run over `docs/guides/testkit.md`: 14 equivalent, 1 drifted, 0 unverifiable. The one
finding is real and correctly located — `"would just be noise"` became
`"would add noise"`, which is a mild change of claim — and the checker passed over the
removed bold and the newly quoted "pure", which are style rather than meaning. It is a
strict reader, and at this cost that is the right setting.

## Stage 6 — the wrapper and the documentation

- A `prose-style` skill that runs the script and reports the output path and the counts.
  It holds no rules of its own; a rule stated in the skill is a rule the isolated calls
  never see. It does not print the diff, for the reason given under Decisions.
- The `pnpm prose:style` entry and the `CLAUDE.md` command-table row from the config list
  above.
- A short section in [`../reference/proseStyle.md`](../reference/proseStyle.md) saying the
  tool exists, that its output is a proposal, and how it divides from `commentlint`.

## What it costs to run

Estimated before building, and worth checking against the first real run.

- `proseStyle.md` is roughly 1.2K tokens and is identical across every call, so it caches
  — but the minimum cacheable prefix is model-dependent and can exceed that, so the first
  run should check `usage.cache_read_input_tokens` rather than assume the discount. This
  is one of the arguments against neighbour context: it sits after the cacheable prefix
  and changes every call, which would defeat caching for the whole run.
- A large page is the cost driver. `docs/reference/command-system.md` at 991 lines is on
  the order of 200 prose blocks, so roughly 200 revision calls plus 200 fact-check calls.
- At Opus 5 rates with a cached system prefix, a page that size is cents rather than
  dollars per run, and the fixture suite is a few dozen calls. Nothing here justifies a
  budget mechanism, but the numbers belong in the plan rather than in someone's head.
- The cost that is not money is the diff. Prioritising recall means more blocks change,
  and a long diff is one a reviewer skims. Two things hold against it: an unchanged block
  is emitted byte for byte so nothing cosmetic pads the diff, and the conformance set's
  churn number in stage 2 says how bad the problem is before anyone meets it on a real
  page. If churn turns out to make diffs unreviewable, the answer is to tune the output
  contract, not to re-order the priority.

## What it costs to undo

- Stage 1 edits one documentation file and reverts normally. It no longer restructures
  that file, which was the genuinely expensive part of the earlier draft — `proseStyle.md`
  is read by every human and every agent in this repo, and reshaping it to suit a tool's
  prompt would have been a cost paid by every reader for an unmeasured benefit.
- Everything else is new files under `scripts/prosestyle/`, one script, one skill
  directory, and the five configuration edits listed above. Reverting means deleting them.
- No adoption sweep is proposed, so nothing has to be un-swept. Running the tool across 78
  documents would need an ordering and a per-file record of what has been passed, and
  neither exists; that is a separate decision, taken after the tool has been used on a
  handful of pages by hand.

## Out of scope

- Any check in CI, and any place in `pnpm lint`. This is advisory tooling a person invokes
  and reviews.
- A sweep across `docs/`. One file per invocation.
- Code comments. `commentlint` covers those, and a comment's surrounding code is context
  this splitter does not model.

## Pressure-test findings

Reviewed by a fresh-context agent against the repository. Sixteen findings; the ones that
changed the design are recorded above in the sections they changed. What follows is what
was rejected or qualified, so the next reader does not re-raise it.

- **The precedent should be followed by putting the logic in an existing package or app.**
  Rejected. The criticism is correct — `audit-key-instructions.mjs` needed no
  configuration because its logic lives in an already-tested app — but the remedy would
  put a Markdown splitter in the desktop app to borrow its jest project. The plan now pays
  the five config edits and stops citing the precedent as support for `scripts/`.
- **Replace revised-neighbour context with deterministic structural context — the heading
  path and parent bullet.** Rejected as stated: a heading and a parent bullet are unedited
  prose, which is the exposure the whole design exists to bound. The finding's real point
  stands, that sequencing buys referent resolution rather than isolation and contradicts
  the plan's own claim that blocks are largely self-contained. Resolved by building no
  context at all until the stage 2 fixtures show it is needed.
- **Derive the tool's prompt file mechanically from `proseStyle.md` with examples
  reordered.** Rejected. Mechanical reordering of prose examples is unspecified and adds a
  build step and a second file to keep in sync. The underlying point — that the tool's
  needs should not distort the document people read — is accepted, and the restructuring
  is dropped instead.
- **`commentlint`'s markdown whitelist is one line to extend, so this tool may be
  redundant.** Qualified. The contradiction in the earlier draft was real and is fixed;
  the conclusion is not. `commentlint` flags and this proposes rewrites, which is now
  stated in Context.
- **The four-rule audit of `proseStyle.md` was partly wrong.** Accepted in full. _Inverted
  syntax_ has an adjacent example, so the defect is placement; _double negatives_ and
  _pronouns and ellipses_ end on an instruction rather than on the forbidden pattern, so
  the headline overstated what was verified; the ordering criterion also condemned two
  rules the draft held up as models, which is why the criterion was dropped; trailing
  whitespace is on four lines, not two; and the whole passage cited is uncommitted, so the
  plan now cites rules by name.
