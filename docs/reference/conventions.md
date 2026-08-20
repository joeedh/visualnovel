# Conventions

<!-- toc -->

- [Plans](#plans)
- [Research](#research)
- [Documentation](#documentation)
- [Finishing a plan](#finishing-a-plan)

<!-- tocstop -->

How this repository is written, as opposed to what it does. Where plans and research are
filed, how documentation is kept honest, and the checklist a plan passes before it counts as
finished.

Three conventions deliberately stay in [`../../CLAUDE.md`](../../CLAUDE.md) rather than moving
here — **comments** (plain declarative prose, no epigrams), **git history** (`master` is
linear; a branch lands by rebasing) and **tooltips** (every interactive element carries one).
All three are rules that have to be in hand while the work is happening, not looked up
afterwards.

## Plans

- **Plans live in [`plans/`](../plans).** Any implementation plan gets written to
  `docs/plans/<descriptive-name>.md` before the work starts, and is kept up to date as the
  work proceeds — not left only in the conversation. the plan should have a properly
  descriptive name.
- **A shipped plan moves to [`plans/archive/`](../plans/archive).** [`../plans/index.md`](../plans/index.md)
  is the authority on status; when its row for a plan flips to **shipped**, the file is
  `git mv`ed into `archive/` in the same change and every link to it updated —
  `pnpm check:doclinks` (part of `pnpm lint`) names each one that was missed. Open plans
  (planned/partial) and the tracker files stay at the top level, so `docs/plans/` itself
  reads as the list of work still in flight.
- **`todos.md` at the repo root is the author's running list, and a finished item gets its
  checkbox checked** — `[ ]:` becomes `[x]:` as part of finishing the work, not later. Leave
  the wording, ordering and whitespace of the entry alone: it is hand-written, it is
  deliberately outside prettier's idea of markdown, and reformatting it loses the author's
  own shorthand.  When executing the todo list items, items that create documents (including
  plans) should be executed in subagents.
- **A plan is pressure-tested by a fresh-context agent after it is formulated and before the
  work starts.** Once `docs/plans/<name>.md` reads as finished, hand it to a subagent that has
  not seen the conversation that produced it and ask it to attack the plan rather than approve
  it: what does the plan assume without stating, what does it contradict in the code or in
  `docs/`, what decision does it defer, what would it cost to undo, and what does it leave a
  reader unable to act on. The reviewer must be a *separate* context, not a continuation of the
  author's — the author's context already holds the reasoning the plan is supposed to carry on
  its own, so an agent that helped write it reads its own memory back in and cannot tell a
  stated decision from a remembered one.
- **The findings are then written into the plan** — each is either fixed, or recorded in the
  plan with the reason it is wrong or deliberately out of scope. A review that leaves no trace
  in the file did not happen, and the next reader will raise the same objection.

## Research

- **Research lives in [`research/`](../research).** Any survey, investigation
  write-up, or report goes in `docs/research/<descriptive-name>.md` — not at the `docs/`
  root and not only in the conversation. Design docs and implementation plans keep their
  existing homes (`docs/`, `docs/plans/`).

## Documentation

- **`CLAUDE.md` is the map, not the territory.** Keep it to what a contributor needs
  in-hand: the layering, the commands, the invariants in one or two lines each, and a pointer
  to the doc that states them in full. When a section there grows past roughly a screen of
  as-shipped detail, move it under `docs/` and leave the pointer — a `docs/` page is read on
  demand, whereas everything in `CLAUDE.md` is carried into every session.
- **Every new `docs/` page is listed in [`../index.md`](../index.md)** with a one-line
  summary of what it covers.
- **Lint and format markdown by naming the files.** After a docs-only change run
  `pnpm exec prettier --check <the files you touched>`, not a blanket `pnpm lint` — that runs
  eslint over the whole workspace and prettier over every file in the repo to check a page or
  two, which is slow and reports on files the change never touched.

## Finishing a plan

Before a plan is considered done:

1. **Audit the comments** in all code the plan touched — stale, redundant, or
   over-long comments get fixed or deleted, and every `CLAUDENOTE:` is gone.
2. **Update the docs the plan affects** — the relevant file(s) under `docs/` (design,
   plan, runner notes) and `CLAUDE.md` itself, so the described architecture, commands,
   and conventions match the code as shipped.
