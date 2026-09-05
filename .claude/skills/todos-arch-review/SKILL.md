---
name: todos-arch-review
description:
    Read a list of tasks (todos.md, a plan's checklist, a backlog the user pastes) and
    optionally the commits that implemented them, then write a report recommending
    architecture improvements — a high-level section on system shape and a mid-level
    section on duplication, seams and boundaries. Use when asked what the backlog says
    about the architecture, to review the architecture against the todos or against a
    range of commits, or to produce an architecture improvement report. Not a code review;
    it never reports line-level defects.
---

# Architecture review

A backlog is evidence. Each task says something about where the system resists change, and
a range of commits says what the change actually cost. This skill reads that evidence and
writes a report of recommended architecture changes.

**The standard to judge against:** architecture exists to express intent concisely in
code, so that both a human and an LLM can read a piece of the system and know what it does
and what it must not do, and so the system keeps scaling as features arrive. A
recommendation earns its place by making some future task in the list cheaper, clearer, or
safer — not by being tidier.

**This is not a code review.** No line-level defects, no naming nits, no bug hunting, no
style findings. If a finding would fit in a pull-request comment, it does not belong in
this report. Use `/code-review` for that.

## Arguments

`/todos-arch-review` — default to `todos.md` and no commit range; ask nothing.
`/todos-arch-review <file>` — read the task list from that file.
`/todos-arch-review <file> --range <gitrange>` — also analyze the commits in that range.
`/todos-arch-review --since <rev|date>` — commit range by date instead.
`/todos-arch-review --paths <prefix>...` — restrict the commit analysis to part of the
tree.

If the user pastes a task list into the conversation instead of naming a file, use that.

## 1. Read the task list

Read every task, including completed ones — a `[x]` line is a task whose implementation
cost is already knowable from the commits. Do not summarize the list back; classify it.

Group the tasks into **themes**, where a theme is a shared underlying cause rather than a
shared noun. "Three tasks about the coverage editor" is a weak theme; "three tasks that
each need one editor to refresh when another editor's command mutates state" is a strong
one, because the recommendation writes itself from the cause. Aim for five to twelve
themes; a theme with one task in it is usually noise unless that task is large.

Record for each theme: the tasks in it, and what the theme implies is missing, misplaced,
or duplicated in the system.

## 2. Analyze the commits, when a range is given

```bash
node .claude/skills/todos-arch-review/churn.mjs --range <gitrange> --top 30
node .claude/skills/todos-arch-review/churn.mjs --since "3 months ago" --path apps/desktop
```

The JSON carries `hotFiles` (files changed most often, with lines added and deleted),
`hotDirs`, `coChange` (file pairs that keep changing in the same commit, with the fraction
of either file's commits that the pair accounts for), and every commit `subject`.

Read it as evidence for the themes, not as findings on its own:

- **A hot file** is a file every feature has to pass through. Ask whether it is a genuine
  registry (one place that names things, which is good) or an accumulation point that grew
  because nothing else could hold the code.
- **A high-ratio co-change pair across a package boundary** is a seam in the wrong place:
  the boundary claims the two are independent and the history says they are not.
- **A wide commit** — one task touching many packages — is the cost of a feature that has
  no home. Note the subject and how many files it took.

Where a task in the list is already done, find its commit
(`git log --oneline --grep=<keyword>`, or match against the `subjects` array) and read the
diff's shape — how many files, how many layers — rather than its contents.

## 3. Ground each theme in the code

Before recommending anything, confirm the theme against the tree. Read `CLAUDE.md` and the
`docs/reference/` page for the area, then look at the actual code:

- `Grep` for the repeated shape a duplication finding claims exists, and count the real
  call sites. A "duplication" with two instances is a coincidence; name the sites you
  found.
- Check `docs/reference/packages.md` and the boundaries rules before proposing a package
  move — some separations exist to be enforced by lint and moving them is not free.
- Check `docs/plans/` for a plan that already proposes the change. If one exists, the
  recommendation is "execute that plan", with a pointer, not a fresh design.

A theme that does not survive this step is dropped, or demoted to an open question.

## 4. Write the report

Write to `docs/research/architecture-review-<short-slug>.md` and add it to `docs/index.md`
with a one-line summary, as `docs/reference/conventions.md` requires. Prose follows the
comment rules in `CLAUDE.md` — plain declarative sentences, no epigrams.

The report has exactly these sections:

**Header** — what was read (the task file, the commit range, how many tasks and commits),
and the date.

**High-level: system changes.** Changes to the shape of the system — what a package is
responsible for, where a boundary sits, what mechanism a class of feature should route
through, what concept is missing and how many tasks it would absorb. These are changes a
person would need to agree to before anyone starts.

**Mid-level: consolidation and seams.** Duplicated logic that should become one shared
rule, near-identical wiring that wants a helper or a declarative table, two mechanisms
doing one job where one should win, a contract stated in three places that should be
stated once, a widening signature that wants a struct. Concrete and local enough to do in
an afternoon each, but still about structure rather than lines.

There is no low-level section.

**Each recommendation is one subsection with four parts, in this order:**

1. **What to change**, in one sentence, as an imperative.
2. **The evidence** — the tasks it comes from (quote them), the files and call sites (with
   paths), the churn or co-change numbers if any.
3. **What it buys** — which tasks in the list get cheaper, and what a reader understands
   afterwards that they do not now.
4. **The cost** — what has to move, what it risks breaking, whether it is reversible. Say
   when a recommendation is expensive; a report that only lists upsides cannot be acted
   on.

Order recommendations within each section by how many tasks they unblock, most first.

Close with **Open questions** — themes that need a decision from the author before they
can become recommendations, and anything the evidence was too thin to call.

## 5. Report back

Tell the user where the report landed, the count of recommendations in each section, and
the top one from each. Run `pnpm exec prettier --check` on the two files you touched —
naming them, not a blanket `pnpm lint`. Do not commit unless asked.

## Rules that keep the report honest

- **Every recommendation cites at least one task or commit.** A finding with no evidence
  in the inputs is your taste, and belongs in the open questions section at most.
- **Do not invent tasks.** The report recommends architecture changes; it does not add
  features or reorder the user's backlog.
- **Say when the answer is no change.** A backlog whose tasks are genuinely independent is
  a sign the architecture is holding. Report that, with the reasoning, rather than
  manufacturing findings to fill the sections.
- **Count before claiming.** "Repeated everywhere" is not a finding; three named files
  are.
- **Do not touch code.** This skill reads and writes one report.
