---
name: comment-audit
description: Audit and fix the comments in one or more source files against the repo's
    comment rules (plain declarative prose, no epigrams — CLAUDE.md ### Comments), and maintain a committed ledger of when each file was last audited. Use when asked to comment-audit files, to fix N files that haven't been comment audited, or to check which files still need a comment audit.
---

# Comment audit

Audit the comments in source files against the rules in `CLAUDE.md` **### Comments**, fix
what fails them, and record the audit in a **committed** ledger at
`.claude/comment-audit-ledger.json`. An entry stores the file's git blob hash at audit
time, so a file counts as **stale** once its content changes after the audit — independent
of commits, branches, or clocks.

Evaluate each comment in the file. Make sure you check every single comment. Do not miss a
single one. This includes doc comments normal comments file header comments etc.

## Arguments

`/comment-audit <file...>` — audit exactly these files. `/comment-audit pick <n>` — find
the n most audit-worthy files (never audited first, then stale, ranked by comment volume)
and audit those.

With no arguments, ask whether the user wants specific files or a pick, and how many.

## 1. Choose the files

For explicit files, take them as given (they must be tracked by git). Otherwise:

```bash
node .claude/skills/comment-audit/ledger.mjs pick <n>
```

Output is JSON: each candidate's path, `state` (`never` | `stale`), rough `commentLines`,
and `auditedAt` where one exists. `list [--all]` shows the whole picture (`--all` includes
`clean` files). Candidates are tracked `*.ts|tsx|js|mjs|css` files outside `vendor/`,
`examples/`, `docs/`, `templates/`, and `dist/`.

Tell the user which files were chosen and why before editing anything.

## 2. Audit each file

Read the file in full. Judge every comment — doc and inline — against `CLAUDE.md` **###
Comments**. The substance rule is **plain declarative prose, no epigrams**; the patterns
to catch are listed there (inverted syntax and personification, metaphorical equations,
fragment openers that defer the subject, double negatives, pronouns and ellipses that
point outside the sentence). Also enforce the mechanical rules: `//` for non-doc comments,
non-doc comments at most 3 lines, doc comments concise, no leftover `CLAUDENOTE:`.

While auditing, also fix comments that are stale (describe code that changed), redundant
(restate the line below), or wrongly placed. Do not touch code — comment-only edits. A
comment that is already plain and informative is left alone; rewriting for taste is not
the job.

If a comment encodes a decision you cannot verify, preserve the meaning exactly and only
fix the prose. When unsure what a comment means, say so in the report instead of guessing
a rewrite.

## 3. Verify

For each edited file, run the checks by name — never a blanket `pnpm lint`:

```bash
pnpm exec prettier --check <files>
pnpm exec eslint <files>          # skip for .css; prettier alone covers those
```

eslint doubles as a parse check that the edits did not break syntax. Comment-only edits
cannot change types or behaviour, so `pnpm check` and tests are not required — but if any
edit strayed beyond comments, run `pnpm check` too and say so.

## 4. Record

After the edits are in place (recording first would store a pre-edit blob hash and
immediately read as stale):

```bash
node .claude/skills/comment-audit/ledger.mjs record <file...>
```

Record every file that was audited, including files that needed no changes — a clean audit
is still an audit. The ledger is committed alongside the fixes; do not commit unless the
user asks, but when they do, the ledger change belongs in the same commit as the comment
fixes.

## 5. Report

Summarize per file: how many comments were rewritten, one or two representative
before/after pairs, anything flagged rather than fixed, and the verification results. Note
that the ledger was updated and where it lives.
