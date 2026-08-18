# Conventions

How this repository is written, as opposed to what it does. Comment style, where plans and
research are filed, how documentation is kept honest, and the checklist a plan passes before
it counts as finished.

Two conventions deliberately stay in [`../CLAUDE.md`](../CLAUDE.md) rather than moving here —
**git history** (`master` is linear; a branch lands by rebasing) and **tooltips** (every
interactive element carries one). Both are rules that have to be in hand while the work is
happening, not looked up afterwards.

## Comments

- **Non-doc comments use `//`.** Doc comments use proper `/** … */` brackets. Don't use
  `/* … */` for ordinary inline commentary.
- **Non-doc comments are at most 3 lines.** A longer block comment is allowed sparingly —
  budget roughly one per 500 lines of a file — for genuinely load-bearing context that
  can't be stated in three lines.
- **Doc comments stay reasonably concise.** Say what the thing is and any non-obvious
  contract; don't restate the signature or narrate the implementation.
- **Temporary comments are marked `CLAUDENOTE:`.** Any scratch/working comment Claude
  writes gets that prefix, and all of them must be removed before the final commit of a
  plan (or at the end of the plan, whichever comes first).

## Plans

- **Plans live in [`plans/`](plans).** Any implementation plan gets written to
  `docs/plans/<descriptive-name>.md` before the work starts, and is kept up to date as the
  work proceeds — not left only in the conversation. the plan should have a properly
  descriptive name.
- **`todos.md` at the repo root is the author's running list, and a finished item gets its
  checkbox checked** — `[ ]:` becomes `[x]:` as part of finishing the work, not later. Leave
  the wording, ordering and whitespace of the entry alone: it is hand-written, it is
  deliberately outside prettier's idea of markdown, and reformatting it loses the author's
  own shorthand.  When executing the todo list items, items that create documents (including
  plans) should be executed in subagents.

## Research

- **Research lives in [`research/`](research).** Any survey, investigation
  write-up, or report goes in `docs/research/<descriptive-name>.md` — not at the `docs/`
  root and not only in the conversation. Design docs and implementation plans keep their
  existing homes (`docs/`, `docs/plans/`).

## Documentation

- **`CLAUDE.md` is the map, not the territory.** Keep it to what a contributor needs
  in-hand: the layering, the commands, the invariants in one or two lines each, and a pointer
  to the doc that states them in full. When a section there grows past roughly a screen of
  as-shipped detail, move it under `docs/` and leave the pointer — a `docs/` page is read on
  demand, whereas everything in `CLAUDE.md` is carried into every session.
- **Every new `docs/` page is listed in [`index.md`](index.md)** with a one-line
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
