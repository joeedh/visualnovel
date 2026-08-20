# Pressure test — `research/user-authored-macros-and-custom-actions.md`

An adversarial read of the macros report against the code as it stands (August 2026). The
report's structural instincts are good — selection-first, one confirm per macro, a root-only
verdict, placement as metadata rather than a menu document — and the parts of the command system
it leans on mostly exist under the names it uses. What does not survive is the mechanism it
picked to carry all of that: **a macro step is not a `CommandRecord`'s `invocation` string, because
`invocation` is built from *digested* props, and the report's own worked example is rejected by
`parseCommand`.** Findings below are ordered by how much design they move, and each is labelled
**(a)** wrong about the code, **(b)** right about the code but the recommendation still fails, or
**(c)** silent on something that will bite.

<!-- toc -->

- [What checks out](#what-checks-out)
- [1. `invocation` is built from digested props, so it is not replayable — and the report's whole recording story rests on it **(a)**](#1-invocation-is-built-from-digested-props-so-it-is-not-replayable--and-the-reports-whole-recording-story-rests-on-it-a)
- [2. The report's own worked example does not parse **(a)**](#2-the-reports-own-worked-example-does-not-parse-a)
- [3. "Every one that spends money, computed from the catalog" is not computable **(a)**](#3-every-one-that-spends-money-computed-from-the-catalog-is-not-computable-a)
- [4. The hazard the confirm card exists to stop is already live, and it is not the one named **(a)**](#4-the-hazard-the-confirm-card-exists-to-stop-is-already-live-and-it-is-not-the-one-named-a)
- [5. Preview-as-bracket has a wider blast radius than per-command undo, and poisons the stack it shares **(b)**](#5-preview-as-bracket-has-a-wider-blast-radius-than-per-command-undo-and-poisons-the-stack-it-shares-b)
- [6. Preview cannot force the mock path **(b)**](#6-preview-cannot-force-the-mock-path-b)
- [7. A greyed menu row is a widget change across four interaction paths, plus a theme key **(b)**](#7-a-greyed-menu-row-is-a-widget-change-across-four-interaction-paths-plus-a-theme-key-b)
- [8. Two of the three menu build sites already have names **(a)**](#8-two-of-the-three-menu-build-sites-already-have-names-a)
- [9. A macro cannot have "its own thread" without a second `Agent`, and there is no seam for one **(b)**](#9-a-macro-cannot-have-its-own-thread-without-a-second-agent-and-there-is-no-seam-for-one-b)
- [10. A macro's parked question has nowhere to land, and steals a window on the way **(b)**](#10-a-macros-parked-question-has-nowhere-to-land-and-steals-a-window-on-the-way-b)
- [11. The invocation dialog is a singleton that silently drops the second request **(b)**](#11-the-invocation-dialog-is-a-singleton-that-silently-drops-the-second-request-b)
- [12. `source: 'macro'` is one line in the type and two behaviours it does not change **(a)**](#12-source-macro-is-one-line-in-the-type-and-two-behaviours-it-does-not-change-a)
- [13. Smaller corrections and things the report is silent on](#13-smaller-corrections-and-things-the-report-is-silent-on)
- [What survives](#what-survives)

<!-- tocstop -->

## What checks out

Verified before attacking anything, so the corrections below are not read as a verdict on the
whole:

- **The undo pathspec is exactly right.** `UNDO_PATHS = ['.', ':(exclude)vngen/build',
  ':(exclude)vngen/state']` (`apps/desktop/src/main/index.ts:449`).
- **`mutating` and `confirm` are catalog fields under those names.** `CatalogEntry`
  (`packages/commands/src/catalog.ts`) carries `mutating`, `confirm`, `undoable`, `checkable`,
  `props`, `usage`, `schema`.
- **The separator/index-divergence argument is correct and load-bearing.** See §7.
- **`menu.items` is a real, public array**, and `createMenu` returns the widget
  (`vendor/path.ux/scripts/widgets/ui_menu.ts:105`, `:601-664`).
- **The object-based menu entry API does exist**, and its own doc comment calls it preferred over
  the positional form (`ui_menu.ts:46-53`).
- **`propose_plan` is refusable at dispatch.** `dispatch` branches on it by name before anything
  else (`packages/authoring/src/loop.ts:775`), and it is in `ALWAYS_LOADED` (`:244`), so refusing
  it leaves the cached prefix untouched — which is the report's actual claim.
- **`ask_user` and `ask_choice` really do converge on one `Permission.ask(form)`**, capped at
  `MAX_ASK_QUESTIONS = 4`, with `answersFor` padding and truncating (`loop.ts:207`).
- **`CommandForm` really does draw what the report needs from it** — booleans, `multiline`,
  `directory` with a Browse button, and `FormOptions.choices`
  (`apps/desktop/renderer/pathux/commandform.ts`).
- **The `-merge` precedent is real.** `LAYOUT_ATTRIBUTES_BLOCK` (`apps/desktop/src/shared/layouts.ts:286`)
  plus `conflictedPaths` refusing a mid-merge layout by name (`apps/desktop/src/main/layouts.ts`).
- **`MenuEntry.refused` exists for exactly the shape the report wants** — a precondition about
  what the entry would name (`apps/desktop/renderer/pathux/contextmenu.ts`).
- **The root-only verdict argument is sound**, and matches `CommandStack.check`'s own doc: a check
  is a report about *now*, never a gate on `run`.
- **The worked example's signatures are accurate** — `prompt.repin(hash, chunk, ref, regenerate)`
  (`apps/desktop/src/main/commands/prompt.ts:228`), `asset.suspended` with no props
  (`commands/asset.ts:36`).
- **`CommandSource` has no exhaustive switch anywhere.** Excluding a stale in-repo worktree copy,
  the type appears in three files only. The type change itself really is one line — see §12 for
  the two behavioural sites it does not cover.

## 1. `invocation` is built from digested props, so it is not replayable — and the report's whole recording story rests on it **(a)**

`CommandStack.exec` digests before it records (`packages/commands/src/stack.ts:101-111`):

```ts
// The record holds the digested props; `run` below still gets the real ones.
const recorded = await digestProps(command.props as PropSpecMap, props);
const base = { seq, id, props: recorded, invocation: formatCommand(id, recorded), … };
```

`digestProps` (`packages/commands/src/digest.ts`) replaces a `secret` prop with the literal
`'<secret>'` and a `digest: true` prop with `<sha256:…+len>`. Its module doc says so outright:

> A digested invocation is not re-executable, which is honest: replaying a whole-file overwrite
> from a log line was never the recovery path — undo is.

`redo()` says the same from the other side — it restores the post-state, *never* replaying
`invocation`.

So "recording a macro is filtering the history" is false for every command with a digested or
secret prop: `doc.write` (`commands/doc.ts:52`), `prompt.*` text (`prompt.ts:115`), `report.*`
body (`report.ts:78`), `view.saveLayout` (`view.ts:198`), and `project.setKey`
(`project.ts:76`, the one `prop.secret` in the app). A recorded step for the first four reads
`text='<sha256:abc123…+2048>'`; for the last it reads `key='<secret>'`. These are not steps that
can be replayed, edited, or even meaningfully shown to an author.

This is the report's foundation — "a macro's steps are written in the command DSL, and the DSL is
what the journal already holds." The journal holds a *redacted projection* of what ran. A recorder
must capture the pre-digest props at the call site, which means a new capture path in `exec`, not
a filter over `commands.jsonl`.

## 2. The report's own worked example does not parse **(a)**

The macro format's motivating example (report lines 117-137) ends with:

```
prompt.repin(hash=$1 chunk=$2 ref=$3 regenerate=$regenerate)
```

`Parser.value()` (`packages/commands/src/dsl.ts:105-119`) accepts a quote, `[`, `-`, a digit, or
`IDENT_START = /[A-Za-z_]/`. `$` is none of them, so every one of those four values throws
`DslError('expected a value')`. The line is not a command invocation and never was.

This is not a typo to fix — it is the design tension the report never notices. The format's whole
argument is *the step is the same string the palette prints and CDP accepts*. The moment a step
interpolates a previous node's output, it stops being a legal invocation, and either the DSL grows
an interpolation form (a change to the one grammar three hosts share) or macro steps are a
DSL-shaped-but-different language that only looks copy-pasteable. Neither is free, and the report
prices neither.

## 3. "Every one that spends money, computed from the catalog" is not computable **(a)**

`Command` (`packages/commands/src/command.ts`) carries `mutating`, `confirm`, `undoable`,
`commitsItself`, `check`, `run`. `CatalogEntry` carries the same subset. **Nothing anywhere records
cost, spend, or an API call.** The derived confirm card the report calls its trust mechanism cannot
be derived.

Worse, `confirm` tracks irreversibility and it is wrong in *both* directions as a money proxy:

- `pipeline.run` — the largest spender in the app — is deliberately **not** `confirm`, with a
  comment saying why (`commands/pipeline.ts:26-28`): every door to it is already a deliberate
  click.
- `asset.upload`, `asset.adopt`, `asset.replace`, `notify.*`, `view.deleteLayout`, `upload.*` are
  `confirm: true` and spend nothing.

Of the 14 `confirm: true` sites, only `art.generate`, `art.redraw` and `art.promote` are about
money at all. The report's own preview section then quietly falls back to a hand-kept list
(`art.generate`, `art.redraw`, `story.decomposeAll`, `prompt.condense`) — which is exactly the
rotting allow-list the companion report argues against. If money is to be computed, `Command`
needs a `spends` field and 108 commands need auditing once. That is a real and defensible move;
it is just not the free one the report claims.

## 4. The hazard the confirm card exists to stop is already live, and it is not the one named **(a)**

The report warns that "defaulting into it is how `pipeline.run(mock=false)` ends up inside a macro
that never asked". `pipeline.run` has no `confirm` to default into.

The real hole is one line (`apps/desktop/src/main/index.ts:519-521`):

```ts
// TODO(desktop): route through the renderer once a confirm dialog exists; until then a `confirm: true`
// command is reachable only from the UI's own affordances.
confirm: () => Promise.resolve(true),
```

Every caller that is not the palette's own dialog — CDP, the agent, and any future macro runner —
auto-approves *every* `confirm: true` command, including `art.generate` and `art.redraw`. A macro
runner built today inherits a silent yes on the money commands. The derived-confirm work therefore
starts with a real confirm door in main, not with a card.

## 5. Preview-as-bracket has a wider blast radius than per-command undo, and poisons the stack it shares **(b)**

The pathspec claim is right, which is precisely the problem: `UNDO_PATHS` excludes only
`vngen/build` and `vngen/state`, so **`assets/` — base art — is inside the snapshot.**
`art.generate` is explicitly `undoable: false` "because it writes new content-addressed bytes, so
there is no prior state to restore to" (`commands/art.ts:88`). A macro-level bracket reverts them
anyway. That is not a preview of a document edit; it is a deletion of bytes the per-command design
deliberately declined to touch.

Then discarding a preview corrupts the *existing* undo stack. Every per-command `pre`/`post` point
taken during the macro (`UndoJournal.capture`/`point`, `packages/commands/src/undo.ts`) describes a
tree that no longer exists, so `UndoJournal.check` refuses each of them with its own sentence — *the
workspace has changed since that command ran — undoing would discard those changes* — until the
author does enough unrelated work to push them past `prune()`'s `DEFAULT_KEEP = 50`. A long macro
can also drive its own refs past that keep window mid-run.

`restore` does exist, so "revert" is an expressible operation. It is the interaction with the
per-command journal that is unpriced.

## 6. Preview cannot force the mock path **(b)**

The report's answer to "a preview cannot un-spend money" is that preview forces mock. It cannot:

- `WorkspaceSession`'s `mock` is `readonly`, fixed at construction from the launch flag
  (`apps/desktop/src/main/session.ts`), and it is the *only* policy about whether art is real
  (`art: workspaceArtGen(workspace, { mock: this.mock })`, `:839`).
- `art.generate`, `art.redraw` and `asset.regenerate` have **no `mock` prop**. Only `pipeline.run`
  does.

Forcing mock per-invocation means adding a `mock` prop to every money command and threading a
session-level override — the per-command migration the report elsewhere argues against. Until
then, preview reverts documents and spends real money, which is the worst of both.

## 7. A greyed menu row is a widget change across four interaction paths, plus a theme key **(b)**

The report is right that `menu.items` is reachable and that the object entry API exists. It is
wrong about what filling in the gap costs.

- `MenuTemplateEntry` (`ui_menu.ts:46-53`) is `{ name, callback, hotkey?, icon?, tooltip?, id? }` —
  **no `disabled`**. `addItemExtra(text, id, hotkey, icon, add, tooltip)` (`:480`) has no such
  parameter either.
- Nothing in the widget consults a disabled flag. The keyboard walk over `this.items` (`:294-306`),
  `_onselect → cbs[id]()` (`:2022`), the focus/blur handlers, and `autoSearchMode` (`:447`, engaged
  past 15 items) would each still reach a disabled row. Four separate paths, in vendored
  submodule code.
- **The `disabled` sub-block the report points at is on the `button` style class**
  (`vendor/path.ux/scripts/core/theme.ts:58`). The `menu` class (`:258-273`) carries only
  `MenuBG`, `MenuBorder`, `MenuHighlight`, `MenuSeparator`, `MenuSpacing`, `MenuText`. Greying
  needs a new theme key and a `pnpm run gen:themes` run.

The separator half of the argument, though, **survives and is the important half**: `seperator()`
(`:882-889`) appends a bare `<div class="menuseparator">` to `this.dom` and never pushes onto
`this.items`, so item indices and template indices diverge the moment a separator appears. Look-up
by id is genuinely required, exactly as the report says.

One correction in the report's own favour: path.ux's menu is **DOM**, not canvas — `<li
class="menuitem">` with `li.title` already set for tooltips (`:601-664`), with a `<canvas>` created
only as a text-measuring scratchpad (`:524`). Greying is more available than the report argues.

## 8. Two of the three menu build sites already have names **(a)**

> the asset and script editors build their own entries inline with no name at all

There are exactly three `showContextMenu` call sites, and all three go through a named, pure
builder:

- `editors/asset.ts:551` → `menuFor(assetNode(this.shown))`
- `editors/documents.ts:546` → `menuFor(row.node)`
- `editors/script.ts:505` → `lineMenu(…)`, an exported pure function at
  `apps/desktop/renderer/pathux/script.ts:81`

`menuFor` lives at `apps/desktop/renderer/pathux/doctree.ts:228` (renderer, not main — worth
citing correctly), switches on `node.kind`, and its doc comment already states the discipline the
report proposes to introduce: *kinds with nothing to offer answer with an empty list, and are named
here rather than falling through silently.* The anchor vocabulary is essentially `DocNodeKind` plus
one script-line anchor. Stage 1 of the report's staging is mostly already done.

## 9. A macro cannot have "its own thread" without a second `Agent`, and there is no seam for one **(b)**

`WorkspaceSession.ensureAgent()` memoises a single `Agent`, and `this.convo`, `this.thread`,
`this.model`, `this.budget` are all session singletons; `permission()` records asks into
`this.convo`. So:

- Reusing the agent puts the macro node's inline prompt into the author's conversation — the exact
  opposite of the report's "keeps the author's conversation clean".
- Constructing a second `Agent` needs a second permission door, a second thread pointer, and a
  second budget, none of which `WorkspaceSession` has.
- Nothing prevents a collision. `busy()` returns the first in-flight label and its own doc says it
  is *reported rather than enforced: nothing here cancels.*

The report also treats the per-turn token budget as if it composes. It is per-`Agent` instance,
with `spent` local to one `run()` and checked between steps — so two concurrent nodes on one agent
share one ceiling and interleave their step accounting.

## 10. A macro's parked question has nowhere to land, and steals a window on the way **(b)**

`permission:ask` is consumed by the Agent/Convo editor (`apps/desktop/renderer/pathux/agent.ts:141`)
and drawn by `editors/convo.ts`. If that pane is not open, a macro's question is invisible. The
report's "floating conversation popup" is therefore a genuinely new host rendering, not a third
rendering of an existing door.

Routing is worse than unowned — it is wrong. `turnWindow` is a single module global set only inside
`handle('agent:run', …)` (`index.ts:373`, `:594`), and `askWindow` calls `target.focus()`. A macro
running in window B parks a question that focuses whichever window last started an agent turn.

Also correct to note: the desktop does **not** page through a four-question form. `editors/convo.ts`
draws all questions in one card with a single *Submit answers* button (`:642`, `:760-839`). The
`MAX_ASK_QUESTIONS = 4` half of the report's claim is right; the paging half is not.

## 11. The invocation dialog is a singleton that silently drops the second request **(b)**

```ts
export function openCommandDialog(id, overrides?, choices?, note?): void {
  if (open) return;
  open = new Dialog(id, overrides, choices, note);
}
```

(`apps/desktop/renderer/pathux/dialog.ts:114`.) A macro asking for its inputs while any dialog is
open does nothing at all — no error, no queue. And `CommandForm`'s constructor takes a
`CatalogEntry`, so drawing a macro's inputs means synthesising a fake catalog entry for a thing
that is not a command. Both are small, but the report presents the dialog as reusable as-is.

## 12. `source: 'macro'` is one line in the type and two behaviours it does not change **(a)**

The type change is trivial, as the report says. The two sites that matter are not in the type:

- `index.ts:548`: `source: record.source === 'agent' || record.source === 'cdp' ? record.source : 'ui'`.
  Every macro-run command posts a notification claiming **the author did it** — the precise
  dishonesty the new source value exists to remove.
- `index.ts:537`: `if (record.stack || (record.mutating && record.source !== 'ui')) undoRevision++;`
  — a new source silently changes undo-revision bumping.

And extending the notification vocabulary is not free either: `NOTIFICATION_SOURCES` is a zod enum
(`packages/types/src/notifications.ts:33`), and `readNotifications` drops any line
`migrateNotification` cannot parse. `notifications.jsonl` is union-merged, so an older build
reading a `macro`-sourced line **silently deletes the author's notification**.

## 13. Smaller corrections and things the report is silent on

- **(c) Anchor→prop binding is unaddressed.** `menuFor` uses a different prop name per kind:
  `subject:` for `art.generate`, `target:` for `art.setNotes`, `hash:` for `asset.*`, `slot:` for
  slot acts, `editor`/`where`/`subject` for `view.open`. Naming anchors does not say *which prop*
  of a macro's root node receives the anchor's subject. "The anchor's subject did not resolve" is
  not one refusal but one per anchor shape.
- **(c) `CommandStack.seq` restarts at 0 every process** (`stack.ts:50` — `private seq = 0`, never
  seeded from the log). `commands.jsonl` therefore carries duplicate `seq` values across sessions,
  and `refs/vn/undo/<seq>/` namespaces collide. "Filter the history into a macro" needs a stable
  selection key that does not exist.
- **(c) The journal is neither complete nor clean.** `exec`'s catch path still appends with
  `status: 'error'`, so failures are in the history a recorder would filter; refusals (`ok: false`
  before `run`) never reach the log at all. And `exec` coerces first, so a record's props carry
  every default filled in — a recorded macro would pin defaults the author never chose.
- **(c) There is no history reader in the app.** `readCommandLog`
  (`apps/desktop/src/main/commandlog.ts`) exists solely for `report.agent`, with a doc saying so:
  *provenance was written to be read by a person with a text editor. A difficult-agent report is
  the first reader in code.* "Recording a macro is filtering the history" needs a UI that does not
  exist.
- **(c) `.vnstudio/macros/` gets no `-merge` retrofit.** `LAYOUT_ATTRIBUTES_BLOCK` is written once
  at project creation (`apps/desktop/src/main/workspace.ts:278`); only the notifications line has
  an idempotent `ensureGitAttributes`. Every existing project would need one.
- **(c) An execute-mode agent node breaks the plan↔commit pairing.** `git_commit` scopes to
  `this.editedPaths` and clears them on success — "one commit per approved plan". A node that
  starts in execute mode without ever proposing a plan commits against a set no plan described.
  `setMode` (`loop.ts:471`) is public and bypasses approval, so the mechanism is there; the
  invariant it breaks is not discussed.
- **(a, minor) DSL round-trip gaps the pinned test does not cover.** `NaN` and `Infinity` format as
  barewords and reparse as *strings*; `-0` formats as `0`. `coerceProps` rejects non-finite
  numbers, so these can only arrive from a hand-written macro file — which is exactly the new
  authoring surface the report proposes.

## What survives

More than the length of this list suggests, and the surviving parts are the ones that were hardest
to attack.

**The placement design holds.** Placement as metadata carried in the macro, stores merging as a
union of directories rather than a menu document that conflicts line-for-line, shadowing by slug,
ordering only within a store, and a conflicted file refused by name — all of it has a working
precedent in layout templates, and the failure mode it avoids (a shared menu document) is real.

**The root-only verdict is right, and for the right reason.** Node 2 runs against the state node 1
produced, so checking past the root refuses macros that would have worked. That matches
`CommandStack.check`'s own framing as a report about now rather than a gate.

**The agent-node design is mostly implementable.** `propose_plan` refused at dispatch is a real,
cheap hook that leaves the cached prefix alone; the single `Permission.ask` door genuinely exists
and genuinely converges; per-node plan/execute mode has a `setMode` to hang off. What it lacks is
a second `Agent` to run in (§9) and a place to draw the question (§10).

**The menu look-up-by-id argument is correct** and would have been easy to get wrong the other way.

**"Macros ask the command system for declared outputs, not for a bridge"** — the framing the
companion report hands over — is untouched by any of the above. The seam is right. What has to
change is the substrate: a macro step is *not* a journal line, because the journal is a redacted
projection by design; and "spends money" is a field somebody has to add, not a fact the catalog
already knows.
