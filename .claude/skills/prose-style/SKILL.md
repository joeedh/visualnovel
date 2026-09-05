---
name: prose-style
description: Propose a prose-style revision of one Markdown file under docs/, or CLAUDE.md, against docs/reference/proseStyle.md. Revises block by block through a model, fact-checks every change, and writes a revised copy and a diff to .prosestyle/ for a person to review. Use when asked to apply the prose rules to a document, clean up a doc's prose, or check a page against the style guide.
---

# Prose style

Run the tool. It does the work; this skill holds no rules of its own, because a rule stated here
is a rule the isolated model calls never see.

```bash
pnpm prose:style --file docs/<path>.md
```

Then tell the author the three counts it printed and the two paths. **Do not read the revised
file or the diff into your own context**, and do not paste either into the conversation.

That restriction is the point of the tool rather than a precaution. A model reproduces the style
of the prose it has just read, so the design gives each revision call one block and lets it end;
a diff carries both the original and the revision, and pulling one into this session re-creates
the exposure the whole design removes. The author reads the diff.

## What the counts mean

- `N blocks, N prose, N changed` — how much of the document was offered to the model and how much
  came back different. A high changed count is expected: this repository's documentation is
  written in the voice the rules now forbid.
- `facts: N equivalent, N drifted, N unverifiable` — the separate check that compares each changed
  block against its original. `drifted` names a block where meaning moved and is worth the
  author's attention first. `unverifiable` means the checker claimed a change it could not point
  at, which is a checker problem rather than a document one.

## Refusals

The tool takes one file, and only `CLAUDE.md` or a page under `docs/`. It declines
`docs/plans/archive/**`, `todos.md`, and the generated command tables by name. Do not work around
a refusal by copying a file somewhere it would be accepted.

Nothing is applied. The revised copy lands in `.prosestyle/`, which is gitignored, and a person
decides what to take from it.

## Other modes

- `pnpm prose:style --fixtures` measures the revision prompt against the fixture sets.
- `pnpm prose:style --audit-judge` measures the grader that the fixture run depends on.
- `--revise-model`, `--check-model` take `<route>/<model>` ids, where the route is `anthropic` or
  `openrouter`.

Background: [`docs/plans/enforcing-prose-style-without-context-poisoning.md`](../../../docs/plans/enforcing-prose-style-without-context-poisoning.md).
