# Showing an editor to the user

How to put an editor in front of the author from application code — a menu entry, a command,
a click handler, an automatic open the app decides to make on its own. The pane a `view.*`
command lands in is chosen by pure rules in
[`../reference/swappingPaneEditors.md`](../reference/swappingPaneEditors.md); this page is the
other half — how to call into that machinery correctly, and what goes wrong when it is
bypassed.

<!-- toc -->

- [The rule: go through `view.*`, never through `panes.ts`](#the-rule-go-through-view-never-through-panests)
- [Two ways to reach `view.*`](#two-ways-to-reach-view)
  * [From a renderer surface: `exec`](#from-a-renderer-surface-exec)
  * [From a command, as a side effect: `ctx.host.ui`](#from-a-command-as-a-side-effect-ctxhostui)
- [Choosing `where`](#choosing-where)
- [Naming what to show: `subject`](#naming-what-to-show-subject)
- [Drawing the author's eye: `flash`](#drawing-the-authors-eye-flash)
- [Popups](#popups)
- [`view.open` vs. `view.focus`](#viewopen-vs-viewfocus)
- [Before an editor can be shown at all](#before-an-editor-can-be-shown-at-all)
- [Checklist](#checklist)

<!-- tocstop -->

## The rule: go through `view.*`, never through `panes.ts`

`panes.ts` decides which pane a given choice is routed to. It operates at a high level; it does not
know about `ScreenArea`, `switch_editor`, or `splitArea`. `apps/desktop/renderer/pathux/view.ts`
is the only file that turns a `panes.ts` answer into a mesh change, and it does three things a
caller cannot safely do by hand:

- Checks whether the editor is already open before splitting, so a second `open` becomes a
  focus instead of a duplicate pane.
- Re-solves the mesh and repaints (`settle`) after every change, and marks the pane active so
  the next command lands where this one did.
- Returns a correction sentence — `"No pane is showing Script."` — when the mesh cannot do what
  was asked. The caller has to surface that sentence to the author instead of assuming success.

Code that wants an editor on screen calls `view.open` or `view.focus` — as a command, through
`exec` or `ctx.host.ui` — and never calls `paneToUse`, `paneToShowIn`, `paneElsewhere` or
`sarea.switch_editor` directly. Two exceptions do read `panes.ts` outside `view.ts`.
`header.ts`'s move-to-window needs to know which pane is active before asking `window.new` to
copy it, and `closepane.ts`'s interactive picker needs a verdict for whichever pane is under
the pointer rather than the one pane the rules would have picked on their own. Both are
documented as callers in [`swappingPaneEditors.md`](../reference/swappingPaneEditors.md#callers).
Neither moves an editor into a pane itself; they still finish through `view.close` or
`collapsePane`.

## Two ways to reach `view.*`

### From a renderer surface: `exec`

Anything running in the renderer — a menu callback, a click handler inside an editor, a
palette entry — calls the exported `exec` from `pathux/bridge.ts`, the same path every
mutating surface in the shell uses:

```ts
import { exec, report } from '../bridge.js';

report(await exec('view.open', { editor: 'wiki', where: 'here', subject: 'wiki/history.md' }));
```

`report` says the command's own sentence in the note frame. A refusal shows the sentence, for
example "No pane is showing Script.", and a success that already produced its own visible
change shows nothing. Never assume the open worked and skip `report`. A mesh that could not
honor the request is a normal outcome rather than an error to swallow. The last pane held
something else, and there was nowhere to split.

`header.ts`'s `editorsMenu()` is the plain case — one entry per offered editor, each a bare
`view.open`:

```ts
callback: () => void exec('view.open', { editor: id }),
```

`route.ts`'s `routeFor()` is the same command reached from a click, with `where` and `subject`
computed rather than fixed:

```ts
return {
  action: 'open',
  where: winner.visible ? 'here' : 'elsewhere',
  editor: winner.editor,
  subject: subjectFor(winner.editor, req.node),
};
```

### From a command, as a side effect: `ctx.host.ui`

A command running in main that wants an editor to appear as a side effect of what it just did —
not as the whole point of the invocation — pushes the effect directly, the same shape
`view.open`'s own `run` builds:

```ts
ctx.host.ui({ type: 'view', action: 'open', editor: 'convo', where: 'elsewhere', flash: true }, ctx.origin);
```

This is what `agent.ts`'s `showConvo` does when opening a conversation the author did not ask
to see yet, what `upload.ts` does after filing a reference image, and what `pipeline.ts` and
`report.ts` do to raise their status popups when a run starts. Reach for this instead of
`exec('view.open', …)` when the open is not the command's whole job. A command whose entire
purpose is showing something belongs behind `view.open` itself, not behind a new command that
wraps it.

Do not call `ctx.host.ui` for an open the author explicitly asked to see. That case belongs to
`view.open`, which also gives the author a name to bind a key or a macro to. Reach for the
direct push only when the open is incidental to a command whose real job is something else.

## Choosing `where`

| `where` | Use it for |
| --- | --- |
| `here` (default) | The ordinary case: put the editor in the pane the author is looking at. |
| `elsewhere` | A click that must not cover what asked for it — the document tree opening an asset, an agent-initiated open that should not replace what the author is reading. Falls back to splitting only when there is no other pane. |
| `left` / `right` / `above` / `below` | An explicit split, named by the author (the palette, the agent, CDP) rather than chosen by application code — nothing in this codebase currently calls `view.open` with one of these itself. |
| `window` | A second renderer window showing the editor. Never reaches the mesh; answered in main by `window.new`. |
| `popup` | A floating window over the mesh for something transient the app decided to show — the task list when a run starts, the report analyst. Nothing the author arranged moves to make room for it. |

`here`, `elsewhere` and `popup` all check first whether the editor is already open and focus it
instead of opening a second copy. `left`, `right`, `above` and `below` do not — asking for one
of those always splits, even if the editor happens to already be visible somewhere else. Do
not pick a split direction to work around a case that should be `elsewhere`. `elsewhere` steps
around a conversation pane automatically; a hardcoded split does not.

## Naming what to show: `subject`

`view.open` and `view.focus` both take an optional `subject` — the one string that says what
the editor should show once it is there: a workspace-relative path, an asset hash, a graph
slug. It is only published if the editor named actually has a subject field —
`route.ts`'s `SUBJECT_OF` maps `wiki`, `skills` and `documents` to `docPath`, `asset` to
`assetHash`, and `gengraph` to `graphSlug`. Passing a `subject` for an editor with no entry
there is silently a no-op: the pane opens, and nothing selects.

A correction means nothing moved, so `view.open` and `view.focus` publish `subject` only when
the open or focus actually landed somewhere. `view.ts`'s `withSubject` enforces that guard, so
a caller never needs to check it.

## Drawing the author's eye: `flash`

`flash: true` outlines the pane for 600ms once the mesh has settled. It is not a `view.open`
prop — the catalog command does not expose it — because it is meant for opens the app makes on
the author's behalf, not ones the author already clicked to make happen. `agent.ts`'s
`showConvo` and `upload.ts` set it when opening the conversation after an act that did not
originate from the author looking at it; a menu entry or a document-tree click does not need
one, since the author's own action already draws their attention to the right place.

Set `flash` only from a direct `ctx.host.ui` push, never by adding it to a `view.open` call —
there is nowhere to add it, and if the sentence needs one, the open likely belongs behind
`ctx.host.ui` rather than the catalog command in the first place.

## Popups

A popup's default size is `POPUP_SIZE` (520×420) in `view.ts`, clamped to 90% of the screen.
An editor that needs more room gets an entry in `POPUP_SIZES` — `report` is `[760, 720]`
today, because a debug transcript needs more room than a task list. Add an entry there rather
than asking the author to resize a popup by hand every time it opens.

## `view.open` vs. `view.focus`

`view.open` will show the editor wherever `where` says, splitting or covering as needed, and
folds into a focus automatically when it is already showing (for `here`/`elsewhere`/`popup`).
`view.focus` never moves or covers anything — it activates the pane already showing the editor,
or refuses with `"No pane is showing <editor>."` if none does. Use `view.focus` only when the
caller already knows the editor should be on screen and just wants the pointer's attention
moved there; use `view.open` everywhere else, including the case where the caller is not sure
whether the editor is already open.

## Before an editor can be shown at all

`view.open`'s `editor` prop is `EDITOR_IDS`, generated from `apps/desktop/src/shared/editors.ts`'s
`EDITORS` list — an id not in that list is not a valid `view.open` target and the command
refuses it. An id in the list still needs a renderer class registered under the matching area
name (`registerEditor`, checked against the list at boot by `checkEditorNames`) before an open
actually shows anything; see [`desktop-app-shell.md`](../reference/desktop-app-shell.md#the-shell) for
adding a new editor from scratch. This guide assumes the editor being shown already exists.

## Checklist

- Reach `view.open`/`view.focus` through `exec` from a renderer surface, or through
  `ctx.host.ui` from a command for which the open is a side effect — never call `panes.ts`'s
  functions or `sarea.switch_editor` directly.
- Pick `where` from the table above; reach for `elsewhere` rather than a hardcoded split
  direction when the point is "don't cover what asked".
- Pass `subject` only for an editor `route.ts`'s `SUBJECT_OF` names, and expect it to be a
  silent no-op otherwise.
- Set `flash` only on a direct `ctx.host.ui` push, for an open the author did not just click
  to trigger.
- Add a `POPUP_SIZES` entry for a popup that needs more than 520×420.
- Handle (or explicitly no-op) the correction sentence a refused open returns — do not assume
  every `view.open` lands.
