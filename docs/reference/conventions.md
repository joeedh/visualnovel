# Conventions

<!-- toc -->

- [Plans](#plans)
- [Research](#research)
- [Documentation](#documentation)
- [Finishing a plan](#finishing-a-plan)

<!-- tocstop -->

This section covers how the repository is written rather than what it does. It describes
where plans and research are filed, how documentation is kept accurate, and the checklist
a plan passes before it counts as finished.

Three conventions deliberately stay in [`../../CLAUDE.md`](../../CLAUDE.md) rather than
moving here: comments are plain declarative prose with no epigrams, `master` stays linear
and a branch lands by rebasing, and every interactive element carries a tooltip. All three
are rules a person needs in hand while the work is happening rather than looked up
afterwards.

## Plans

- **Plans live in [`plans/`](../plans).** Any implementation plan is written to
  `docs/plans/<descriptive-name>.md` before the work starts, and is kept up to date as the
  work proceeds rather than left only in the conversation. Give the plan a descriptive
  name.
- **A shipped plan moves to [`plans/archive/`](../plans/archive).**
  [`../plans/index.md`](../plans/index.md) is the authority on status. When its row for a
  plan flips to shipped, `git mv` the file into `archive/` in the same change and update
  every link to it; `pnpm check:doclinks` (part of `pnpm lint`) reports each link that was
  missed. Open plans (planned or partial) and the tracker files stay at the top level, so
  `docs/plans/` lists only the work that is still open.
- **`todos.md` at the repo root is the author's running list, and a finished item gets its
  checkbox checked** — `[ ]:` becomes `[x]:` as part of finishing the work, not later.
  Leave the wording, ordering and whitespace of the entry alone: it is hand-written, it is
  deliberately excluded from prettier's formatting, and reformatting it loses the author's
  own shorthand. When working through the todo list, run items that create documents
  (including plans) in subagents.
- **A plan is pressure-tested by a fresh-context agent after it is formulated and before
  the work starts.** Once `docs/plans/<name>.md` is finished, hand it to a subagent that
  has not seen the conversation that produced it and ask it to attack the plan rather than
  approve it: what does the plan assume without stating, what does it contradict in the
  code or in `docs/`, what decision does it defer, what would it cost to undo, and what
  does it leave a reader unable to act on. The reviewer must be a separate context, not a
  continuation of the author's context. The author's context already holds the reasoning
  the plan is supposed to carry on its own, so an agent that helped write it reads its own
  memory back in and cannot tell a stated decision from a remembered one.
- **The findings are then written into the plan** — each finding is either fixed or
  recorded in the plan with the reason it is wrong or deliberately out of scope. A review
  that leaves no trace in the file changes nothing, and the next reader will raise the
  same objection.

## Research

- **Research lives in [`research/`](../research).** Put any survey, investigation
  write-up, or report in `docs/research/<descriptive-name>.md` rather than at the `docs/`
  root or only in the conversation. Design docs and implementation plans keep their
  existing homes (`docs/`, `docs/plans/`).

## Documentation

- **Keep `CLAUDE.md` to a summary.** Include only what a contributor needs on hand: the
  layering, the commands, the invariants in one or two lines each, and a pointer to the
  doc that states them in full. When a section there grows past roughly a screen of
  as-shipped detail, move it under `docs/` and leave the pointer, because a `docs/` page
  is read on demand while everything in `CLAUDE.md` is carried into every session.
- **Every new `docs/` page is listed in [`../index.md`](../index.md)** with a one-line
  summary of what it covers.
- **Lint and format markdown by naming the files.** After a docs-only change run
  `pnpm exec prettier --check <the files you touched>` rather than a blanket `pnpm lint`.
  A blanket `pnpm lint` runs eslint over the whole workspace and prettier over every file
  in the repo to check a page or two, so it is slow and reports on files the change never
  touched.

## Finishing a plan

A plan is not done until it meets all of the following:

1.  1. **Audit the comments** in all code the plan touched. Fix or delete every stale,
       redundant, or over-long comment, and remove every `CLAUDENOTE:`.
2.  **Update the docs the plan affects** — the relevant file(s) under `docs/` (design,
    plan, runner notes) and `CLAUDE.md` itself, so the described architecture, commands,
    and conventions match the code as shipped.
