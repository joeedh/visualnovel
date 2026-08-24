# Needs-approval icon next to the notification bell

Status: **shipped**

## Context

The desktop app's Document tree already computes an "Awaiting approval" group
(`apps/desktop/src/main/doctree.ts:340-409`) and `WorkspaceSession.approvable()`
(`apps/desktop/src/main/session.ts:1542-1591`) already returns, upstream-first, every asset
hash that is not yet approved — one row per picture, walking `buildSlotGraph()`
(`packages/artgen/src/slotgraph.ts`). That slot graph is *already* the right membership rule
for "not including unreachable assets other than portraits and locations": it enumerates
character portraits and location plates unconditionally
(`allCharacters`/`allLocationVariants`, `slotgraph.ts:279-283`), and restricts outfit sheets
and shots to `reachableScenes(model)` (`slotgraph.ts:285-289`). `session.approvable()` is also
already the backend the agent's `approve_assets` tool lists from
(`packages/authoring/src/approve.ts`, wired via `ApprovalControl` in
`session.ts:898-902`), so it updates correctly whenever the agent (or the palette, or CDP)
changes something — every mutating command, whoever ran it, funnels through the single
`CommandStack.onRecord` hook (`apps/desktop/src/main/index.ts:641-666`) that already exists to
file notifications.

The task is to surface that same list as a toolbar dropdown next to the notification bell,
badged with a count, ordered most-recently-added-first, that jumps to the Asset Editor on
click and stays live — reusing the bell's own architecture (`ShellState` badge count +
IPC push + popup class) rather than inventing a new one.

**What "added back when stale" means here:** approval is never force-cleared once set
(`Asset.accepted`/`Character.approvedPortrait` are never reset by prose or art-notes drift —
see `docs/reference/pipeline-contracts.md`). A previously-approved asset reappears in this list
only when it is superseded by a *new, distinct-hash* rendering (regenerate/replace), which
starts life unaccepted and so is picked up by `approvable()` on the next recompute like any
other fresh candidate. No separate staleness tracking is needed — the existing accept/gate
model already produces this behavior for free.

## Design

### Backend: ordering on top of `session.approvable()`, persisted per project

The ordering must survive a restart, so it is not kept as session-internal state — it lives in
the same place `apps/desktop/src/main/index.ts` already persists other per-project UI state
(the window layout, via `windowsKey(scope())` in `apps/desktop/src/shared/sessionkeys.ts:60`
and `getSessionStore()`).

- `apps/desktop/src/shared/sessionkeys.ts`: add `approvalOrderKey(scope: string): string`
  returning `` `pathux.${scope}.approvalOrder` ``, next to `windowsKey`.
- `WorkspaceSession.approvable()` stays as-is. Add a pure, stateless helper (exported from
  `session.ts` or a small new module) —
  `reorderApprovals(items: Approvable[], previousOrder: readonly string[]): { items: Approvable[]; order: string[] }`
  — that diffs `items` against `previousOrder`:
  - hashes in `previousOrder` still present keep their relative order (tail);
  - hashes present now but not in `previousOrder` are prepended, in the order `approvable()`
    returned them, ahead of everything already known (most-recently-surfaced batch on top);
  - hashes in `previousOrder` no longer present (approved, or the slot is gone) are dropped.
  - Keeping this pure and separate from `WorkspaceSession` (no internal mutable field) makes it
    unit-testable the same way `toApprove()` is tested in `pipeline.ts`.
- `WorkspaceSession.approvalQueue(previousOrder: readonly string[])` calls `approvable()` then
  `reorderApprovals()`, returning `{ items, order }`.

### Backend: wiring into the command hook, IPC, and the persisted key

- `apps/desktop/src/main/index.ts` holds the loaded order in a module-level variable
  `currentApprovalOrder`, loaded from `getSessionStore().get(approvalOrderKey(scope()), [])`.
  It must be (re)loaded in **two** places, not one:
  - once at boot, alongside the existing priming in `main()`;
  - **inside `switchWorkspace()`**, right where `session = null; stack = null;` are reset
    (index.ts:315-316) — a project switch must reload `currentApprovalOrder` for the *new*
    project's `scope()` before anything reads or writes it, or the previous project's order
    array leaks into the new one's key on the very next recompute (the same hazard
    `sessionkeys.ts`'s per-scope key design exists to avoid for `windowsKey`/`selectionKey`).
  - it is the single writer of `getSessionStore().set(approvalOrderKey(scope()), order)`.
- Add `handle('approval:list', async () => { const { items, order } = await
  getSession().approvalQueue(currentApprovalOrder); currentApprovalOrder = order;
  getSessionStore().set(approvalOrderKey(scope()), order); return items; })` next to the
  `notify:list` handler (line 741). (`getSessionStore().set()` already triggers its own
  `'session:changed'` broadcast via the `onChange` wiring at index.ts:543-546 — that's a
  separate, raw key/value signal from the semantic `'approval:changed'` push below; both firing
  for the same recompute is intentional, not a bug to dedupe.)
- **Do not recompute synchronously inside the awaited `onRecord` hook.** `approvable()` calls
  `loadProject(this.dir)`, a full reload/reparse of the project plus an `AssetStore` reopen —
  the same cost `pipeline.approveAndRun` already pays per round, but that command is expected
  to be slow, whereas `onRecord` (`CommandStack.ts` awaits it before `exec()` returns to *every*
  caller — `apps/commands/src/stack.ts:402`) sits on the critical path of a one-line prose edit
  too. Instead: inside `onRecord`, when `record.mutating` and a session is open, kick off the
  recompute **without awaiting it** (`void recomputeApprovals()`), and debounce it — coalesce a
  burst of rapid commands (e.g. several agent tool calls in one turn) into a single recompute
  ~150ms after the last one, the same way `SessionStore`'s own flush is debounced
  (`sessionstore.ts:118-124`, `FLUSH_DEBOUNCE_MS`). `recomputeApprovals()` does the
  `approvalQueue()` + persist + compare-hash-set-then-broadcast work described above.
  - This still satisfies "kept up to date including when the agent makes changes," since the
    debounce is short and every mutating command still schedules it — it just stops blocking
    the command's own response.
  - `broadcast` a new push channel — mirrors the existing `notify:changed` broadcast at line
    462 — only when the resulting hash *set* differs from what was last broadcast.
  - A pre-existing, unrelated hazard shared with the current `notify()`/`broadcast('command:ui',
    ...)` calls in the same hook: if a workspace switch reassigns `workspaceRoot` while an
    older command's `onRecord` is still resolving, that recompute could read/write against the
    new project's `scope()`. This plan does not fix that (it isn't new to this feature — see
    §"Plan review" below) but the debounce above narrows the window versus firing synchronously
    per command.
- `apps/desktop/src/shared/ipc.ts` (next to `'notify:list'`/`'notify:changed'` at lines
  742/781): add
  - `'approval:list': () => Approvable[]` (invoke).
  - `'approval:changed': {}` (push), broadcast with no payload — the dropdown always refetches,
    same reasoning as notifications ("a bell left counting a stale value is wrong").
  - Import `Approvable` as a type-only import added to the **existing** `import type { AgentEvent,
    AgentMode, ... } from '@vn/authoring'` block (`ipc.ts:13-21`) — not a new import statement.
    Confirmed safe: `packages/authoring/src/approve.ts` only imports `zod` and a type from
    `@vn/providers`, and `ipc.ts` already type-imports from `@vn/authoring` today, so this adds
    no new risk to the `src/shared/` browser-bundle rule. Still run `pnpm check:renderer` to
    confirm.

### Frontend: `pathux/approvals.ts` (new file, modeled on `pathux/notifications.ts`)

- Module-level `cached: Approvable[]`, `list: ApprovalList | undefined`.
- `publishNeedsApproval()`: sets `shell().ui.needsApproval = cached.length` and calls
  `shell().api.notifyChange()` — same pattern as `publishUnread()`
  (`notifications.ts:84-91`).
- `refreshApprovals()`: `cached = await api.invoke('approval:list')`, then
  `publishNeedsApproval()` and `list?.render()` — same shape as `refreshNotifications()`.
- `approvalsChanged()`: thin wrapper calling `refreshApprovals()`, called from the
  `'approval:changed'` push subscription added in `bridge.ts` next to the existing
  `'notify:changed'` subscription (`bridge.ts:369-370`).
- `openApprovals(anchor?)` / class `ApprovalList`: a `Popup` anchored under the toolbar
  button exactly like `NotificationList` (`notifications.ts:114-270`) — same `place()`/`WIDTH`
  positioning helper, same `screen.popup(...)` + scrolling `col()` body. Simpler than the bell's
  list: no filter popup, no hide/clear, no `⋯` menu — every row from `approvalQueue()` is shown,
  blocked or not, mirroring the doc tree's own "Awaiting approval" group and matching what
  `session.approvable()` already returns unfiltered. Each row is a single button:
  `[kind badge] label — slot`, with `blocked` (if set) shown as a muted note under the label,
  the same text a disabled Asset-Editor approve button shows as its tooltip
  (`action.reason` from `assetview.ts`'s `approveAction`). A blocked row is still clickable —
  the point is to let the author see *why* it's stuck, not just what's actionable now.
  A row whose `settled` flag is set (`Approvable.settled`, session.ts:1586 — a slot where some
  other candidate already won) gets its own muted note, e.g. "Another take for this slot is
  already approved — approving this one replaces it," so clicking through and approving isn't a
  silent supersede. Clicking any row closes the popup and does:
  ```ts
  exec('view.open', { editor: 'asset', where: 'active', subject: item.hash });
  ```
  reusing the existing `asset` editor's subject wiring (`SUBJECT_OF.asset = 'assetHash'` in
  `renderer/pathux/route.ts:33-38`) — the same mechanism the document tree's own
  `asset:<hash>` nodes already use, so no new navigation code is needed.
- Empty state: a plain label, "Nothing needs approval."

### Frontend: the toolbar button

In `VnHeaderEditor.rebuild()` (`apps/desktop/renderer/pathux/editors/header.ts:315-320`), add a
new button immediately before the bell:
```ts
const needsApproval = this.bar.button(
  ui.needsApproval ? `🎨 ${ui.needsApproval}` : '🎨',
  () => openApprovals(rectOf(needsApproval)),
);
needsApproval.description = ui.needsApproval
  ? `Assets waiting on approval — ${ui.needsApproval}`
  : 'No assets waiting on approval';
```
- Add `ui.needsApproval` to `ShellState` (`apps/desktop/renderer/pathux/state.ts`, next to
  `unread` at line 67), doc-commented the same way.
- Add `ui.needsApproval` to `VnHeaderEditor.stateKey()` (`header.ts:174-192`) so the bar
  rebuilds when the count changes.
- Import `openApprovals` from the new `approvals.ts`, and reuse the **existing** exported
  `rectOf` from `notifications.ts` (already imported into `header.ts:29` for the bell) rather
  than writing a second copy — it is a generic "get this button's rect" helper with nothing
  notification-specific about it.

Exact glyph (`🎨` above) is a placeholder — pick whatever reads clearly as "art needing
approval" distinct from the bell; confirm visually once running.

### Boot

- `refreshApprovals()` called once at startup alongside the existing `void
  refreshNotifications()` call site (wherever the app currently primes the bell on load —
  same file/hook), so the badge is correct before the first command runs.

## Files

- `apps/desktop/src/main/session.ts` — `approvalQueue()`, plus the pure `reorderApprovals()`
  helper.
- `apps/desktop/src/shared/sessionkeys.ts` — `approvalOrderKey()`.
- `apps/desktop/src/main/index.ts` — loading/persisting the per-project order via
  `getSessionStore()`, the `onRecord` hook addition, `approval:list` handler, boot priming.
- `apps/desktop/src/shared/ipc.ts` — new channel declarations.
- `apps/desktop/renderer/pathux/approvals.ts` — new file (list popup + refresh/push wiring).
- `apps/desktop/renderer/pathux/bridge.ts` — subscribe to `'approval:changed'`.
- `apps/desktop/renderer/pathux/state.ts` — `ShellState.needsApproval`.
- `apps/desktop/renderer/pathux/editors/header.ts` — new toolbar button + `stateKey()` entry.

## Verification

- `pnpm check` and `pnpm check:renderer` (the `Approvable` type import must stay node-free in
  `src/shared/`).
- `pnpm test` — a unit test for `reorderApprovals()` (new-hash batches prepend, approved hashes
  drop out, unaffected hashes keep relative order) plus a `sessionkeys.test.ts` case for
  `approvalOrderKey()`, alongside the existing `approvable()` tests in
  `apps/desktop/src/main/tests/session.test.ts` (around line 1380).
- `pnpm lint`.
- Run the desktop app (`pnpm vndesktop --mock`), open a project with at least one unapproved
  portrait/plate: confirm the new toolbar button shows the right count, the dropdown lists
  items with most-recently-surfaced on top (including any blocked ones, with their reason),
  clicking a row opens the Asset Editor on that asset, approving it there removes it from the
  list and decrements the badge live, and regenerating an approved asset (creating a new hash)
  puts the new take back at the top. Restart the app and confirm the order survived. Also verify
  an agent turn that approves or regenerates an asset updates the badge without any manual
  refresh.

## What shipped

Three things differ from the design above. Each was forced by the code as it stands rather
than chosen.

- **`APPROVAL_ORDER_KEY` instead of `approvalOrderKey(scope)`.** `sessionkeys.ts` no longer
  scopes a project key by workspace: `SessionState.isProjectKey` routes every `pathux.` key
  except three legacy flat ones into the open project's own `.vnstudio/session.json`. A plain
  `'pathux.approvalOrder'` is therefore already per-project, and switching projects reads the
  new project's file rather than a differently-scoped key in one shared file.
- **`where: 'elsewhere'` instead of `where: 'active'`.** `OPEN_WHERE` has no `'active'` member.
  `'elsewhere'` is what the document tree's own asset row uses.
- **The anchor helpers moved to `popup.ts`.** The review asked for `rectOf` to be reused from
  `notifications.ts` rather than copied. `place()` needed reusing as well, so `Anchor`,
  `rectOf` and `place` (renamed `placeUnder`) now live in `popup.ts`, which both lists import.

Verified live over CDP against a testkit project with six unapproved assets: the badge counts
them, the popup lists them under `AWAITING APPROVAL · 6`, a row opens the Asset editor on that
hash, `gate.approve` drops the badge to 5 without a refresh, and a hand-reversed stored order
is honoured on the next launch.

## Plan review

Pressure-tested by a fresh-context agent against the actual code (not just this plan's own
claims). Every cited file/line/API checked out as claimed, including the `Approvable`
type-import safety concern, which turned out to be a non-issue given `ipc.ts:13-21` already
type-imports from `@vn/authoring`. Findings and how each was handled:

- **Fixed — `onRecord` cost.** `approvable()` runs a full `loadProject()`; running it
  synchronously (awaited) inside `onRecord` for every mutating command, not just the
  already-slow pipeline commands, would regress the latency of routine edits. Design above now
  fires the recompute unawaited and debounced (~150ms), coalescing rapid-fire agent commands
  into one recompute rather than one per command.
- **Fixed — missing workspace-switch reload.** `currentApprovalOrder` is a plain module-level
  variable in `index.ts`, not part of `WorkspaceSession`, so nothing reloaded it on a project
  switch; it would have leaked the old project's order into the new project's persisted key.
  Design above now explicitly reloads it inside `switchWorkspace()`.
- **Fixed — `rectOf` duplication.** The plan originally implied writing a new anchor helper in
  `approvals.ts`; it now says explicitly to reuse the existing exported `rectOf` from
  `notifications.ts`.
- **Fixed — `settled` rows unhandled.** `Approvable.settled` marks a slot some other candidate
  already won; the popup design now gives a settled row its own note so approving it doesn't
  read as a silent supersede.
- **Documented, not changed — two broadcasts per recompute.** `getSessionStore().set()` already
  broadcasts `'session:changed'` on every write; the new `'approval:changed'` push is a separate,
  semantic "refetch the list" signal. Both firing is intentional and is now called out explicitly
  rather than left for an implementer to puzzle over.
- **Accepted as pre-existing, not fixed — the scope-read race during a workspace switch.** If a
  command from the old project is still resolving in `onRecord` when `switchWorkspace()`
  reassigns `workspaceRoot`, its recompute could read/write under the new project's `scope()`.
  This hazard already exists for the current `notify()`/`broadcast('command:ui', ...)` calls in
  the same hook and isn't introduced by this feature; the debounce narrows the window but does
  not close it. Not worth a larger restructure of `onRecord`'s lifecycle for this feature alone.
