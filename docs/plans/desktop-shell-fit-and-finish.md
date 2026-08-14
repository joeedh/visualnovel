# Desktop shell: fit and finish

Eight things the path.ux shell is missing, collected in `todos.md` while the app was being used
for real. None of them is architectural — they are the gaps between "the mesh renders" and "the
app is usable for an afternoon" — but three of them are genuine defects (the window will not
close, the dialogue box eats the transcript, an editor showing a file the agent just rewrote goes
on showing the old bytes) and the rest are affordances the React shell never had either.

<!-- toc -->
<!-- tocstop -->

## What's wrong

| # | Symptom | Cause |
| - | ------- | ----- |
| 1 | The app can't be exited without Ctrl-C | `beforeunload` + no `will-prevent-unload` handler |
| 2 | The stock Electron menu bar is still there | nothing ever called `Menu.setApplicationMenu` |
| 3 | The dialogue box squeezes the transcript to nothing | `.dbox` has no height bound |
| 4 | Plan/execute mode isn't visible where the agent is | the badge is in the header, not the convo pane |
| 5 | No sign the agent is working | `Convo.busy` closes the send button and says nothing |
| 6 | No model or effort picker | `agent.setModel` exists; nothing calls it, and effort isn't plumbed at all |
| 7 | An open document doesn't follow the agent's writes | the agent's writes arrive as `agent:event`, and only `onExec` was watched |
| 8 | No reload affordance | the script pane has a text button, the wiki pane has nothing |

## Decisions

**1. A blocked unload is answered, not swallowed.** `wiki.ts` registers a `beforeunload` handler
that calls `preventDefault()` while an unsaved draft exists. In a browser that raises the native
"leave site?" prompt; in Electron, a `webContents` with no `will-prevent-unload` listener
**cancels the close silently** — so the window stays up, `window-all-closed` never fires, and the
only way out is Ctrl-C. Main grows the listener the draft guard was always assuming: a modal
naming the count of unsaved documents, and `event.preventDefault()` on that event means *allow the
unload*. The draft guard itself is unchanged — it was right, it just had nobody listening.

`before-quit`'s session flush also gets a timeout. A debounced write that never settles must not be
able to wedge a quit, and losing a panel width is a smaller failure than not being able to close
the app.

**2. Deleting the menu bar takes two accelerators with it, so both come back as shell gestures.**
`Menu.setApplicationMenu(null)` removes Ctrl+Q and F12 along with the File/Edit/View scaffolding
nothing here uses. Quit returns as `Ctrl+Q` in the shell keymap and an entry in the VN STUDIO menu;
DevTools returns as F12, caught in main on `before-input-event` — the renderer cannot open its own.
Everything else the stock menu offered (reload, zoom, the Edit menu's clipboard entries) is either
wrong for this app or already handled by the focused widget.

**3. The dialogue box is bounded; the transcript is what grows.** `.convo` is
`grid-template-rows: 1fr auto`, so an unbounded `.dbox` takes the pane and the `1fr` row gets what
is left — a long narration turn cut the transcript to a couple of hundred pixels, which is what put
the plan card off screen in the first place. `.dbox .line` gets a `max-height` in `em` (so it
tracks the prose size) and its own scroll. The nameplate and the frame stay put.

**4. The mode badge goes where the agent is.** The header keeps its PLAN/EXECUTE button — it is
the shell's toggle. The convo pane's own bar grows a matching one, because the pane where you are
about to type is the pane that has to tell you whether typing will edit files.

**5. "working" is one word and a CSS animation.** No verb list, no timer, no frame-by-frame
repaint: an element built once in the stage, shown while `Convo.busy`, pulsing via `@keyframes`.
The word is literally `working` — the user asked for that specifically, and a rotating verb list
would be a second thing to maintain that says nothing the first one didn't.

**6. The model list is one list, and it lives in `@vn/types`.** `TEXT_MODELS` / `EFFORT_LEVELS` /
`supportsEffort` were in `apps/authoring` (for the REPL's `/model` and `/effort`) and
`@vn/providers` respectively; the desktop app can import neither into a browser bundle. They move
to `@vn/types`, which is the single source of truth for provider shapes and is already in the
renderer bundle. `@vn/providers` and `apps/authoring` re-export what they exported before, so
nothing downstream changes.

Effort is then plumbed the way the model already is: `WorkspaceSession.effort`, a
`chatBackendFor(modelId, keys, effort)` that matches `apps/authoring`'s, an `agent.setEffort`
command beside `agent.setModel`, and both as menus on the convo pane's bar. The effort menu is
**disabled**, with a reason, when the bound model doesn't honour it — `supportsEffort` is the one
predicate, so the REPL's warning and the pane's greyed menu are the same answer.

**7. "The files moved" is its own notification.** `bridge.ts` has `onExec` (what the shell ran) and
`onInvalidate` (something mutating happened). Neither carries *which* files, and neither sees the
agent, whose writes never pass through `exec` at all — they arrive as `agent:event` tool results
carrying `ToolResult.written`. So: `onWrote(paths)`, fed from both, and the two document editors
subscribe to that instead. The wiki pane already had the rule (reload a clean buffer, leave a dirty
one to earn its changed-underneath refusal); it just never heard about the agent's half.

Which paths concern which pane is a pure decision with a `tests/` sibling
(`src/shared/writes.ts`), not an inline predicate: the script pane has no file path of its own, so
"did that write touch the scene I am showing" has to be derived from the id.

**8. Reload is `⟳`, and it says what it discarded.** The wiki pane gets one beside Save; the script
pane's `Refresh` becomes the same glyph. Reloading over a dirty buffer drops the draft — that is
what reload means, and the alternative (refusing) leaves the author with no way to get back to
what is on disk. It is an explicit gesture, so it just says so in the footer.

## The work

1. `@vn/types`: new `textmodels.ts` — `Effort`, `TEXT_MODELS`, `EFFORT_LEVELS`, `supportsEffort`.
   `@vn/providers` re-exports; `apps/authoring/src/agent.ts` re-exports; `anthropic.ts` imports.
2. `apps/desktop/src/main/index.ts`: `Menu.setApplicationMenu(null)`, `will-prevent-unload`,
   F12 → DevTools, a bounded quit flush.
3. `apps/desktop/src/main/session.ts`: `effort` field, `setEffort`, effort into `chatBackendFor`.
4. `apps/desktop/src/main/commands/agent.ts`: `agent.setEffort`.
5. `apps/desktop/src/shared/writes.ts` + tests: `touches`, `touchesScene`.
6. `apps/desktop/renderer/pathux/bridge.ts`: `onWrote`, `setEffort`; feed it from `exec` and from
   the `agent:event` stream.
7. `apps/desktop/renderer/pathux/state.ts` + `api.ts`: `effort`.
8. `apps/desktop/renderer/pathux/keymap.ts` + `editors/header.ts`: Ctrl+Q, the Quit entry.
9. `apps/desktop/renderer/pathux/editors/convo.ts`: mode badge, model menu, effort menu, the
   working indicator.
10. `apps/desktop/renderer/styles/studio.css`: `.dbox .line` bound, `.working`.
11. `apps/desktop/renderer/pathux/editors/wiki.ts` / `script.ts`: `⟳`, and `onWrote`.
12. Docs: `docs/desktop-app.md`, `docs/command-system.md` (the new command), `CLAUDE.md`.

## As shipped

All twelve items are built. Four things the plan did not say:

- **`EFFORT_LEVELS` is a tuple, and the prop's choices are `['default', ...EFFORT_LEVELS]`.**
  `prop.oneOf` infers from a `readonly string[]` literal, so the levels had to stop being a widened
  array — and *default* is the absence of the knob rather than a level, which a prop has to be able
  to name. `agent.setEffort` maps it back to `undefined` before it reaches the session.
- **The convo bar is rebuilt off a state key, not on every update.** `` `${agentMode}|${model}|${effort}` ``
  — path.ux menus are built once, so the greyed-out effort menu (`disabled` + a `description` saying
  why) has to be re-made when the model changes under it.
- **The quit flush is bounded at 2s** (`QUIT_FLUSH_MS`), racing `sessionStore.close()` against a
  timer, then quitting either way.
- **The plan card's collapse needed `flex-shrink: 0` *and* `margin-top: auto` on the first child.**
  The auto margin is what bottom-aligns the transcript without flex alignment's unscrollable
  overflow at the start edge; both rules carry a comment saying so.

## Not in scope

- A confirm dialog for the wiki pane's reload. The footer note is the report; an author who wanted
  the draft kept can undo the file, not the buffer.
- Persisting model/effort across launches. Both are session facts today (`ShellState` holds
  neither across a restart, and `project.yaml` is where a durable default belongs).
- Watching the filesystem. Everything here follows a write the app itself observed — a file changed
  by another process outside the app still needs `⟳`, which is half of why item 8 is on the list.
