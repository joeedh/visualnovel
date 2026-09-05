---
name: review-agent-transcripts
description:
    Review recent vnauthor agent conversation transcripts inside a VN project repo (the
    most recent thread plus a window before it), keep a ledger of what was already
    reviewed, produce recommendations for the codebase, and optionally turn them into a
    pressure-tested plan in docs/plans/. Use when asked to review agent transcripts,
    review recent vn/vnauthor conversations, or find out how the authoring agent is
    behaving in a project.
---

# Review recent VN agent transcripts

A vnauthor conversation is written to `vngen/state/threads/<id>.jsonl` in the **project**
repo it was had in — a repo full of authored inputs and generated art, separate from this
codebase. Those transcripts are the only record of how the authoring agent actually
behaves against real work: what it refused, what it retried, what it misunderstood, what a
tool made hard.

This skill reads a window of them and turns what it finds into recommendations for
**this** codebase — the agent's tools, prompts, rules, docs and commands — and optionally
into a plan.

## Arguments

`/review-agent-transcripts <repo-path> [window]`

- `<repo-path>` — **required**, the project repo to review (e.g. `examples/test4`, or an
  absolute path outside this checkout). If the user did not give one, ask for it before
  doing anything else.
- `[window]` — optional, how far back from the **most recent** transcript to reach: `24h`
  (the default), `48h`, `3d`, `1w`. Convert to hours for the scanner.

## 1. Scan

```bash
node .claude/skills/review-agent-transcripts/transcripts.mjs list <repo-path> --hours <N>
```

The window is measured back from the newest transcript's `startedAt`, **not from now** — a
repo last touched a month ago still reviews as "the last session plus the day before it".
The newest transcript is always included.

Output is one JSON object: the window, the newest thread, and a summary per transcript in
it — id, title, start/end, model and effort, item counts, failed tool calls, and the
twelve tools it leaned on hardest. `reviewed` / `reviewedAt` come from the ledger.

If `transcripts` is empty, say so plainly (naming `totalTranscripts`, which tells "no
threads at all" apart from "none in the window") and stop.

## 2. Ask about already-reviewed transcripts

If **any** in-window transcript has `reviewed: true`, ask the user with `AskUserQuestion`
whether to exclude them, showing how many are already reviewed and how many are new:

- **Skip the reviewed ones** (recommended) — review only what is new since the last
  session.
- **Re-read everything in the window** — the earlier review's conclusions are being
  revisited.

If none are marked reviewed, do not ask; just proceed.

## 3. Read

```bash
node .claude/skills/review-agent-transcripts/transcripts.mjs show <repo-path> --ids <a,b,c>
```

`show` prints each transcript as readable lines — role, timestamp, the **unclamped** text
where the log kept one, and each tool's args, ok/failed and output. Read every selected
transcript in full. A big thread (hundreds of items) is worth reading in one go anyway:
the pattern is usually in the repetition.

Then read whatever this codebase needs to explain what you saw — the tool that refused,
the prompt that framed it, the doc that states the rule, the plan that shipped it.
`docs/index.md` is the map; `apps/authoring/`, `packages/authoring/` and
`apps/desktop/src/main/` hold most of what a transcript touches. Do not guess at a tool's
behaviour when its source is right here.

Read the project repo too where a transcript's meaning depends on it — the scene it
edited, the `project.yaml` it read, `git log` around the thread's `commit`.

## 4. Recommend

Report to the user, in the conversation, grouped by theme rather than by transcript. For
each recommendation:

- **What happened**, cited as `<thread-id>#<item-id>` so any claim can be checked.
- **Why it happened** — the code, prompt or rule responsible, by file path.
- **What to change**, concretely, and how big it is.
- Whether it recurred across threads, which is what separates a papercut from a one-off.

Rank by how often the transcripts hit it and how badly it went. Include what went _well_
only where it argues against a change someone might otherwise make. Say plainly when a
transcript's trouble was the author's phrasing rather than the agent — that is a finding
about the docs or the tool's description, not a defect.

## 5. Offer a plan

Ask with `AskUserQuestion` whether to turn the recommendations into a plan:

- **Write a plan** — which recommendations to cover (offer the obvious grouping, and allow
  "all").
- **Recommendations only** — stop here.

If the user declines, go to step 6.

If the user accepts:

1. Launch a **planning agent** (`Agent`, `subagent_type: "Plan"`) with the full
   recommendations, the transcript ids and their file paths as evidence, and the repo
   conventions it must follow: plans live at `docs/plans/<descriptive-name>.md`, a plan is
   written before the work starts, and `docs/reference/conventions.md` states the rest.
   Tell it to write the file itself and report the path.
2. Then launch a **pressure-testing agent** in a **fresh context** (`Agent`,
   `subagent_type: "general-purpose"`) that has not seen this conversation. Give it only
   the plan path and the instruction to attack it: what does it assume without stating,
   what does it contradict in the code or in `docs/`, what does it leave undecided, what
   would it cost to undo, what leaves a reader unable to act. It must not have the
   planning agent's context — that context holds the reasoning the plan is supposed to
   carry on its own.
3. **Write the findings into the plan** — each one either fixed, or recorded with the
   reason it is wrong or out of scope. A review that leaves no trace in the file did not
   happen.
4. Add the plan's row to `docs/plans/index.md` with status **planned**.
5. Do **not** start implementing it. The plan is the deliverable.

## 6. Record the ledger

Whatever the user chose about the plan, record what was read:

```bash
node .claude/skills/review-agent-transcripts/transcripts.mjs record <repo-path> \
  --ids <every-transcript-id-you-actually-read> --note "<plan path, or a few words>"
```

Record only ids you actually read — the ledger's whole value is that "already reviewed"
means it. The ledger is `.claude/transcript-review-ledger.json` in this codebase repo,
gitignored, keyed by absolute repo path. It is a memo, not a source of truth: a corrupt
one is treated as empty rather than stopping a review.

Finish by telling the user what was reviewed, what the ledger now holds, and the plan path
if one was written.
