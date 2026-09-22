# Merging a conflicted file: by hand, or with the agent

Status: planned. Branch `git-editor`, after
[`archive/history-pane.md`](archive/history-pane.md) has landed. Pressure-tested
2026-09-21 by a fresh-context review; its findings are folded in below, and the ones the
plan disagrees with are listed under
[Review findings not taken](#review-findings-not-taken).

The History pane's conflict view offers two whole-file answers per file waiting on a
decision, **Keep mine** and **Take theirs**, and for a text file a read-only **Open
both**. When both authors changed the same scene and both changes are wanted, neither
answer is right. [`../guides/collaborating.md`](../guides/collaborating.md) tells the
author to edit the markers out in the Script pane, and that path is unsafe today (the
parser drops the `=======` line on the first `story.*` write; see below), so the honest
way through is a text editor outside the app. This plan adds the two ways through that the
app should have had: the author edits the file with git's conflict markers in it, in
place, and saves; or the author asks the agent to do that edit, reviews it, and continues.

## What the owner has decided

Recorded here because they shape everything below and are not derivable from the code.

- **No side-by-side merge editor, and no hunk-accept widgets.** The file as git left it,
  markers and all, is the merge surface. Both versions are already in the text, at the
  point where they collide, with the collaborator's side labelled and the author's side
  labelled. An editor that shows the same thing as two or three columns and asks the
  author to click arrows between them adds a mental model without adding information.
- **The editor holds the whole file, never the conflicted hunks alone.** The lines around
  a collision are what decide it, and a hunk-only view is the merge editor above by
  another name.
- **Manual editing is the primary path, and the agent is the common one.** The by-hand
  path has to work on its own, because a merge is an authoring decision and the agent may
  be unavailable, wrong, or not wanted. The agent path is the same write, made by a
  different hand.
- **Open both goes.** With the markers editable in place it shows nothing the editor does
  not. (The History pane's review recorded a word diff for it as a follow-up; that
  follow-up is closed by removing the view.)
- **The agent path is tested against a real model**, Sonnet, over one prose collision and
  several JSON collisions, in a run where the model may ask questions and gets answers,
  and the transcripts are read by a person. The section
  [The live run](#the-live-run-a-real-model-merges-real-collisions) is that test.

## What is already true (verified 2026-09-21)

- A scene whose body holds `<<<<<<<`, `=======` and `>>>>>>>` lines **loads**:
  `sceneTextProblem` answers `undefined` for one, and for one whose conflict spans a
  `[[line: L2]]` marker so that the id appears twice. But the markers do not survive as
  text. `<<<<<<< HEAD` parses as action; `=======` parses as a Fountain `page_break`,
  which `splitScenes` drops from the scene; `>>>>>>> <sha> (<subject>)` parses as a forced
  transition with its first `>` stripped; and inside a dialogue block all three become
  dialogue lines. So any `story.*` op that re-serializes a conflicted scene today
  **silently deletes the `=======` line**, leaving the outer markers behind and the two
  sides run together. The guard below fixes a live data-loss bug, and it has to run before
  the text is parsed.
- `sceneTextProblem` answers `undefined` whenever `sceneFromDoc` is `ok`, and `ok` does
  not look at the diagnostics: a scene that marks the same line id twice
  (`duplicate_line_id`, an error) passes it. `git.restoreFile` uses it as its gate today.
- A scene has two edit routes, not one: `planSceneEdit` (every prose op, from the Script
  pane's line controls, `story.*`, the agent's `edit_scene`) and `planMarkerEdit`
  (`story.setChoice`/`setNext`/`setOutfit`, the agent's `edit_branches` and `set_outfit`).
  Two whole-file writers bypass both: `git.restoreFile` (whose `planRestore` does not call
  `syncRefusal`, so it runs mid-rebase) and the agent's `git_restore`.
- `git checkout -m -- <path>` **recreates the conflict** in a path whose resolution was
  already staged with `git add`, from the index's resolve-undo record: the markers come
  back (labelled `ours`/`theirs` rather than `HEAD`/`<sha>`) and `ls-files -u` lists the
  three stages again. So a decision on one file can be undone without giving up the whole
  sync. The record also holds the three stage blob ids, so what was decided can be read
  back from git rather than remembered.
- `git.resolve` stages the chosen side (`resolveSide` runs `add`, or `rm` when that side
  deleted the path), and `git.continueSync` refuses while any path is still unmerged in
  the index (`planContinue`) or any scene under `scenes/` still holds markers
  (`markedScene`), then stages everything and continues. A resolution that is written but
  not staged is therefore still "waiting on a decision" to Continue.
- `Git.commit` throws `InProgressError` during a rebase. The agent's `git_commit` lets it
  escape, and the loop turns a thrown error into an observation that ends "then retry the
  edit"; a `fail(...)` result is handed back as plain text with no such coda. Before
  either, the loop's own gate blocks `git_commit` whenever the workspace has validation
  errors, and a second conflicted scene is a validation error.
- `resolve_conflict` would be **M**, so in plan mode the model proposes and the author
  approves before it runs; the seeded opener is the start of that round trip, not the
  whole interaction.
- `readableConflict(path)` in `src/shared/history.ts` already says which conflicted paths
  git merged textually (not `-merge`, not a picture, not a log). `kindOf` alone cannot,
  since `storyboard` covers both the shots (merged) and the graphs (`-merge`). Both live
  in the desktop app; `@vn/git` and `@vn/authoring` cannot import them.
- `agent.editLine` and `agent.fixAsset` are the pattern for "open a conversation about
  this": a pure opener in `src/shared/agentseed.ts` (one line, quoted words elided at
  `QUOTED`, no tool names), a `check` that says why there is nothing to ask, and a run
  that opens the Convo pane with the composer seeded and **nothing sent**.
- The Wiki pane's Raw switch is a plain `textarea` over the document's source (`wk-raw`,
  `editors/wiki.ts`), so a textarea is an established editing surface in this app.
- `git.restoreFile` writes a scene verbatim through `writeFileAtomic` and everything else
  through `writeDocFile` with `DOC_WRITERS`, which is how a sheet's schema is kept.

## Design

### The conflict row

Each file waiting on a decision keeps **Keep mine** and **Take theirs**, loses **Open
both**, and gains:

- **Edit** — for a file that `readableConflict` admits **and** whose worktree copy holds
  markers: a scene, a sheet, a note, a storyboard under `vngen/work/shots/`,
  `assets/manifest.json`, `project.yaml`. Opens the file in place, below the rows, in a
  textarea holding **the whole file** as git left it in the worktree — front matter, every
  line that did not collide, and the marker blocks where they fall. **Save** writes the
  whole textarea back and marks the file decided. A `-merge` file (a layout, a graph, a
  thread log) and a picture do not get Edit: git left "ours" in the worktree with no
  markers, and there is nothing to merge by hand.
- **Ask the agent** — for the same files in the project repository. A conflicted note in a
  story bible that is its own repository gets Edit but not this, because the agent's git
  is the project's.

A decided file stays listed until Continue, greyed, with how it was decided and one
control, **Undo decision**, which recreates the conflict. How it was decided is read from
git, not remembered: the resolve-undo record holds the stage blobs, so a stage-0 blob
equal to stage 2 is "took theirs" (during a rebase `ours` is the collaborator's side),
equal to stage 3 is "kept yours", anything else is "merged", and a path with no stage 0 is
"removed". The pane does not say whether a merge was the author's or the agent's; the
conversation that did it is one click away, and an in-memory record would be wrong after a
restart. The heading's count changes to "N of M decided".

### The commands

Both new writes live in `SyncPart` beside `resolve`, follow its shape (a preview that is
the `check`, a run that repeats it), and are `commitsItself` for the reason the other
mid-rebase commands are.

- `git.writeResolution(repo, path, text)` — mutating,
  `affects: [...ANY_DOCUMENT, GIT_ROOT]`, `text` a digest prop. Refuses when no rebase is
  stopped (`NO_SYNC_STOPPED`), when the path is not waiting on a decision, when the path's
  worktree copy holds no markers (git did not merge it textually, so there is no by-hand
  merge to write), and when `resolutionProblem(path, text)` names a problem. Writes a
  scene verbatim through `writeFileAtomic` and any other document through `writeDocFile`
  with `DOC_WRITERS`, exactly as `git.restoreFile` does, then stages the path, so Continue
  sees a decided file. Answers `{ written }`. For the `wiki` role the path is translated
  to `<wikiRootRel>/<path>` before the write, as `git.restoreFile` does. This extends the
  one documented exception to "commands are the only write path for scene prose": a
  whole-file scene write from the History pane, which `git.restoreFile` already is.
- `git.undoResolution(repo, path)` — mutating, same `affects`. Refuses when no rebase is
  stopped and when the path is not a decided file of this stop (`Git.resolvedPaths()`
  names it). Runs `checkout -m -- <path>`. Answers `{ written }`. Whether a decision that
  removed the path (`resolveSide`'s `rm` branch) leaves a resolve-undo record is settled
  by Stage 1's test; if it does not, a removed file's row says "removed" and offers no
  Undo, and the plan records that.
- `git.continueSync`'s check widens: instead of scanning `scenes/` for markers, it runs
  `resolutionProblem` over every path `readableConflict` admits that changed in this stop,
  so a storyboard saved with markers still in it, or a merged scene that marks one line id
  twice, is refused by name before the replayed save can carry it. Continue also runs
  `update-index --clear-resolve-undo` before `rebase --continue`, so a later stop's
  decided list cannot name an earlier stop's files, whatever git does with the record on
  its own.
- `git.conflictText(repo, path)` — a read of the worktree file, not a stage, so the editor
  shows exactly what git wrote, labels included. It enters `paletteonly.ts` permanently,
  like `git.blob`.
- `git.restoreFile` gains the `syncRefusal` guard the other writers have, so an undoable
  whole-file write cannot land mid-rebase and be undone after Continue into a committed
  tree. The agent's `git_restore` refuses the same way through `inProgress()`.

`resolutionProblem(path, text)` lives in `@vn/model` beside `sceneTextProblem`, because it
needs the loaders and both hosts can import `@vn/model`. It classifies the path itself
(`scenes/*.md`, `characters/**.md` and `locations/**.md`, `*.json`, `project.yaml`,
anything else) rather than through `kindOf`, and answers one sentence or `undefined`:

- a scene must load **and** carry no error-severity diagnostic (`sceneLoadProblem`, a new
  stricter sibling of `sceneTextProblem` that `git.restoreFile` switches to as well);
- a sheet must parse through `characterFromDoc` / `locationFromDoc`, so the agent's
  `resolve_conflict` cannot become the raw sheet write `write_file` refuses to be;
- a `.json` file must parse as JSON, `project.yaml` as YAML;
- any other text is accepted as is.

Markers left in a scene or a note are allowed at Save, since an author may save part way
and Continue is the gate; in a JSON, YAML or sheet a marker line fails the parse anyway.

`@vn/git` gains `Git.resolvedPaths()` (`ls-files --resolve-undo`, parsed in `parse.ts`
into path plus the three stage blobs), `Git.recreateConflict(path)`, and
`Git.clearResolveUndo()`. `git.status` answers each unmerged path with whether its
worktree copy holds markers and lists the stop's decided paths with how each was decided,
so the row can offer Edit and show the decided state without a second read per file.
`RepoStatus` in `src/shared/history.ts` gains those two fields.

### The Script pane while a scene is conflicted

- `planSceneEdit` and `planMarkerEdit` in `@vn/scriptedit` both refuse when any scene the
  op reads (`op.scene` and every source of a `mergeScene`, checked before `decide`, since
  `decide` parses) holds markers, with one host-neutral sentence: "`scenes/<id>.md` is
  waiting on a merge decision; decide it before editing it." That covers the Script pane's
  line controls, `story.*`, the agent's `edit_scene`, `edit_branches` and `set_outfit`,
  and CDP, in two places that share one check. `hasConflictMarkers` moves from `@vn/git`
  to `@vn/util` (both allow-lists admit it); `session/sync.ts` re-points its import.
- The Script pane shows a conflicted scene with one notice row at the top — "This scene is
  waiting on a merge decision. Open History to decide it." with a `view.open` to the
  History pane — and leaves the text as the parser shows it. Per-line marker styling is
  not possible: the `=======` line never reaches the renderer, because the model drops it.

### The editor in the conflict view

- A `textarea.hs-resolve` in the detail column, under the rows, in the prose face for a
  scene or a note and the mono face for anything else, sized to the column and scrolling
  inside itself, with **Save** and **Cancel** beneath it. Save runs `git.writeResolution`
  with the textarea's text; Cancel closes it. Only one file is open for editing at a time.
- The textarea is filled from `git.conflictText`.
- Nothing is autosaved. A merge is committed to by pressing Save, and the pane says so in
  the footer while the editor is open: "Saving decides this file; Undo decision brings the
  markers back."
- Both marker labellings are handled: `<<<<<<< HEAD` … `>>>>>>> <sha> (<subject>)` from
  the rebase, and `<<<<<<< ours` … `>>>>>>> theirs` after an undo. The row's tooltip
  explains which side is whose in the app's words: during a rebase `HEAD`/`ours` is the
  collaborator's and the other side is the author's.

### The agent path

- `agent.mergeConflict(repo, path)` — non-mutating, in `commands/agent.ts` beside
  `agent.editLine`. Its `check` refuses when the agent is busy (`idle`), when no rebase is
  stopped, when the role is not `project`, and when the path is not a file Edit would be
  offered for. Its run opens the Convo pane (`showConvo`) and answers the seed. The
  opener, `mergeOpener` in `agentseed.ts`, is one line with the subject elided at `QUOTED`
  and no tool named: "`scenes/arrival.md` is waiting on a merge decision: my save “Theo: a
  deeper bow” collides with the saves I just got. Read it, keep what each of us meant,
  write the merged file, and do not commit." The author's subject is the stopped save's,
  which the session already has; the collaborator's save is not named, because finding it
  needs a merge base `Git` does not compute and the file's own labels already name its
  sha. Nothing is sent: the author reads the opener and presses Enter, or changes it. In
  plan mode the model then proposes and the author approves, as with any write.
- `resolve_conflict(path, text)` — a new agent tool in
  `packages/authoring/src/tools/git.ts`, **M**, no confirm: it is not destructive, because
  the sides stay in the index until Continue and **Undo decision** brings them back
  (`git_restore` confirms because nothing brings a restored file back). It refuses when
  `inProgress().rebase` is unset, when the path is not unmerged, when the worktree copy
  holds no markers, when the file was not read this conversation (the `seen` ledger
  `edit_file` uses, so the model merges what is there rather than what it remembers), and
  when `resolutionProblem` names a problem. It writes and stages the way the command does
  and reports `written`. Its description tells the model what the markers mean and which
  side is whose, since that is the one thing the model cannot infer from the file.
- `read_file` already returns the raw text with markers; nothing changes there.
- `git_commit` catches `InProgressError` and answers
  `fail("A sync is part way; the author finishes it from the History pane, so there is nothing to commit here.")`,
  which the loop hands back without its retry coda. The opener's "do not commit" is the
  first line of defence and this is the second; the loop's prompt gains no clause, since a
  clause invalidates the prompt cache for every conversation. A second conflicted file
  shows up as validation errors, and the guard above refuses any attempt to edit it, with
  the sentence that says what to do instead.
- The edit is picked up by Continue's `add -A` and lands in the replayed save, whose
  record and conversation the pane already links.
- The agent has no tool for Continue, Give up, or any other sync act. That line stands.

### What the notification says

`git.writeResolution` and `resolve_conflict` are filed like every other command outcome:
"Decided `scenes/arrival.md` by editing it." / "Decided `scenes/arrival.md`; the agent
merged both sides." `git.undoResolution`: "`scenes/arrival.md` is waiting on a decision
again." A completed Continue says what it says today.

## Stages

Each stage is green under `pnpm check`, `pnpm test`, `pnpm lint` and `pnpm build`, and
each that adds a command does what
[`archive/history-pane.md`](archive/history-pane.md#what-every-stage-that-adds-a-command-must-do)
lists: `paletteonly.ts` or a control, `pnpm gen:uxmodel`, `pnpm gen:command-table`, the
anchor sweep.

1. **Rules and commands.** `Git.resolvedPaths`, `Git.recreateConflict`,
   `Git.clearResolveUndo`, `resolutionProblem` and `sceneLoadProblem`,
   `hasConflictMarkers` moved to `@vn/util`, the guard in both planners, the notice row's
   data, `git.writeResolution`, `git.undoResolution`, `git.conflictText`, `RepoStatus`'s
   two fields, Continue's widened check, `git.restoreFile`'s guard. Tests: `packages/git`
   over a temporary conflicted repository (write, stage, undo, the labels after undo, what
   `rm` leaves in resolve-undo, and that a second stop's `resolvedPaths()` is empty after
   Continue); `@vn/model` for `resolutionProblem` over each kind, including a scene with a
   duplicated line id and a sheet with markers in its front matter; `@vn/scriptedit` for
   the guard on both planners and on a `mergeScene` whose source is conflicted; the
   affects executed tier's `SYNC_COLLIDE` gains two more colliding files that both
   projects change — a sheet and a storyboard — so `writeResolution`, `undoResolution` and
   then `resolve` run against each in that order before Continue, and Continue is seen
   refusing a storyboard saved with markers. No control yet, so the two writes enter
   `paletteonly.ts` for this commit.
2. **The pane.** The conflict row's Edit and the decided state, the textarea and Save,
   Undo decision, Open both removed (`bothOpen` and `sidesView` in `editors/history.ts`),
   the footer sentence, the Script pane's notice row. Rules and situations
   (`conflict-editing`, `conflict-decided`), `ux-model.json`, the sweep. **UX review** at
   this stage, over the two-author fixture with a real scene collision: whether the
   textarea is enough for a 300-line scene, whether the labels need translating in the
   text itself (they are not, by this plan; the tooltip does it), and whether a decided
   row reads as decided.
3. **The agent.** `mergeOpener`, `agent.mergeConflict`, `resolve_conflict`, `git_commit`'s
   catch, `git_restore`'s refusal, the row's control. Tests: the opener (pure), the
   command's check over the fixture, the tool over a temporary conflicted repository
   through the loop's tool dispatch with a scripted backend, including the unread-file
   refusal and the commit refusal's text. Then the live run below, whose results go into
   this stage's As-built note. Docs: `history-pane.md` (the conflict view section and
   "From the agent"), `command-system.md` (the second whole-file scene write from the
   pane, beside `git.restoreFile`), `vnauthor.md`'s tool table, `collaborating.md`'s "When
   both of you changed one file" (which stops telling the author to edit markers out in
   the Script pane), the plan index row.

## The live run: a real model merges real collisions

The scripted-backend tests prove the plumbing; they cannot say whether a model, handed a
file with markers and the opener, produces a merge an author would keep, or asks the
question an author would want asked. That is what the feature exists to do, so Stage 3
does not finish without a run against a real model, and the plan records what was seen.

- **The script is `scripts/merge-eval.mjs`**, run as
  `pnpm eval:merge [--model <id>] [--answer <id>|--interactive] [--case <name>]`, advisory
  and key-needing like `pnpm audit:keydocs`. It never runs in CI. It resolves the key the
  way the app does (`resolveKeys`: the env var, then `keys/`) and refuses by name when
  none resolves. The model under test defaults to `claude-sonnet-5`, because Sonnet is the
  cheapest model an author would plausibly leave the agent on, and a merge that Sonnet
  gets right is one the default configuration gets right.
- **The fixture** is built fresh under the scratch directory from `examples/mySampleRepo`
  the way the History pane's review fixture was: two clones of a bare copy, distinct
  identities, collisions made on purpose, then B pulls so its rebase stops. Each case is
  one conflicted file, and beside the fixture the script writes a short **brief** per
  case: what each author meant by their change, in two or three sentences, which is the
  answer key and the answerer's script. The cases cover the file shapes the agent will
  meet:
    - **One prose collision**: both authors change the same dialogue line in a scene, and
      one of them also inserts a line beside it, so the merge has to keep an insertion as
      well as choose or blend the wording. The brief says the two wordings were reaching
      for different things (one changed the tone, the other fixed a continuity slip), so
      the right merge is a blend, and a model that picks one side without asking has
      missed it.
    - **Several JSON collisions**, at least three, in `vngen/work/shots/<scene>.json`
      storyboards: one where both sides changed a different field of the same shot (the
      right merge keeps both, no question needed), one where both changed the same field
      (the brief is deliberately silent on which is wanted, so the right move is to ask,
      and the answerer says which), and one where one side added a shot and the other
      renumbered `nextShot`, so the merged JSON has to stay consistent as data rather than
      as text. `assets/manifest.json`, whose collisions are the ugliest, is a stretch
      case.
- **The model may ask questions, and gets answers.** Each case is a real conversation
  through `@vn/authoring`'s `Agent`, starting in plan mode with the opener
  `agent.mergeConflict` would seed, so the model proposes, may ask, and needs approval
  before it writes — the interaction the author will actually have. When a turn ends
  without `resolve_conflict` having been called, the script hands the model's closing text
  to the **answerer**, whose reply becomes the next user turn. The answerer is one of:
    - `--interactive`: a person at the terminal (the reviewer running the script), who
      reads the model's text and types the reply, including the approval words;
    - `--answer <id>` (default: `claude-sonnet-5` as well): a scratch harness in the same
      script — a second model, given only the case's brief and told to answer as the
      author in one or two sentences, to approve a plan that matches the brief with the
      author's own words, and to push back on one that does not. It is a stand-in for the
      author, not a judge; it never sees the diff. A case ends when `resolve_conflict` has
      been called, or after `MAX_TURNS` (six) exchanges, which counts as a failure.
- **What the script checks per case, without a model**: that `resolve_conflict` was called
  for the file, that the written text holds no markers, that it passes
  `resolutionProblem`, and for a storyboard that every shot id is unique and `nextShot`
  exceeds them all. It writes each case's full transcript (every turn, every tool call and
  observation, the answerer's replies) to `<scratch>/merge-eval/<date>/<case>.md`, and
  prints a summary per case: pass or fail on the checks, the number of exchanges, whether
  a question was asked, the tokens spent on each side, and a unified diff of the merge
  against each parent side.
- **What counts as passing**: every case passes the mechanical checks, and the reviewer,
  reading the transcripts, agrees that the prose merge kept both authors' intent, that the
  same-field storyboard case asked rather than guessed, that no case asked when the brief
  already answered, and that the model stopped after writing rather than trying to commit.
  A model that resolves the prose by silently taking one side fails even though the checks
  pass, and a model that asks about every case fails too; the transcripts are what those
  two judgements are made from, which is why they are written out rather than summarised.
- **Who reviews**: the person implementing Stage 3 reads every transcript once, and the
  reading is recorded, not just the checks.
- **What is recorded**: the model ids (tested and answering), the date, exchanges and
  tokens per case, which cases passed, what was asked and whether the answer was used, and
  a sentence on each failure, in Stage 3's As-built note. If Sonnet fails the prose case,
  the opener is revised first (it is the cheapest lever), then the tool's description; the
  plan does not add a bigger model as the fix.

## What it costs to undo

Two commands, one read, one tool, one guard in two planners, a notice row, and two fields
on `RepoStatus`. Removing them returns the conflict view to Keep mine / Take theirs, and
nothing on disk changes shape: a resolution is a worktree write plus `git add`, which is
what `git.resolve` already does. What does move: `hasConflictMarkers`'s import path
(`session/sync.ts`), `shared/history.ts`, `ux-model.json`, `anchors.json` and
`command-table.md` when `RepoStatus` grows; every `story.*` command and the agent's scene
tools, which gain a refusal they did not have; and `collaborating.md`, which changes its
advice. The Open both removal deletes `bothOpen` and `sidesView`; git history holds them.

## Open questions

- **Should Edit be offered for a layout after all**, as a raw JSON edit? No, by this plan:
  git wrote no markers into it, so the author would be editing one side with no sight of
  the other, and "Open both" is gone. If a reviewer wants it back for that one kind, it is
  a `readableConflict` change.
- **The textarea versus the Script pane.** The Script pane is per-line and command-driven,
  so a merge — which crosses lines and deletes marker lines — does not fit its ops; the
  textarea is the honest surface for "edit the file". If the review finds a 300-line scene
  unmanageable in a textarea, the fallback is opening the file in the Wiki pane's raw mode
  with `git.writeResolution` as its save path, which is more plumbing for the same
  surface.
- **One conversation for several files.** Not in this plan; the opener names one file, and
  a second Ask the agent on another file starts from the same conversation with a second
  opener. Batch merging can come later if it is ever wanted.

## Review findings not taken

The fresh-context review's findings are folded in above, apart from these:

- **"Merged by the agent" as a decided state.** The review is right that the pane cannot
  learn it from git or from `commands.jsonl` (the tool bypasses the registry). Rather than
  add an in-memory record, the plan drops the distinction: a decided row says "merged",
  and the conversation is linked from the pane already.
- **A loop prompt clause for the refused commit.** Replaced by `git_commit` catching
  `InProgressError` itself, so the prompt cache is not invalidated for every conversation
  and the model reads a sentence that does not end in "retry".
- **Naming the collaborator's save in the opener.** Dropped instead of adding `mergeBase`
  to `Git`; the file's own labels carry the sha, and the opener stays one line.
