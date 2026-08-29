# Swapping pane editors

<!-- toc -->

- [Where this fits](#where-this-fits)
- [The `Pane` shape](#the-pane-shape)
- [Arrangeable panes](#arrangeable-panes)
- [`NO_PANE`](#no_pane)
- [The functions](#the-functions)
  * [`paneShowing`](#paneshowing)
  * [`paneToUse`](#panetouse)
  * [`paneToShowIn`](#panetoshowin)
  * [`paneElsewhere`](#paneelsewhere)
  * [`paneToClose`](#panetoclose)
  * [`paneClosable`](#paneclosable)
- [The conversation preference](#the-conversation-preference)
- [Callers](#callers)
- [Testing](#testing)

<!-- tocstop -->

`apps/desktop/renderer/pathux/panes.ts` decides which pane a `view.*` command means. It takes
no path.ux types and touches no DOM — every function is arithmetic over a `Pane[]` array — so
the choice a command makes can be tested in node, without a screen or a running app.

## Where this fits

`view.*` runs in main, which has no mesh and cannot answer "which pane is that". Main answers
optimistically and `apps/desktop/renderer/pathux/view.ts` applies the effect in the renderer,
using `panes.ts` to pick a pane and returning a correction sentence when the mesh disagrees —
"No pane is showing Script." The full command shape is in
[`command-system.md`](command-system.md); the mesh-level behavior of `view.*` is described in
[`desktop-app-shell.md`](desktop-app-shell.md#the-shell). This page covers only `panes.ts` itself:
its inputs, its six exported functions, and who calls each one.

## The `Pane` shape

A `Pane` is a screen area reduced to what a choice depends on:

```ts
interface Pane {
  editor: string; // '' for an area with no editor yet
  chrome: boolean; // the header, rather than somewhere the author navigates to
  floating: boolean; // a popup window, not a tile in the mesh
  active: boolean;
  width: number;
  height: number;
}
```

`view.ts`'s `panesOf(screen)` builds this array from the live mesh on every call, reading
`sarea.area.flag & AreaFlags.HIDDEN` for `chrome`, `sarea.floating` for `floating`, and
`screen.sareas.active === sarea` for `active`. Nothing in `panes.ts` holds a reference to a
`ScreenArea` or a ScreenArea's shadow root; the conversion to and from real areas stays in
`view.ts`.

## Arrangeable panes

Most functions in this file only consider panes the arranging rules may move, split, cover or
collapse:

```ts
function arrangeable(pane: Pane): boolean {
  return !pane.chrome && !pane.floating;
}
```

The header is chrome: it is not somewhere the author navigates to, so it is never a candidate
for `open`, `close` or `elsewhere`. A floating popup is on screen and can be found by
`paneShowing`, so a second popup is never opened for an editor already showing in one — but it
plays no part in arranging the mesh, because splitting, closing or covering a popup is not a
thing the author asked for when they asked to open, close, or focus a tiled editor.

## `NO_PANE`

`NO_PANE` is `-1`, returned rather than thrown. Every caller has something to say when there
is no answer — a correction sentence, a refusal, a picker that shows nothing under the
pointer — so a thrown exception would just be caught and turned back into one of those.

## The functions

### `paneShowing`

```ts
function paneShowing(panes: readonly Pane[], editor: string): number
```

The pane showing `editor`, or `NO_PANE`. The first, if the author opened two. Floating popups
count — the question this answers is whether the editor is on screen at all, which is what
stops `open(where='popup')` from making a second popup for an editor already in one. The
header never answers, because `paneShowing` still applies `!pane.chrome` to the row it
matches, even though the caller did not filter the array through `arrangeable` first.

### `paneToUse`

```ts
function paneToUse(panes: readonly Pane[]): number
```

The pane an `open` lands in is the active arrangeable pane. When the pointer is over chrome, or
no arrangeable pane is active, it is the biggest arrangeable pane instead, on the grounds that
it is the one the author is most likely looking at. A conversation pane is answered the same as
any other pane here. Closing or splitting the pane the pointer is in still means that pane,
whether or not it is showing Convo. `paneToUse` returns `NO_PANE` when the mesh has nothing
arrangeable — a window that is only chrome.

### `paneToShowIn`

```ts
function paneToShowIn(panes: readonly Pane[]): number
```

The pane an automatic `open` replaces. Same rule as `paneToUse`, except the candidates are
narrowed by `sparing` first (see [The conversation preference](#the-conversation-preference)):
a click in the document tree while reading what the agent said should not open the scene over
the sentence being read. Falls back to the conversation pane when it is the only pane there
is.

### `paneElsewhere`

```ts
function paneElsewhere(panes: readonly Pane[], from: number): number
```

The pane `open(where='elsewhere')` lands in: the biggest arrangeable pane that is not `from`,
after the same conversation-avoiding narrowing `paneToShowIn` applies. `elsewhere` is what a
click in the document tree asks for, so opening an asset never replaces the tree that named
it. Returns `NO_PANE` when `from` is the only arrangeable pane — a window with one pane has
nowhere else, and the caller splits instead of calling this again.

### `paneToClose`

```ts
function paneToClose(panes: readonly Pane[]): number
```

The pane a `close` collapses: `paneToUse`'s answer, unless fewer than two panes are
arrangeable, in which case `NO_PANE`. A mesh of nothing but the header is a window with no way
back, so refusing is friendlier than emptying the screen — refusing here is what lets
`view.ts`'s `close` say "This is the only pane — closing it would leave nothing." instead of
collapsing the last editor.

### `paneClosable`

```ts
function paneClosable(panes: readonly Pane[], index: number): boolean
```

Whether the pane at `index` may be collapsed, judged by the same two rules `paneToClose`
applies to the whole mesh — not chrome, and not the last arrangeable pane. `closepane.ts`'s
interactive picker needs the verdict per pane, one at a time, because it has to say no while
the pointer is still moving over a candidate; `paneToClose` only ever names the one pane the
rules would pick on their own, which the picker overrides with wherever the author points.

## The conversation preference

```ts
const SPOKEN_IN: EditorId = 'convo';

function sparing(candidates: readonly Pane[]): readonly Pane[] {
  const quiet = candidates.filter((pane) => pane.editor !== SPOKEN_IN);
  return quiet.length > 0 ? quiet : candidates;
}
```

Convo is the one editor whose contents the author wrote. Every other editor redraws from the
project, so covering it costs a scroll position at worst; covering a transcript mid-turn hides
the answer the author is waiting for. `sparing` drops conversation panes from a candidate list
unless doing so would leave nothing, so `paneToShowIn` and `paneElsewhere` step around Convo
when another pane is free and land in it anyway when it is the only pane there is.

`paneToUse` ignores this preference on purpose. Closing a pane or splitting one always means
the pane the pointer is in, whether or not it happens to be showing Convo. Only
`paneToShowIn` and `paneElsewhere`, which choose where an automatic open lands, apply the
preference.

## Callers

| Caller | Function(s) | What it needs the answer for |
| --- | --- | --- |
| `view.ts`, `open()` | `paneShowing`, `paneToUse`, `paneToShowIn`, `paneElsewhere` | Where `view.open(editor, where)` lands, per `where`. |
| `view.ts`, `focus()` | `paneShowing` | Which pane `view.focus(editor)` activates (and brings to front, if it floats). |
| `view.ts`, `close()` | `paneToClose` | Which pane `view.close` collapses. |
| `view.ts`, `flashed()` | `paneShowing` | Which pane to outline after an `open` or `focus` that asked to be noticed. |
| `route.ts`, `routeFor()` | `paneShowing` | Whether a document-tree node's claimant editor is already visible, which decides `where: 'here'` against `where: 'elsewhere'`. |
| `header.ts`, `movePaneToWindow()` | `paneToUse` | Which editor `window.new` followed by `view.close` moves into a new window. |
| `closepane.ts`, `pickPaneToClose()` | `paneClosable` | Per-pane verdict for the outline the picker draws under the pointer, and the sentence explaining a pane that may not go. |

## Testing

`apps/desktop/renderer/pathux/tests/panes.test.ts` covers all six functions against hand-built
`Pane` arrays — no `ScreenArea`, no screen, no path.ux. A change to the rules in this file
should be provable there before it is checked against a running app.
