# Improving the authoring agent

What to change in `vnauthor` and its desktop host, derived from
[`../research/agent-transcript-review-test4.md`](../research/agent-transcript-review-test4.md) —
an adversarial read of the four saved conversations in `examples/test4`. The review says what went
wrong; this plan says what to build.

Two designs carry the weight and are specified in full: **a token budget replacing `maxSteps`**,
and **a partial file update tool**. They are one idea seen twice. The agent's scarce resource is
tokens, not iterations, and the largest avoidable spend is rewriting whole files to change a
paragraph — so metering the right quantity and giving the model a way to spend less of it belong
in the same change.

## 1. A token budget instead of a step count

### The problem with `maxSteps`

`packages/authoring/src/loop.ts:373` runs `for (let step = 0; step < this.maxSteps; step++)`, with
`maxSteps = opts.maxSteps ?? 24` set once in the constructor. Nothing in the desktop passes a
value, so every conversation the app has ever run has been capped at 24 model round trips per user
message. Three things are wrong with it:

- **It meters the wrong quantity.** A step that reads a 40-byte front-matter field and a step that
  pastes an 18 KB wiki page into context cost the same one. What the author is actually spending is
  tokens; what the loop counts is turns of the crank.
- **It is invisible to everyone.** The model is never told the number, never told how much is left,
  and gets no warning as it approaches. The author cannot see or change it.
- **Running out is indistinguishable from finishing.** Falling out of the loop emits an ordinary
  `{type: 'final'}` carrying `Reached the step limit before finishing; stopping to avoid looping.`
  The host records it as the turn's answer, and in the desktop it can become a commit subject. It
  names nothing that was done, though `editedPaths` is in scope holding exactly that.

Thread 4 of the review is this failing in the open: asked to draft 39 scenes, the agent stops after
the enumeration with that one sentence and no account of where it got to.

### What gets counted

**The budget charges non-cached tokens.**

```ts
/** What one receipt spends against the budget: fresh input plus output, cache reads excluded. */
export function charge(u: TokenUsage): number {
  return u.input - (u.cacheRead ?? 0) + u.output;
}
```

`TokenUsage.input` is the grand total of everything billed as input, with `cacheRead` and
`cacheWrite` carved back *out* of it rather than added beside it
(`packages/providers/src/backend.ts:47`). So subtracting `cacheRead` leaves exactly the input the
model had not seen before.

Three consequences worth stating, because each is a decision:

- **Cache reads are free of the budget.** They are billed at a tenth of the base rate, and — more
  to the point — a long turn re-sends its whole cached prefix on every step. On a total-input
  meter a 40-step turn with a 60 KB prefix bills 2.4M input tokens having added almost nothing, so
  a 200k budget would die four steps in with no work done. The prefix is not what the turn is
  spending; the new bytes are.
- **Cache writes are counted.** A cache write is a token the model had never seen, sent for the
  first time and billed at 1.25× base. It is uncached by any honest reading of the word.
- **A provider that reports no cache split spends its whole input**, because `cacheRead` absent
  means the vendor said nothing, which for this purpose is the same as no cache having been read.

`AgentTurn.usage` already sums every retry inside one `backend.next` (`backend.ts:190`), so a step
that burned three parse retries charges all three. That is correct and must stay: each attempt was
a call, and each was billed.

### The choices

```ts
/** The budget choices, in the order the menu offers them. `0` is unlimited. */
export const BUDGET_CHOICES = [
  '50k', '100k', '200k', '400k', '600k', '1m', '5m', 'unlimited',
] as const;
export type BudgetChoice = (typeof BUDGET_CHOICES)[number];

export function budgetTokens(choice: BudgetChoice): number {
  return choice === 'unlimited' ? Infinity : /* 50k → 50_000, 1m → 1_000_000, … */ 0;
}
```

Default **200k** — enough to draft several scenes, small enough that a runaway costs less than a
coffee. It lives beside `effort` in `WorkspaceSession` (`session.ts:596`).

**The budget is per turn**, not per conversation. It replaces a per-turn cap; the convo bar already
shows a running per-*conversation* total two widgets away, so the pane can display both without
either being ambiguous, and each carries a tooltip saying which it is. An author who wants a
per-conversation ceiling gets it by clearing less often, which is the wrong tool — but a
per-conversation budget would silently shrink every turn as a conversation aged, which is worse.

### Enforcement in the loop

Replace the bare counter with a meter that the model can see:

```ts
let spent = 0;
let warned = false;
for (let step = 0; step < MAX_ITERATIONS; step++) {
  if (this.stopped) { /* … unchanged … */ }

  // Between steps, never inside one — the same rule `stop()` follows, for the same reason: a
  // `tool_use` the transcript never answers is a request the API will refuse to continue.
  if (spent >= this.budget) {
    return this.outOfBudget(spent, emit, events);
  }

  const turn = await this.backend.next(this.system, this.messages, tools);
  if (turn.usage) { spent += charge(turn.usage); emit({ type: 'usage', ...turn.usage }); }
  …
  if (!warned && spent >= this.budget * 0.8) {
    warned = true;
    this.messages.push({ role: 'system', content: budgetWarning(this.budget - spent) });
  }
}
```

Four points of design in that:

- **The check is between steps**, like `stop()`. A budget exhausted mid-reply still dispatches every
  tool call in that reply, because the API requires every `tool_use` to be answered.
- **The warning is a `{role: 'system'}` message**, which is how everything that changes
  mid-conversation is filed here — the mode, a superseded `AICONTEXT.md` section. It is appended
  rather than edited into the prefix, so it costs one cache write and invalidates nothing.
  Its text is the instruction the agent needs and cannot infer:

  > BUDGET: about 40,000 tokens remain this turn. Stop starting new work. Finish and commit what
  > is in progress, then reply telling the author exactly what landed and what is left.

- **`MAX_ITERATIONS` stays**, renamed from `maxSteps` to what it actually is: a runaway backstop,
  not a policy. Set it high (200). It has to exist because a backend that reports no usage — a mock,
  a provider without receipts, `@vn/agentreport`'s own path — spends zero against any budget and
  would otherwise loop until the process died. `unlimited` means unlimited *budget*; it is still
  backstopped.
- **Running out reports.** `outOfBudget` emits a final that names the spend, the budget and the
  files touched:

  > Out of budget for this turn — spent 203,400 of 200,000 non-cached tokens. Written since the
  > last commit: `wiki/routes/ember.md`, `scenes/s04_workshop.md`. Say "continue" to keep going, or
  > raise the budget in the convo bar.

  The same treatment fixes the `MAX_ITERATIONS` message and, separately, is what the existing
  step-limit sentence should always have said.

### The dropdown

The convo bar (`apps/desktop/renderer/pathux/editors/convo.ts:219`) already has the exact pattern —
`this.bar.menu(label, template)` builds the model and effort dropdowns, each row carrying its own
tooltip in slot 4 and an explicit id in slot 5 (`createMenu` reads `item[5]` for any row longer than
four and would otherwise file the callback under `undefined`). The budget menu is a third one,
placed between `effort` and the running-token label so the ceiling reads next to the count:

```ts
const budgets: MenuTemplate = BUDGET_CHOICES.map((choice) => [
  budgetLabel(choice),
  () => void setBudget(choice),
  undefined,
  undefined,
  choice === 'unlimited'
    ? 'Let a turn run as long as it needs. Nothing stops it early except you.'
    : `Stop a turn after it has spent ${budgetLabel(choice)} tokens it did not read from cache.`,
  choice,
]) as MenuTemplate;
const budget = this.bar.menu(`budget: ${budgetLabel(ui.budget)}`, budgets);
budget.description =
  'How much one turn may spend before the agent is told to wrap up. Counts what was sent fresh ' +
  'and what came back — never what was read from cache. Takes effect on the next turn.';
```

`ui.budget` joins `stateKey()` so the bar rebuilds when it changes:

```ts
return `${ui.agentMode}|${ui.model}|${ui.effort}|${ui.budget}`;
```

While a turn is in flight the label shows progress — `budget 47k/200k` — retitled in place through
the same route `sayTokens` uses, deliberately **not** through `stateKey`, because a rebuild
mid-turn closes any menu the author has open over the bar.

### The command

Mirroring `agent.setEffort` exactly (`apps/desktop/src/main/commands/agent.ts:75`):

```ts
export const agentSetBudget = define({
  id: 'agent.setBudget',
  title: 'Set agent turn budget',
  description:
    'How many non-cached tokens one turn may spend before the agent is asked to wrap up. Cache ' +
    'reads do not count. `unlimited` removes the ceiling.',
  mutating: false,
  props: { budget: prop.oneOf(BUDGET_CHOICES, 'the ceiling to bind') },
  async run({ budget }, ctx) {
    return { message: `Agent turn budget is now ${await ctx.host.session.setBudget(budget)}.` };
  },
});
```

Not `undoable` and not `mutating`, for the same reasons `agent.setEffort` is neither: it writes no
file and an undo point is a git snapshot.

**It should persist**, unlike `effort`, which is an in-memory session field reset by every restart.
A spend ceiling an author lowered to `50k` must not be quietly back at `200k` tomorrow. The install
scope is right — `.vndesktop/session.json`, beside the live mesh — because it is a preference about
this machine's spending, not a fact about the project.

`vnauthor` gets the same control as a `--budget` flag; the REPL is where a long unattended run is
most likely and least watched.

### What the budget cannot see

Stated because the tooltip should not overclaim: a backend that reports no usage is unmetered, and
`--mock` is free. `@vn/agentreport` runs its own loop with its own `maxSteps` (`analyze.ts:199`)
and is out of scope here — it should take the same treatment, in the same change or immediately
after, since it is the last caller of `StructuredAgentBackend`.

## 2. A partial file update tool

### Why

`write_file` is whole-file only. Changing one sentence in an 18 KB wiki page costs ~4,500 output
tokens to restate what was already there, and the model must first spend ~4,500 input tokens
reading it. Under a token budget that is the difference between a turn that drafts four scenes and
one that drafts one. It is also, independently, where the review's worst data-loss risk sits.

**The staleness guard already exists, and the agent is the one caller that skips it.**
`packages/store/src/docfile.ts:145` `checkDocWrite` refuses a save whose `seenHash` no longer
matches the bytes on disk, refuses front-matter that will not parse, and refuses a save that drops
a `type:` tag — because dropping the tag deletes the entity. The desktop's `doc.write` goes through
it. `write_file` calls `writeFileAtomic` directly (`tools.ts:876`) with nothing but the `scenes/`
guard, so the agent can silently clobber a file the author edited thirty seconds earlier in the
Wiki pane. The new tool and the fix to the old one are the same work.

### The read ledger

The model never types a hash. The loop keeps one:

```ts
/** What the agent was last shown of each file: the hash it read at, and whether it saw all of it. */
private readonly seen = new Map<string, { hash: string; whole: boolean }>();
```

- **`read_file` records into it.** `readDocFile` already returns `DocFile.hash`
  (`docfile.ts:51`) and the tool currently throws it away. An `offset`/`limit` read records
  `whole: false`.
- **A successful `edit_file` / `write_file` records the new hash**, so consecutive edits to one file
  need no re-read.
- **It is per conversation**, cleared by `agent.clear` and by opening another workspace — the same
  boundary everything else in the session respects.
- **Nothing watches the filesystem.** The check is a fresh `readDocFile` at write time compared
  against the ledger, which is correct by construction: it does not matter whether the author, a
  `story.*` command or another process changed the file, only that the bytes are not the bytes the
  model reasoned about.

Rejected alternative: making the model quote the hash back as an argument, the way `doc.write` does.
A hash in the argument list is a token the model can hallucinate and 16 more it must emit every
call, and the loop already knows the answer. `doc.write` needs it because its caller is a pane that
genuinely holds a stale copy; the agent's caller is the loop.

### The tool

```ts
const editFileTool: Tool<{ path: string; edits: { old: string; new: string; all?: boolean }[] }> = {
  name: 'edit_file',
  description:
    'Replace exact strings in a workspace file, leaving the rest untouched — the way to change ' +
    'part of a long document without restating it. Each `old` must appear exactly once unless ' +
    '`all` is set. Read the file first: an edit to a file you have not read, or that changed ' +
    'since you read it, is refused. Not for scenes/ (edit_scene), characters/ or locations/ ' +
    '(their own tools).',
  mutating: true,
  args: z.object({
    path: z.string(),
    edits: z
      .array(z.object({ old: z.string(), new: z.string(), all: z.boolean().optional() }))
      .min(1),
  }),
  …
};
```

Semantics, each chosen against something that actually went wrong in the transcripts:

- **Exact, whitespace-significant matching.** No fuzzy fallback. A near-match that silently lands
  in the wrong paragraph is worse than a refusal, and the refusal is cheap to recover from.
- **Uniqueness is required.** Zero matches and several matches are different refusals and say so:
  `edit 2: "the Ember route" appears 4 times in wiki/routes.md — extend it until it is unique, or
  pass all: true`. Naming the index matters because a multi-edit call otherwise gives the model no
  way to know which one to fix.
- **All-or-nothing.** Every edit is applied to the text in memory, in order, and the result is
  written once. A failing edit aborts the call and writes nothing. This is the discipline the scene
  writer already holds — "a multi-chunk patch is computed in full before any of it is written" —
  and it is what makes a refusal safe to retry.
- **One `checkDocWrite` on the result.** So an edit that corrupts front-matter or drops a `type:`
  tag is refused by the same code path, with the same sentence, as a save from the Wiki pane.
- **The observation is a diff, not a file.** Three lines of context around each change, plus
  `Edited wiki/routes.md — 2 changes, 18,412 → 18,390 bytes.` Returning the whole file would give
  back everything the tool was built to save.

The refusal for a stale or unread file is the load-bearing one:

```
wiki/routes.md changed since you read it (read at 3f9c1a2b0e44, now 7d20c8ee91af) —
read_file it again and reapply.
```

```
wiki/routes.md has not been read this conversation — read_file it first, so an edit is made
against what is actually there.
```

### What it may touch

The same domain as `write_file`, and no wider: free-form documents, which in practice means
`wiki/**` and the loose markdown at the root. `scenes/` belongs to `edit_scene`; per §3.4 below,
`characters/` and `locations/` belong to their own tools. The refusal names the right tool rather
than the wrong directory, so a redirect costs one call.

### The two fixes it drags along

- **`write_file` goes through `writeDocFile`** with the ledger's hash, gaining the staleness check,
  the front-matter parse and the `type:`-tag protection it should never have been without. A file
  the agent has not read is created with `seenHash: ''`, which is exactly what `checkDocWrite`
  already means by it; a file that exists and was not read is refused, which is the correct answer
  to "overwrite something you have not looked at".
- **`read_file` stops being a pure read** in one respect only: it records what it showed. Nothing
  about its output changes.

## 3. The rest of the recommendations

Everything below is argued in full in the review; this is the build order and the shape.

### 3.1 Stop discarding the agent's answer (`backend.ts`)

When all attempts fail to parse and the raw text holds no tool call, return `{ final: raw }`. A
model that answered in prose finished its turn — the JSON envelope is our bookkeeping, not its
intent. Make attempts 2+ corrective rather than byte-identical (`Your previous reply was not a
single JSON object. Reply with the JSON object only.`), and keep the current
`I couldn't produce a valid action` only for output holding a malformed tool call. Cheapest item
here and it stops losing whole answers; thread 2 of the review ends on this.

### 3.2 Bulk scene lines (`edit_scene`)

`insertLines: [{kind, speaker, text}]`, folded over the existing `planSceneEdit` decisions one at a
time so ids stay allocated by `@vn/scriptedit` and the one-prose-write-path invariant holds. A
40-line scene goes from 41 calls to two. Without it, no budget large enough to draft 39 scenes is
reachable — and with the token budget in place, the saving is measured in money rather than in
iterations.

### 3.3 Tools that tell the truth about their own scope

- **`search`** names its scope in the description *and* in the no-match result: `No matches in
  characters/, locations/, scenes/. The story bible (wiki/) and archive/ are not searched — try
  search_bible or list_archive.` A negative result that states what it looked at is the difference
  between a dead end and a redirect.
- **`search_bible`** emits workspace-relative paths (prefix the bible root) so a hit is pasteable
  into `read_file`. Four consecutive failed reads in one turn came from this alone.
- **`create_character` / `create_location`** report which of their two behaviours they took —
  `from the description you gave` versus `as an empty template — no description was given`. The
  uniform observation is what led the agent to tell the author eleven sheets were placeholders when
  eight were fully written, and then rewrite them.

### 3.4 The create/edit/guard triangle

Give the create tools the full field set of their `edit_*` siblings (the shapes exist; creation is
that shape minus `id`), and extend `write_file`'s guard to `characters/` and `locations/` with a
refusal naming the way in. These are one change: the guard is only fair once the tool it redirects
to can do the job. Today the agent hand-wrote 24 location sheets in raw YAML precisely because
`create_location` takes `{name, description}` and nothing else.

### 3.5 System prompt

Six edits, given verbatim in
[the review's prompt section](../research/agent-transcript-review-test4.md#proposed-system-prompt-changes):
a MODE paragraph that names the out-of-band message as authoritative and forbids narrating the mode
or claiming approval; `propose_plan` detached from plan mode; a what-writes-what table; the search
seams; a paragraph on working at scale; and a sharpened honesty line. Two now interact with this
plan and should be written with it rather than copied:

- The **working at scale** paragraph should name the budget, since the agent will now receive a
  budget warning message and needs to know what to do with one.
- The **what writes what** table gains `edit_file` as the default for `wiki/**`, with `write_file`
  demoted to "a file you are creating, or replacing wholesale".

### 3.6 Host plumbing

- **Generate the project map.** `AICONTEXT.generated.md` does not exist in `examples/test4` and
  never did; every thread re-derives the cast, one spending four near-identical `search_bible`
  calls on it. Regenerate on workspace open and after any turn that wrote to `characters/`,
  `locations/`, `scenes/` or `wiki/`; `Agent.refreshSystem` already files the change as a supersede
  message rather than invalidating the cached prefix.
- **File the missing feed items.** Questions and their option lists, plans, plan decisions, and
  arguments the schema refused are all absent from the durable thread — which is what `report.agent`
  reads, so the diagnostic tool cannot see the decisive turns.
- **`update_context`** returns the resulting file so the model can see what it built, and the agent
  stops passing explicit `paths` to `git_commit` — `editedPaths` is more accurate than the model's
  memory of what it touched, which is the reason that default exists and the reason `AICONTEXT.md`
  went uncommitted.

## 4. Order

1. **§3.1** — a dozen lines, stops losing answers outright.
2. **§1, the budget** — it is the frame everything else is measured in, and it makes the cost of
   §3.2 and §2 legible instead of theoretical.
3. **§2, `edit_file`** — the largest single token saving, and it closes the `write_file` clobber
   hole on the way past.
4. **§3.3** — descriptions and observation strings, no design decisions, most of the wasted calls
   in the transcripts.
5. **§3.5** — the prompt, written once §1 and §2 exist so it can describe them.
6. **§3.2** and **§3.4** — the two shape changes to the tool surface.
7. **§3.6** — host plumbing.
