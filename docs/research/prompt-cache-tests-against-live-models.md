# Prompt-cache tests against live models

_Research, internal. The question is what it would take to verify prompt caching against
the real APIs, on approval only, outside `pnpm test`, with one check per supported model,
for both the authoring agent and the report analyst. The document answers that question
and weighs the cost against what the repo already has._

_Status: research. Nothing here is implemented. Every claim about this repo cites a file,
and those files were read on 22 August 2026. Vendor prices, per-model cache minimums and
the tokenizer note come from the Anthropic pricing page and the Google pricing pages
fetched the same day. Two recorded runs in the repo's own script corroborate the Gemini
implicit-cache behaviour._

<!-- toc -->

- [The short answer](#the-short-answer)
- [What already exists](#what-already-exists)
    - [The offline half is built](#the-offline-half-is-built)
    - [The live half is built, for one model at a time](#the-live-half-is-built-for-one-model-at-a-time)
- [What a test can actually observe](#what-a-test-can-actually-observe)
- [One test for every supported model](#one-test-for-every-supported-model)
    - [Where the list lives](#where-the-list-lives)
    - [The minimum cacheable prefix, and the tokenizer split](#the-minimum-cacheable-prefix-and-the-tokenizer-split)
    - [Two backends, not one](#two-backends-not-one)
    - [The matrix I would build](#the-matrix-i-would-build)
- [The two agents have different shapes](#the-two-agents-have-different-shapes)
- [The approval gate](#the-approval-gate)
    - [Why not a jest project](#why-not-a-jest-project)
    - [What the gate should be](#what-the-gate-should-be)
- [What a run costs](#what-a-run-costs)
- [Flakiness, the TTL, and a latent bug in the current script](#flakiness-the-ttl-and-a-latent-bug-in-the-current-script)
- [Keys, logs, and what a failure is allowed to print](#keys-logs-and-what-a-failure-is-allowed-to-print)
- [What I would build, in order](#what-i-would-build-in-order)
- [Is it worth it](#is-it-worth-it)

<!-- tocstop -->

## The short answer

Build it as an extension of `scripts/verify-prompt-cache.mjs`, not as a jest suite.

The todo asks for tests that run only on approval, sit outside `pnpm test`, use real keys,
and cover every supported model. Three of those four constraints are already satisfied by
a script that exists and works. The fourth (one check per model) is roughly thirty lines
of argument parsing plus a per-model prefix size. Choosing jest instead would mean
defeating a guardrail that `scripts/jest-setup.cjs` exists specifically to enforce, adding
a project that `.github/workflows/ci.yml` would then run on a keyless runner, and forcing
`maxWorkers: 1` because parallel probes against one model cannot hit each other's cache.

The other conclusion is about value. The half that catches real regressions (whether the
breakpoints landed in the right places, whether the prefix stayed byte-identical between
turns) is already covered offline by seventeen assertions in
`packages/providers/src/backends/tests/convo-request.test.ts` and by
`packages/authoring/src/tests/loop.test.ts`. The live half catches exactly one class of
defect the offline half cannot: a change made by the vendor. The live half is worth
running once per model when a model id is added or the request shape is edited, and it is
not worth a standing suite. Cost is not the reason, since a full pass over all six models
is about twenty cents.

## What already exists

### The offline half is built

Every caching claim about the request we send is already asserted without a key:

| File                                                          | What it pins                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/providers/src/backends/tests/convo-request.test.ts` | Seventeen tests: breakpoints at the end of the tool catalog and the end of the system prompt, omitted when there is nothing to cache, never on a thinking block, only the newest two message marks so four is never exceeded, the caller's own blocks left unmarked so the next step echoes the same bytes, the search tool prepended only when something defers, and the `system`-role down-render for a model without the role. |
| `packages/authoring/src/tests/loop.test.ts`                   | `is byte-identical between turns, including after a mode change` (line 1064), plus the mode warning arriving as a system message rather than an edited prefix (line 1150).                                                                                                                                                                                                                                                        |
| `packages/authoring/src/tests/backend.test.ts`                | The `NativeAgentBackend` block (lines 43–176), including the rolling breakpoint and the cleared-conversation case at line 171.                                                                                                                                                                                                                                                                                                    |
| `packages/authoring/src/tests/context.test.ts`                | Line 170: the first segment of the byte-stable cached prefix cannot be quietly trimmed.                                                                                                                                                                                                                                                                                                                                           |
| `packages/agentreport/src/tests/analyze.test.ts`              | A fake `chatConversation` at line 49, so the analyst's native path is exercised offline.                                                                                                                                                                                                                                                                                                                                          |

`buildConvoRequest` in `packages/providers/src/backends/convo-request.ts` is pure and
exported, so it can be tested directly. The purity is a deliberate design choice, and it
is the reason the expensive half has little left to do.

### The live half is built, for one model at a time

`scripts/verify-prompt-cache.mjs` already does what the todo describes, for whichever
model `config.models.text` names:

- It bundles `loadConfig`, `resolveKeys`, `secretDirsFor`, `createAnthropicChat`,
  `createGeminiChat` and `NativeAgentBackend` through esbuild into a temporary CJS entry
  and removes it in a `finally`.
- For Claude, the test runs two steps of one conversation through `NativeAgentBackend` and
  asserts that step 1 reported `cacheWrite > 0` and step 2 reported `cacheRead > 0` (lines
  129–148).
- The Gemini case makes five calls carrying a byte-identical prefix, then asserts that
  some call reported `cacheRead > 0` and that the hit was marked `cacheEstimated` (lines
  192–206).
- It dispatches on a prefix match against `config.models.text` and prints `SKIP` for
  anything else (lines 222–231).
- Its absence from `package.json`'s scripts is deliberate, and its own header states this
  (lines 21–24).

It does not iterate models, and its Claude prefix is sized for a 1024-token minimum
(`fixedPrefix(12)`, roughly 1.5k tokens) which is below what Haiku 4.5 requires.

## What a test can actually observe

A cache hit is visible only in the vendor's reply, and the two vendors report it
differently. What an assertion may claim therefore depends on which vendor replied.

Anthropic reports cache token counts as billed line items. `usageOf` in
`packages/providers/src/backends/anthropic.ts` reads `cache_read_input_tokens` and
`cache_creation_input_tokens` and maps them to `TokenUsage.cacheRead` and
`TokenUsage.cacheWrite`. Both are charged line items, so both counts are exact and both
can be asserted on: the first call records a write, and the second records a read.
`TokenUsage`'s own doc comment in `packages/providers/src/backend.ts` states the rule that
matters here: an absent field means the vendor said nothing, which is not the same as
zero. Every assertion is therefore written against `(usage?.cacheRead ?? 0) > 0` rather
than against equality with a number.

Gemini reports a matched prefix. `usageOf` in `packages/providers/src/backends/gemini.ts`
reads `cachedContentTokenCount` into `cacheRead` and always sets `cacheEstimated: true`.
There is no cache-write counterpart, nothing to place, and no guarantee the field appears
on a call that did hit the cache. The script's own header records two runs on 2026-08-18
over a byte-identical 3.4k-token prefix: one reported nothing on calls 1–2 and 88% on
calls 3–5, the other reported nothing except on call 4. So the only honest Gemini
assertion is that some call out of N reported a cached count, and that the count arrived
marked as an estimate.

A test must not treat silence as a miss when a vendor reports nothing at all. This is the
same finding as
[`tracking-cache-misses-in-transcripts.md`](tracking-cache-misses-in-transcripts.md),
which recommends declaring the capability on the backend
(`cacheReporting: 'billed' | 'estimated'`) rather than inferring it from a receipt's
shape, because a hardcoded `cached_tokens: 0` from a local runtime is byte-identical to an
honest miss. A live suite should read that declaration and choose its assertion from it. A
`billed` backend gets an unqualified pass/fail, an `estimated` backend gets a
some-call-out-of-N assertion, and a backend that declares nothing gets a skip that names
the reason. That declaration is not implemented yet. It is stage 1 of
[`../plans/recording-cache-misses-in-a-thread.md`](../plans/recording-cache-misses-in-a-thread.md),
which is planned rather than shipped, so until it lands the suite dispatches on vendor the
way the script does today.

## One test for every supported model

### Where the list lives

`TEXT_MODELS` in `packages/types/src/textmodels.ts` is the curated list the `/model` menu
and the convo pane offer. It holds six ids: `claude-opus-4-8`, `claude-sonnet-4-6`,
`claude-haiku-4-5`, `claude-fable-5`, `gemini-2.5-pro`, `gemini-2.5-flash`. Its comment
notes that any id also works, so the list is what the app offers rather than what it
accepts. That is the right scope for a verification matrix, and an author who types an
unlisted id is on their own.

`chatVendorFor` in `packages/providers/src/factory.ts` decides the vendor for an id. It
lowercases the id and matches the prefix `claude` or `anthropic`. Every other id falls
back to Gemini.

### The minimum cacheable prefix, and the tokenizer split

Anthropic's per-model minimum cacheable prefix is not monotonic across generations, and
the four curated Claude models use three different values:

| Model               | Minimum prefix | Tokenizer                                         |
| ------------------- | -------------: | ------------------------------------------------- |
| `claude-fable-5`    |     512 tokens | current (about 30% more tokens for the same text) |
| `claude-opus-4-8`   |    1024 tokens | current                                           |
| `claude-sonnet-4-6` |    1024 tokens | previous                                          |
| `claude-haiku-4-5`  |    4096 tokens | previous                                          |

Below the minimum nothing is cached and no error is raised, so an undersized probe fails
an assertion, and that failure looks like a broken implementation. Haiku 4.5 is the
binding constraint: it needs the largest prefix and counts the same text with the older,
coarser tokenizer, so it needs more characters than anything else in the matrix. Sizing
the shared padding against Haiku 4.5 (roughly 20,000 characters, about 5,000 tokens on the
previous tokenizer and about 6,500 on the current one) clears every Claude entry with
margin, at a cost measured in fractions of a cent.

The alternative is a per-model prefix size. It is more code and buys nothing, because the
padding is free relative to the write premium, and a single oversized prefix removes a
whole class of "why did this model fail" questions.

Gemini's implicit cache has its own minimum request size. That minimum is 1024 tokens for
2.5 Flash and 2048 for 2.5 Pro. The script's `fixedPrefix(40)` comes to roughly 3.4k
tokens and clears both.

Skip a model that has no prompt caching rather than failing it, and name the model and the
reason in the skip. Every entry in `TEXT_MODELS` supports caching today, so the branch is
currently unreachable. That is why the capability should be read from the backend as a
declaration rather than assumed in the matrix.

### Two backends, not one

Only `packages/providers/src/backends/anthropic.ts` implements `chatConversation` (line
190). The Gemini backend implements `message`, `messageWithUsage` and `chatWithTools`, and
no conversation method. Both hosts probe for `chatConversation` the same way:

- apps/authoring/src/agent.ts:98-99 —
  `if (!opts.noNative && chat.chatConversation) return new NativeAgentBackend(chat); return new StructuredAgentBackend(chat);`
- `apps/desktop/src/main/session.ts:904` contains the same ternary.
- packages/agentreport/src/analyze.ts:311-313 — uses the same ternary, with
  `deferTools: false`.

On the two Gemini models both agents run `StructuredAgentBackend`, which re-renders the
whole transcript into one prompt each turn. There are no breakpoints to place and no `raw`
blocks to echo. That prompt is still a growing byte-stable prefix
(`['TOOLS:', renderTools(tools), '', PROTOCOL, '', 'TRANSCRIPT:', renderTranscript(messages), …]`),
so Gemini's implicit cache can still match it, and a probe should verify that the prefix
did not change between turns. That assertion differs from the Claude assertion, so it
needs its own probe shape.

### The matrix I would build

Six model probes and two agent-shaped runs make eight live checks, not twelve:

| Check           | Models              | Shape                                                     | Asserts                                                                                    |
| --------------- | ------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Native two-step | the four Claude ids | Two `NativeAgentBackend.next` calls over one conversation | Call 1 `cacheWrite > 0`; call 2 `cacheRead > 0`; call 2's read is most of its input        |
| Implicit N-call | the two Gemini ids  | Five `messageWithUsage` calls with a shared prefix        | Some call reports `cacheRead > 0`, and that call's usage carries `cacheEstimated === true` |
| Agent-shaped    | one Claude id       | One real `vnauthor` turn against a real project           | Steps 2 and later report `cacheRead > 0`                                                   |
| Agent-shaped    | one Claude id       | One `report.agent` analysis over a saved thread           | Iterations 2 and later report `cacheRead > 0`; no tool-search round; no `fellBack`         |

The mechanism under test is per backend, not per agent, and a per-model sweep exercises
that mechanism. The two agents differ in the content of their prefixes, and the offline
tests already pin prefix content. The per-model dimension therefore uses the cheap probe,
and each agent gets one end-to-end run on the default model. Running all four Claude
models through a full agent turn would multiply cost by twenty and test the same seam four
times.

The two agent-shaped runs are not redundant with the probes, for one specific reason. A
breakpoint walks back at most twenty content blocks looking for a prior cache entry, and
past that limit the breakpoint silently finds nothing. A two-block probe never reaches
twenty blocks, but a real agent turn with many `tool_use`/`tool_result` pairs does. The
end-to-end runs are the only thing in the matrix that would catch a miss past the
twenty-block limit.

## The two agents have different shapes

`vnauthor` holds a long conversation that grows. `NativeAgentBackend` keeps a `prevBreak`
index recording where the previous request put its trailing breakpoint, which this request
reads from. It marks the last turn `cache = true`, and marks `prevBreak` too when it is
still behind the last turn. It also resets `prevBreak` to `-1` when
`messages.length <= this.prevBreak`, which is the cleared-conversation case. The failure
worth catching is drift: something upstream of the breakpoint changes mid-conversation,
and every later turn pays full price. The end-to-end run catches drift; the probe does
not.

The report analyst is short and mostly one-shot. `analyzeDirectly` is a single
`opts.backend.message` call, and the agent path is bounded by
`maxIterations: opts.maxIterations ?? 24` (analyze.ts:321). It sets `deferTools: false`
deliberately, because deferring would hide `submit_report` behind BM25 tool search and end
the run without a report. It also builds its backend with `record: false`, because the
analyst runs many turns and every one of them would push an entry into the request ring
the analyst may itself be reading. Its cache-relevant failure differs from `vnauthor`'s.
With tool deferral off, the whole catalog is in the prefix on every iteration, so a
catalog that is not byte-stable costs more here than anywhere else.

Neither difference argues for per-model coverage of each agent. Both differences argue for
one run each, with different assertions.

## The approval gate

### Why not a jest project

Four reasons follow, in descending order of how much they matter.

1.  1. **`scripts/jest-setup.cjs` exists to prevent a jest test from reading a real key.**
       The file points `$VNAUTHOR_HOME` at a per-worker directory that is never created,
       and its comment states why: "a test which resolves keys would otherwise read the
       _developer's_ key off their own machine — passing for the wrong reason there and
       failing on CI, where there is none." A live-key jest test has to work around that
       guard or resolve keys outside `resolveKeys`. Working around the guard and resolving
       keys outside `resolveKeys` are both worse than not using jest.
2.  2. **Anything in `projects` runs by default.** `jest.config.cjs` has an explicit
       twenty-three entry `projects` array, `pnpm test` runs bare `jest`, and jest has no
       notion of a default subset — `--selectProjects` only narrows an already-complete
       run. CI runs `pnpm test` at .github/workflows/ci.yml:50 and
       .github/workflows/release.yml:79, on runners where no key is present: `ci.yml`
       declares no `env:` and no `secrets:`. The only workflow that injects
       `secrets.ANTHROPIC_API_KEY` is key-docs-audit.yml:52 (the weekly key-docs audit),
       and that workflow uploads its output as an artifact.
3.  3. **Jest is parallel and the cache is not.** An Anthropic cache entry becomes
       readable only once the first response has begun streaming, so N concurrent requests
       sharing a prefix all pay full price. A live suite must be strictly sequential,
       which under jest means `maxWorkers: 1` or `--runInBand`. That configuration is
       necessary only because jest was chosen.
4.  4. **A suite that self-skips without a key is worse than no suite.** The natural way
       to make a jest project safe in CI is to skip when the key is missing, which
       produces a green run that proves nothing. This exercise exists to catch caching
       that quietly stopped working, and a test that skips quietly hides that same failure
       inside the test harness.

For completeness, a separate config (`jest.live.cjs`, run as
`pnpm exec jest -c jest.live.cjs`) would sidestep points 2 and 4, and a `tests/live/`
subdirectory is already invisible to the current `**/packages/<name>/**/tests/*.test.ts`
globs because `*` does not cross a `/`. That option is viable. The separate config
requires strictly more machinery than a script, for a run that is a linear sequence of API
calls with no fixtures, no mocking and no shared setup.

### What the gate should be

**Keep it a script with no `package.json` entry.** A script is already the repo's
convention for live and destructive verification, and this one has three siblings:
`verify-prompt-chunks.mjs` drives the running desktop app over CDP,
`verify-agent-report.mjs` exercises the report flow against a loopback fake, and
`record-fixture-assets.mjs` re-records fixture art against the real image model. None of
the four is in `package.json`; `turbo.json` defines only a `build` task, so turbo does not
run them; and nothing in any workflow invokes `node scripts/verify-*`.

A person approves a change by typing the command. Requiring a typed command is a stronger
gate than the alternatives:

- An env var (`VN_LIVE_TESTS=1`) can be set once in a shell profile and then forgotten,
  and the variable is invisible at the call site.
- A future contributor adding a CI step greps for a `pnpm verify:cache` script. Adding the
  entry would eventually put it in CI.
- An interactive TTY prompt breaks the moment output is piped. The prompt also adds a step
  that guards nothing, since a full pass costs twenty cents.

The additions the todo needs are `--model <id>` (repeatable) and `--all`, with the current
behaviour (read `config.models.text`) as the default when neither is given. `--all` should
print the model list and a running total while it runs, so a run that is going wrong is
visible before it finishes.

## What a run costs

Anthropic charges cache writes at 1.25× base input for the five-minute TTL and cache reads
at 0.1×. The test pays the write premium so that a later call has something to read back.
The 20,000-character padding sized for Haiku 4.5 is given above. With that padding, two
calls per Claude model and a short answer:

| Model               |       Prefix |  Write |   Read | Output |   Total |
| ------------------- | -----------: | -----: | -----: | -----: | ------: |
| `claude-fable-5`    |    ~6.5k tok | $0.081 | $0.007 | $0.008 | ~$0.095 |
| `claude-opus-4-8`   |    ~6.5k tok | $0.041 | $0.003 | $0.004 | ~$0.048 |
| `claude-sonnet-4-6` |      ~5k tok | $0.019 | $0.002 | $0.002 | ~$0.023 |
| `claude-haiku-4-5`  |      ~5k tok | $0.006 | $0.001 | $0.001 | ~$0.008 |
| `gemini-2.5-flash`  | 5 × 3.4k tok |      — |      — |      — | ~$0.006 |
| `gemini-2.5-pro`    | 5 × 3.4k tok |      — |      — |      — | ~$0.036 |

About
$0.22 for the full six-model sweep. The two agent-shaped runs are the expensive
part. A twenty-step analyst run over a 20k-token prefix on Opus 4.8 is roughly $0.60,
and a `vnauthor` turn is comparable, so the whole thing lands under two dollars. Scoping
to one model with `--model` brings it to single-digit cents.

Two things make it more expensive than that arithmetic, and both are avoidable:

- **Output tokens carry the cost risk, not input tokens.** `MAX_TOKENS_THINKING` is
  16,000. One runaway thinking response on Fable 5 costs $0.80 at $50 per million output
  tokens, four times the cost of the entire sweep. The probe must ask for one word and pin
  the weakest effort the model accepts. `createAnthropicChat` defaults to `DEFAULT_EFFORT`
  (`'low'`) rather than the vendor's default, so adaptive thinking is on unless the probe
  says otherwise. `effortChoicesFor` decides what each model will take: Haiku 4.5 has no
  effort setting at all, Sonnet 4.6 and Opus 4.8 accept `'none'`, and Fable 5 does not,
  because it thinks unconditionally and returns 400 on explicitly disabled thinking. Every
  Fable 5 call is therefore billed for some thinking, which is part of why Fable 5 is the
  most expensive row.
- The 1-hour TTL is the wrong choice here. It doubles the write premium for no benefit,
  because the two calls of a probe are seconds apart. `EPHEMERAL` in `convo-request.ts` is
  already the five-minute default, and its comment gives the reason.

Cost is not the argument against building this. The arguments are nondeterminism against a
third party, the need for keys CI does not have, and wall-clock latency.

## Flakiness, the TTL, and a latent bug in the current script

**Never assert on elapsed time.** The five-minute TTL is two orders of magnitude longer
than the gap between two sequential calls, so the correct treatment is to make the calls
back to back and assert nothing about timing at all. No tolerance, no sleep, no clock
injection. (The verdict logic in the planned thread-recording work does need a timestamp,
because it compares receipts that may be minutes apart. A probe does not need a
timestamp.)

Only the second call can hit the cache, so call 1 asserts `cacheWrite > 0` and call 2
asserts `cacheRead > 0`. The test asserts nothing about what call 1 read.

`scripts/verify-prompt-cache.mjs` has a real flake as it stands. The script's padding is
deliberately fixed text — "It is fixed text: the same bytes on every run, which is the
whole premise of a prefix cache" (lines 85–93). But the messages are fixed too
(`Say "one".`), so two runs inside five minutes present the same prefix twice. The second
run's step 1 reads the entry the first run wrote instead of creating one, `cacheWrite`
comes back zero or absent, and the assertion at lines 129–136 fails on a working
implementation. The comment is right about what the cache needs and wrong about what the
test needs. The bytes must be stable within a run and novel between runs.

Fix this by putting a per-run nonce at the front of the padding. Everything after the
nonce stays fixed, the prefix stays byte-identical across the run's two calls, and step 1
always writes.

Gemini requires the reverse arrangement. Its implicit cache is opportunistic and warms
slowly, there is no write to observe, and a prefix reused across runs makes a hit more
likely rather than less. So the Gemini probe keeps its fixed padding and the Claude probe
gets the nonce. The asymmetry is worth a comment in the code, because it looks like an
inconsistency.

Always send model requests sequentially. Never use `Promise.all` across models, because
two concurrent requests sharing a prefix both miss, and the failure looks like a caching
bug rather than a scheduling bug.

**Separate a transport failure from a cache failure.** A 429 or a 529 must not be reported
as "caching broke". `faultKind` in `packages/providers/src/backends/transient.ts` already
classifies a fault as `request`, `auth` or `transient`; the run should use that
classification and exit with a message that names the kind of fault, so a failed run is
never ambiguous.

## Keys, logs, and what a failure is allowed to print

The rules in CLAUDE.md state that `keys/` is gitignored, key values are never logged or
committed, `project.yaml` records only model ids and env-var names, and `resolveKeys`
throws errors naming the source rather than the value. These rules apply to a suite that
makes real calls as follows:

**Resolve through `resolveKeys`, never `process.env` directly.** The script's `keyFor`
helper (lines 111–115) already does this:
`resolveKeys(config, { secretsDirs: await secretDirsFor(dir), require: [vendor] })`. A
missing key produces a `ConfigError` that names the env var and the file searched for it.
Do not copy scripts/audit-key-instructions.mjs:130, which reads `process.env[v.env]`
directly. That call is fine there because the variable name comes from the guide itself,
but it is the wrong shape for anything that resolves a project's key.

A failing assertion prints a projection rather than the request. Today `say(usage)` prints
five integers and nothing else. When an assertion about placement fails, the useful
diagnostic is the shape of the request rather than its body, reporting for each block in
`tools`, `system` and `messages` the block type, its length in characters, and whether it
carries `cache_control`. That shape identifies a misplaced breakpoint exactly, and it
contains no project prose and no key. `buildConvoRequest` is pure and exported, so the
projection can be computed from the same inputs rather than scraped off the wire.

**Print request bodies, never transports.** The Anthropic SDK sends the key as an
`x-api-key` header, and a Gemini request can carry it as a query parameter. A dump may
include a request body and must never include a client object, a fetch init, a header map,
or a URL. The Gemini case is the more dangerous one, because a key in a URL appears in
anything that logs a request line.

**Do not fill the request ring.** `@vn/providers` keeps a bounded in-memory ring of
request bodies (64 MB, 64 entries). `analystBackend` in
`packages/agentreport/src/analyze.ts` passes `{ record: false }` to keep its bodies out of
that ring. A verification run should pass the same option, so that a crash dump holds no
request bodies.

A CI log contains nothing from this script. It is not in `package.json`, not in
`turbo.json`, and not referenced by any workflow. If somebody wires it into `ci.yml`
anyway, no key is present there, `resolveKeys` throws naming `ANTHROPIC_API_KEY`, and the
job fails as a configuration error with no secret in the output. Do not add a cache step
to `key-docs-audit.yml`, which is the one workflow that does inject keys and which uploads
its output as an artifact.

`--verbose` should not exist. The script has no verbose flag today and should not gain
one; if it ever does, the flag gates the shape projection above, never the body. Verbosity
is also a fifth argument against jest: `jest --verbose` prints test names rather than
bodies, but any `console.log` a test makes is printed in full, and a live test that logs a
request on failure is one careless line away from logging a header map with it.

## What I would build, in order

1.  1. **Fix the re-run flake.** Prepend a per-run nonce to the Claude padding in
       `scripts/verify-prompt-cache.mjs` and correct the comment at lines 85–93. This fix
       is independent of everything below, and it makes a repeated run trustworthy.
2.  2. **Size the padding for Haiku 4.5.** Raise the Claude prefix to roughly 20,000
       characters. Say in the comment which model set the number, and why the same
       character count comes to a different token count on each model.
3.  3. **Add `--model` and `--all`.** The default stays `config.models.text`. `--all`
       walks `TEXT_MODELS` from `@vn/types`, imported rather than copied, so the sweep
       covers a seventh model as soon as one is added to that list. Dispatch per model
       through `chatVendorFor` rather than the script's current inline regexes. Print a
       running total.
4.  4. **Pin effort to the weakest each model accepts** (through `effortChoicesFor`) and
       instruct a one-word answer. This is the only cost control that matters.
5.  **Classify failures with `faultKind`,** so a rate limit is not reported as a cache
    regression.
6.  6. **Add the two agent-shaped runs** as separate scripts or separate flags: one
       `vnauthor` turn asserting steps 2 and later read from cache, one `report.agent`
       analysis asserting the same plus no tool-search round and no `fellBack`. The
       analyst check is already prescribed as a manual procedure in
       [`../plans/archive/INDEX.md#prompt-caching-for-the-report-analyst`](../plans/archive/INDEX.md#prompt-caching-for-the-report-analyst);
       these scripts make that check runnable.
7.  **Read the capability declaration once it exists.** When stage 1 of
    [`../plans/recording-cache-misses-in-a-thread.md`](../plans/recording-cache-misses-in-a-thread.md)
    lands `cacheReporting` on `ChatBackend`, switch the vendor dispatch to read it, and
    turn the unreachable "this model does not cache" branch into a real skip that names
    the model.

Steps 1 and 2 are worth doing regardless. Steps 3 to 5 are what the todo already
specifies. Steps 6 and 7 catch cases the offline tests miss.

## Is it worth it

The answer is no at the size the todo describes (a suite, per model, for both agents). The
answer is yes at the size above, which is small.

The reason is that "unit tests for prompt caching" splits cleanly into two halves with
very different value. The half that checks whether the request was built correctly runs
offline in milliseconds, needs no key, and is already seventeen tests deep. It catches
every regression that originates in this repository: a moved breakpoint, a prefix that
stopped being byte-stable, a marked thinking block, a fifth breakpoint. Request
construction is where caching bugs actually come from, and that half is already covered.

The second half checks whether the provider charged for a cache read, and it catches one
thing the first half cannot: a change on the vendor's side. A model may quietly stop
honouring `cache_control`, a minimum prefix may be raised, a field in `usage` may be
renamed, or a model id may be added to `TEXT_MODELS` whose minimum nobody checked. Each of
these changes is real, no offline test can see it, and the only way to see it is to spend
money. These changes happen on the vendor's release schedule rather than on this
repository's commit schedule, so the right cadence is a run when a model is added or the
request shape is edited, rather than a suite that exists to be run.

The todo is right about the problem and wrong about the unit of work. The work needed is
not twelve tests but one change to a script that already exists, so that it walks a list.
