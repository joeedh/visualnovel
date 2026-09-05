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
- [The panes an automatic open spares](#the-panes-an-automatic-open-spares)
- [Callers](#callers)
- [Testing](#testing)

<!-- tocstop -->

`apps/desktop/renderer/pathux/panes/panes.ts` resolves which pane a `view.*` command targets. It
uses no path.ux types and no DOM, and every function computes over a `Pane[]` array, so the pane a
command resolves to can be tested in node, without a screen or a running app.

## Where this fits

`view.*` runs in main, which has no mesh and so cannot determine which pane a command means. Main
answers optimistically, and `apps/desktop/renderer/pathux/panes/view.ts` applies the effect in the
renderer. That module calls `panes.ts` to pick a pane, and when the mesh disagrees it returns a
correction sentence: "No pane is showing Script." The full command shape is in
[`command-system.md`](command-system.md); the mesh-level behavior of `view.*` is described in
[`desktop-app-shell.md`](desktop-app-shell.md#the-shell). This page covers only `panes.ts` itself:
its inputs, its six exported functions, and who calls each one.

## The `Pane` shape

A `Pane` holds only the parts of a screen area that a choice depends on:

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
`ScreenArea` or a `ScreenArea`'s shadow root; the conversion to and from real areas stays in
`view.ts`.

## Arrangeable panes

Most functions in this file consider only the panes that the arranging rules may move, split, cover
or collapse:

```ts
function arrangeable(pane: Pane): boolean {
  return !pane.chrome && !pane.floating;
}
```

The header is "chrome" (surrounding UI rather than editor content). The author never navigates to
it, so it is never a candidate for `open`, `close` or `elsewhere`. A floating popup is on screen
and can be found by `paneShowing`, so a second popup is never opened for an editor already showing
in one. A popup takes no part in arranging the mesh, because a request to open, close or focus a
tiled editor is not a request to split, close or cover a popup.

## `NO_PANE`

`NO_PANE` is `-1`, returned rather than thrown. Every caller handles the absence of an answer
itself, through a correction sentence, a refusal, or a picker that shows nothing under the pointer.
A thrown exception would be caught and turned back into one of those.

## The functions

### `paneShowing`

```ts
function paneShowing(panes: readonly Pane[], editor: string): number
```

Returns the pane showing `editor`, or `NO_PANE`. Returns the first such pane if the author opened
two. Floating popups are included, because this reports whether the editor is on screen at all,
which is what stops `open(where='popup')` from making a second popup for an editor already in one.
A header pane is never returned, because `paneShowing` applies `!pane.chrome` to the row it
matches, even though the caller did not filter the array through `arrangeable` first.

### `paneToUse`

```ts
function paneToUse(panes: readonly Pane[]): number
```

An `open` lands in the active arrangeable pane. If the pointer is over chrome (or no arrangeable
pane is active), the `open` lands in the biggest arrangeable pane instead, because the biggest pane
is the one the author is most likely looking at. A conversation pane counts the same as any other
pane here. Closing or splitting the pane the pointer is in still acts on that pane, whether or not
that pane is showing Convo. `paneToUse` returns `NO_PANE` when the mesh has nothing arrangeable,
which happens in a window that is only chrome.

### `paneToShowIn`

```ts
function paneToShowIn(panes: readonly Pane[]): number
```

Picks the pane an automatic `open` replaces. Applies the same rule as `paneToUse`, except that
`sparing` narrows the candidates first (see [The panes an automatic open
spares](#the-panes-an-automatic-open-spares)). A click in the document tree while reading what the
agent said should not open the scene over the sentence being read, and it should not open over the
tree that was clicked either. Falls back to a spared pane when those are the only panes there are.

### `paneElsewhere`

```ts
function paneElsewhere(panes: readonly Pane[], from: number): number
```

The pane `open(where='elsewhere')` lands in is the biggest arrangeable pane that is not `from`,
after the same narrowing `paneToShowIn` applies. A click in the document tree asks for `elsewhere`,
and a double-click in Shot Coverage asks for it too, so opening an asset never replaces the tree
that named it in either direction. Returns `NO_PANE` when `from` is the only arrangeable pane. A
window with one pane has nowhere else, and the caller splits instead of calling this again.

### `paneToClose`

```ts
function paneToClose(panes: readonly Pane[]): number
```

Returns the pane that a `close` collapses. The result is `paneToUse`'s answer, unless fewer than
two panes are arrangeable, in which case the result is `NO_PANE`. A mesh containing nothing but the
header leaves the window with no editor to return to, so this function refuses rather than empty
the screen. The refusal is what lets `view.ts`'s `close` report "This is the only pane — closing it
would leave nothing." instead of collapsing the last editor.

### `paneClosable`

```ts
function paneClosable(panes: readonly Pane[], index: number): boolean
```

Reports whether the pane at `index` may be collapsed, applying the same two rules `paneToClose`
applies to the whole mesh: the pane must not be chrome, and it must not be the last arrangeable
pane. The interactive picker in `closepane.ts` checks one pane at a time, because it has to refuse
while the pointer is still moving over a candidate. `paneToClose` returns only the single pane
those rules select, and the picker overrides that selection with the pane the author points at.

## The panes an automatic open spares

```ts
const SPARED: readonly EditorId[] = ['documents', 'convo'];

function sparing(candidates: readonly Pane[]): readonly Pane[] {
  const free = candidates.filter((pane) => !SPARED.includes(pane.editor as EditorId));
  if (free.length > 0) return free;
  for (const spared of [...SPARED].reverse()) {
    const only = candidates.filter((pane) => pane.editor === spared);
    if (only.length > 0) return only;
  }
  return candidates;
}
```

Two editors are covered last, and `SPARED` lists them in order of how unlikely the rules are to
cover them, least likely first.

The document tree shows how the author reached whatever is opening, so covering it removes the list
the next click comes from. Double-clicking a shot in Shot Coverage used to break that rule: the
tree was the biggest pane that was not the strip, so the frame was placed on the tree.

Convo is the one editor whose contents the author wrote. Every other editor redraws from the
project, so covering one loses at most a scroll position. Covering a transcript mid-turn hides the
answer the author is waiting for.

`sparing` drops both from a candidate list. When that leaves nothing, it walks `SPARED` backwards
and returns the least reluctantly spared kind present. For example, a mesh of a tree and a
transcript covers the transcript. `paneToShowIn` and `paneElsewhere` therefore avoid both when
another pane is free, and use one when there is no other pane.

`paneToUse` ignores this preference on purpose. Closing a pane or splitting one always acts on the
pane the pointer is in, whether that pane shows Convo or the tree. Only `paneToShowIn` and
`paneElsewhere` apply the preference, and those two choose where an automatic open lands.

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
`Pane` arrays, and it uses no `ScreenArea`, no screen, and no path.ux. Prove a change to the rules
in this file there before checking it against a running app.
