---
name: archive-plans
description: Compact docs/plans/archive/ by zipping old archived plans into a committed docs/plans/archive.zip, keeping only the N most-recently-archived plans as plain files. Extracts any still-referenced content into the referencing doc first so nothing load-bearing is lost. Use when asked to archive/compact/clean up old plans, or when docs/plans/archive/ has grown large.
---

# Archive plans

Shrink `docs/plans/archive/` to a small working set of plain `.md` files plus one committed
`docs/plans/archive.zip` holding the rest, without breaking any doc that cites an archived
plan or `pnpm check:doclinks`.

Default to keeping the **10** most recently archived plans unzipped. If the user names a
different count, use that instead.

## 1. Inventory

```bash
node .claude/skills/archive-plans/inventory.mjs --keep 10
```

This prints JSON:

- `keep` — the N most recently archived plans (by first `git log --diff-filter=A` date).
  These stay as plain files, untouched, regardless of whether anything links to them.
- `candidatesToZip` — older plans with no inbound link from outside
  `docs/plans/archive/`. Safe to zip as-is.
- `candidatesNeedingExtraction` — older plans that something outside the archive still
  links to (`backlinks` lists the referencing files). These need step 2 before they can be
  zipped.

Report the counts to the user before doing anything else.

## 2. Extract load-bearing content from referenced plans — propose, then get approval

For each entry in `candidatesNeedingExtraction`:

1. Read the plan file and each file in its `backlinks`.
2. At each backlink site, read the sentence/paragraph around the link to see what the
   reference is actually doing — usually citing a decision, an invariant, or the reason
   something is built the way it is, per
   [`docs/reference/conventions.md`](../../../docs/reference/conventions.md) and the
   pipeline-contracts pattern in `CLAUDE.md`.
3. Draft the fix: inline the load-bearing nugget as plain prose directly in the referencing
   doc (matching its existing style — see `docs/reference/proseStyle.md`), then replace the
   dead-ending link with a pointer to `docs/plans/archive/INDEX.md#<slug>` (added in step
   3), or remove the link entirely if the inline prose now makes it redundant.
4. Do **not** edit any file yet. Collect all drafted diffs for all such plans, then show
   the user the full diff set and ask for approval before touching anything. This mirrors
   the plan-review convention in `CLAUDE.md` (fresh judgment before an irreversible step) —
   here the irreversible step is zipping a plan whose only readable copy outside the zip
   was about to disappear.

Once approved, apply the edits to the referencing docs. The plan file itself is not edited
in this step — the extraction lives in the _referencing_ doc, not the plan.

## 3. Update the index

Maintain `docs/plans/archive/INDEX.md` (plain text, never zipped) as the map into the zip.
For every plan moving into the zip this run, add or update a row:

```markdown
- **<plan-file-stem>** — <one-line summary, derived from the plan's own title/opening
  paragraph, not invented> — archived <date>, in `archive.zip`
```

Keep entries sorted the same way the inventory script sorts (newest first). If a plan from
step 2 now needs a stable anchor for the referencing doc's link, use
`#<plan-file-stem>` as the slug.

## 4. Zip

Append every file in `candidatesToZip` (plus any files handled in step 2) into
`docs/plans/archive.zip`, then delete the plain `.md` files that went in. On Windows, update
an existing zip in place with:

```powershell
Compress-Archive -Path docs/plans/archive/<file1>.md,docs/plans/archive/<file2>.md -DestinationPath docs/plans/archive.zip -Update
```

`-Update` adds/replaces entries without touching what's already zipped, so this is safe to
run incrementally across multiple invocations of this skill. After confirming the files are
in the zip (`Expand-Archive -List` or similar), delete the now-zipped `.md` files with `git
rm`.

## 5. Verify

- `pnpm check:doclinks` must stay green. If it fails, something referenced a plan that got
  zipped without going through step 2 — fix the link (or pull that plan back out of the zip)
  rather than suppressing the check.
- Confirm nothing in `keep` or in step 2's referencing docs was accidentally deleted.
- Show the user a summary: how many plans zipped this run, how many remain plain, current
  size of `archive.zip`.

## Notes

- This is meant to be re-run periodically as more plans get archived — each run only
  operates on plans older than the `--keep` window that haven't been zipped yet.
- Never zip a plan that's still in the `keep` window, even if nothing links to it — recency
  is the cheap safety margin against a plan being useful again soon.
- `docs/plans/archive.zip` is a committed binary. Treat replacing/growing it like any other
  committed artifact: let the user review the diff (file count / size change) before
  committing, don't silently blow past a large size jump.
