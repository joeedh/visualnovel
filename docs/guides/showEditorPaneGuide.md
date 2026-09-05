# Showing an editor to the user

This page explains how to put an editor in front of the author from application code — a menu entry, a
command, a click handler, or an automatic open the app decides to make on its own. The pane a `view.*`
command lands in is chosen by the "pure" (side-effect-free) rules in
[`../reference/swappingPaneEditors.md`](../reference/swappingPaneEditors.md). This page covers the
other half — how to call into that machinery correctly, and what goes wrong when it is bypassed.

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
know about `ScreenArea`, `switch_editor`, or `splitArea`. `apps/desktop/renderer/pathux/panes/view.ts`
is the only file that turns a `panes.ts` answer into a mesh change, and it does three things a
caller cannot safely do by hand:

- Checks whether the editor is already open before splitting. A second `open` focuses the existing
  pane instead of creating a duplicate.
- Re-solves the mesh and repaints (`settle`) after every change, and marks the pane active so that
  the next command applies to that same pane.
- Returns a correction sentence (`"No pane is showing Script."`) when the mesh cannot carry out the
  request. The caller has to surface that sentence to the author instead of assuming success.

Code that puts an editor on screen calls `view.open` or `view.focus` (as a command, through `exec` or
`ctx.host.ui`) and never calls `paneToUse`, `paneToShowIn`, `paneElsewhere` or `sarea.switch_editor`
directly. Two exceptions do read `panes.ts` outside `view.ts`. `header.ts`'s move-to-window reads
which pane is active so that `window.new` can copy that pane, and `closepane.ts`'s interactive picker
asks for a verdict on whichever pane is under the pointer rather than on the single pane the rules
select by default. Both are documented as callers in
[`swappingPaneEditors.md`](../reference/swappingPaneEditors.md#callers). Neither moves an editor into
a pane itself; they still finish through `view.close` or `collapsePane`.

## Two ways to reach `view.*`

### From a renderer surface: `exec`

Code running in the renderer (a menu callback, a click handler inside an editor, a palette entry)
calls the exported `exec` from `pathux/bridge.ts`. Every mutating surface in the shell uses this path:

```ts
import { exec, report } from '../bridge.js';

report(await exec('view.open', { editor: 'wiki', where: 'here', subject: 'wiki/history.md' }));
```

`report` shows the command's own sentence in the note frame. A refusal shows the sentence, for example
"No pane is showing Script.", and a success that already produced its own visible change shows
nothing. Never assume the open worked and skip `report`. A request the mesh could not satisfy is a
normal outcome rather than an error to suppress. The last pane held something else, and there was
nowhere to split.

`header.ts`'s `editorsMenu()` handles the simplest case. It builds one entry per offered editor, and
each entry is a bare `view.open`:

```ts
callback: () => void exec('view.open', { editor: id }),
```

`routeFor()` in `route.ts` reaches the same command a click reaches, and it computes `where` and
`subject` rather than taking them fixed:

```ts
return {
  action: 'open',
  where: winner.visible ? 'here' : 'elsewhere',
  editor: winner.editor,
  subject: subjectFor(winner.editor, req.node),
};
```

### From a command, as a side effect: `ctx.host.ui`

A command running in main may open an editor as a side effect of what it just did (rather than as the
whole point of the invocation). Such a command pushes the effect directly, in the same shape that
`view.open`'s own `run` builds:

```ts
ctx.host.ui({ type: 'view', action: 'open', editor: 'convo', where: 'elsewhere', flash: true }, ctx.origin);
```

`agent.ts`'s `showConvo` does this when opening a conversation the author did not ask to see yet,
`upload.ts` does it after filing a reference image, and `pipeline.ts` and `report.ts` do it to raise
their status popups when a run starts. Use this instead of `exec('view.open', …)` when opening is not
the command's whole job. A command whose entire purpose is showing something belongs behind
`view.open` itself, not behind a new command that wraps it.

Do not call `ctx.host.ui` when the author explicitly asked to open a view. Use `view.open` for that
case, which also gives the author a name to bind a key or a macro to. Call `ctx.host.ui` directly only
when opening the view is incidental to a command whose real job is something else.

## Choosing `where`

| `where` | Use it for |
| --- | --- |
| `here` (default) | The ordinary case: put the editor in the pane the author is looking at. |
| `elsewhere` | A click that must not cover what asked for it — the document tree opening an asset, an agent-initiated open that should not replace what the author is reading. Falls back to splitting only when there is no other pane. |
| `left` / `right` / `above` / `below` | An explicit split, named by the author (the palette, the agent, CDP) rather than chosen by application code — nothing in this codebase currently calls `view.open` with one of these itself. |
| `window` | A second renderer window showing the editor. Never reaches the mesh; answered in main by `window.new`. |
| `popup` | A floating window over the mesh for something transient the app decided to show — the task list when a run starts, the report analyst. Nothing the author arranged moves to make room for it. |

`here`, `elsewhere` and `popup` each check whether the editor is already open and focus it instead of
opening a second copy. `left`, `right`, `above` and `below` do not. A request for one of those
directions always splits, even if the editor is already visible somewhere else. Do not pick a split
direction to work around a case that should be `elsewhere`. `elsewhere` avoids a conversation pane on
its own; a hardcoded split does not.

## Naming what to show: `subject`

`view.open` and `view.focus` both take an optional `subject`, the single string that names what the
editor should show once it is open: a workspace-relative path, an asset hash, or a graph slug. The
subject is only published if the named editor actually has a subject field. The `SUBJECT_OF` map in
route.ts maps `wiki`, `skills` and `documents` to `docPath`, `asset` to `assetHash`, and `gengraph` to
`graphSlug`. Passing a `subject` for an editor with no entry there does nothing: the pane opens and
nothing selects.

A correction moves nothing, so `view.open` and `view.focus` publish `subject` only when the open or
focus landed somewhere. `withSubject` in `view.ts` enforces that guard, so a caller does not need to
check it.

## Drawing the author's eye: `flash`

`flash: true` outlines the pane for 600ms once the mesh has settled. The flag is not a `view.open`
prop (the catalog command does not expose it), because it is meant for opens the app makes on the
author's behalf rather than opens the author clicked for. `agent.ts`'s `showConvo` and `upload.ts` set
the flag when opening the conversation after an act that did not originate from the author looking at
it; a menu entry or a document-tree click does not need the flag, since the author's own action
already draws their attention to the right place.

Set `flash` only from a direct `ctx.host.ui` push, never by adding it to a `view.open` call. A
`view.open` call has nowhere to put it, and an open that needs a flash likely belongs behind
`ctx.host.ui` rather than the catalog command in the first place.

## Popups

A popup's default size is `POPUP_SIZE` (520×420) in `view.ts`, clamped to 90% of the screen. An editor
that requires a larger popup gets an entry in `POPUP_SIZES` — `report` is `[760, 720]` today, because
a debug transcript fills more space than a task list. Add an entry there rather than asking the author
to resize a popup by hand every time it opens.

## `view.open` vs. `view.focus`

`view.open` shows the editor at the location `where` specifies, splitting or covering as needed, and
focuses the pane already showing the editor instead when the editor is on screen (for
`here`/`elsewhere`/`popup`). `view.focus` does not move or cover any pane — it activates the pane
already showing the editor, or refuses with `"No pane is showing <editor>."` if no pane shows it. Use
`view.focus` only when the caller already knows the editor is on screen and only needs focus moved
there. Use `view.open` in every other case, including when the caller does not know whether the editor
is already open.

## Before an editor can be shown at all

`view.open`'s `editor` prop is `EDITOR_IDS`, generated from `apps/desktop/src/shared/editors.ts`'s
`EDITORS` list. The command refuses an id that the list does not contain. An id in the list still
needs a renderer class registered under the matching area name (`registerEditor`, checked against the
list at boot by `checkEditorNames`) before opening it shows anything. See
[`desktop-app-shell.md`](../reference/desktop-app-shell.md#the-shell) for adding a new editor from
scratch. This guide assumes the editor being shown already exists.

## Checklist

- Call `view.open`/`view.focus` through `exec` from a renderer surface, and through `ctx.host.ui`
  from a command for which the open is a side effect. Do not call `panes.ts`'s functions or
  `sarea.switch_editor` directly.
- Pick `where` from the table above. Use `elsewhere` rather than a hardcoded split direction when
  the requirement is not to cover the caller that asked.
- Pass `subject` only for the names in an editor `route.ts`'s `SUBJECT_OF`. Passing it for any other
  name is a silent no-op.
- Set `flash` only on a direct `ctx.host.ui` push (an open the author did not just click to
  trigger).
- Add a `POPUP_SIZES` entry for a popup that needs more than 520×420.
- Handle (or explicitly no-op) the correction sentence that a refused open returns — not every
  `view.open` succeeds.
