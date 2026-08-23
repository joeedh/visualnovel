# Remembering UI state in the project

Status: **shipped**

## Context

> the complete ux state should be saved in projects not just the layout, e.g. active assets
> scenes wikie pages etc. this should be error-tolerant since the user may update the project
> repo on their own outside the desktop app.

Two claims in that sentence need separating, because only one of them is about where files
live.

**Where it is stored.** Layout _templates_ are project-owned already
(`.vnstudio/layouts/<slug>.json`, [`layout-templates-and-the-view-menu.md`](layout-templates-and-the-view-menu.md)).
The live arrangement is not: every window fact — the mesh, the selection, the applied template,
the window list and their bounds — goes into `<userConfigDir()>/desktop/session.json`, which is
install-global. `sessionkeys.ts` compensates by putting a digest of the project path into each
key (`pathux.<workspace>.window.<n>.layout`), so two projects do not overwrite each other. That
works and it is why the keys are shaped the way they are, but it makes the arrangement a fact
about this installation rather than about the project, with three consequences an author meets:

- Moving or renaming a project directory changes `workspaceScope`, so the arrangement is lost
  with no way to say what happened.
- A second install on the same machine opens the project to a default screen.
- Deleting `session.json` to clear one project's state clears every project's state.

The arrangement does not follow the project to another machine after this change either, because
the file is gitignored (see the first decision). What moves is the unit: the arrangement belongs
to a directory instead of to an install, so renaming or copying the directory carries it and
deleting it takes only that project's state with it. The shareable half of this is already
solved, by layout templates, which are committed on purpose.

**What is stored.** Four fields are remembered — `sceneId`, `shotId`, `characterId`, `docPath`.
The two that are not are `assetHash` and `taskHash`, and `state.ts` says why: both are content
hashes, so one remembered across a re-plan or a re-render names nothing. That reasoning is
right about the hash and wrong about the selection. What the author was looking at is the
picture in a slot, and `asset.info` answers both halves of the repair in one call — an unknown
hash fails, and a superseded one carries `newerTake`, the asset filling that slot now.

**Error tolerance.** A restored id can name something that no longer exists, because the author
may have deleted a scene, renamed a character or dropped a wiki page in an editor, in git, or on
another machine. Nothing today validates a restored id against what the project holds.

There is also a bug in this area that the move has to fix on the way past rather than merely
tidying. A workspace switch does not reload the renderer: the `workspace` effect calls
`refreshWorkspace()`, and `ME.scope` in `persist.ts` was read from `location.search` at load. So
after `project.open`, window 0 goes on writing project A's keys while showing project B, and
project B's own arrangement is never restored. With the scope digest gone from the keys, the
same stale window would write straight into project B's file instead.

### What already works and is not re-litigated here

- `SessionStore` is already a per-directory flat key/value store with a cross-process lock,
  per-key merge on flush, and a read that tolerates absence and corruption by answering `{}`.
  `SessionStore.open(dir)` takes the directory, so a second store needs no new class.
- `buildable()` already discards a layout naming an editor this build has not got, and
  `loadScreen` already reports failure rather than throwing.
- `layoutChanged()` already exists for a pane that changed a field of its own, and per-editor
  state rides in the same nstructjs blob. This plan adds no per-editor fields; it moves the
  blob and widens the shell selection.
- The install file keeps what is genuinely about this machine: `agent.budget` ("a decision
  about money"), `vn.notifications.filter`, and the recents list.
- The inspector already tolerates a `ui.taskHash` its status does not contain: it re-fetches
  once (`inspector.ts:89-96`) and then draws nothing.

## Decisions

**The file is `.vnstudio/session.json`, and it is gitignored.** It sits beside the layout
templates because both are UI state belonging to the project, and it is ignored because the
templates and the arrangement differ in what they are for: a template is a named thing an author
writes on purpose and shares, while the arrangement changes on every border drag. A committed
arrangement would churn `git status`, conflict on every pull, and — because `Git.writeTree` runs
`git add -A` in a scratch index, so an unignored file enters the tree — make `UndoJournal.check`
refuse every undo with "the workspace has changed since that command ran". Ignoring it also
removes the whole conflict-marker class from the read path, which is why this file needs none of
`parseLayoutFile`'s conflict handling.

The ignored line is the glob `.vnstudio/session.json*`, not the bare path.
`writeFileAtomic` writes `<path>.tmp-<hex>` beside its target and unlinks it in a `finally`, so
a bare path leaves a window in which an untracked sibling exists. The window is short, and undo
is the only thing that reads the tree during it, but a glob costs nothing.
The plan also gave `UNDO_PATHS` a matching `:(exclude).vnstudio/session.json*`, so that a project
whose `.gitignore` was edited by hand could not break undo. That entry was removed during
implementation: `git add -A` fails outright when a pathspec names an ignored file, and an exclude
pathspec counts as naming one, so the guard made every snapshot throw and left every command with
no undo point. The ignore line alone keeps the file out, and `writeScaffolding` rewrites it on
every open.

**Project keys drop the scope segment.** In a file that is already the project's, a digest of
the project path is both redundant and wrong: it is what makes moving the directory lose the
arrangement. `pathux.<scope>.window.<n>.layout` becomes `pathux.window.<n>.layout`, and
`pathux.<scope>.windows` becomes `pathux.windows`. `workspaceScope` stays, for the one-time
migration and for the write stamp below.

**A key routes on its own name, and one router answers every read and write.** `isProjectKey`
in `shared/sessionkeys.ts` is the single authority, and the rule is deliberately by prefix
rather than by enumeration: a `pathux.` key that is not one of `LEGACY_KEYS` belongs to the
project. That covers the window keys and the window list, leaves `agent.budget`,
`vn.notifications.filter` and the recents list in the install file, and answers correctly for a
`pathux.` key a later plan adds — [`needs-approval-icon-in-the-toolbar.md`](../needs-approval-icon-in-the-toolbar.md)
proposes `pathux.<scope>.approvalOrder`, which becomes `pathux.approvalOrder` and needs no
routing change.

Routing on the key alone is only true if nothing reaches a store directly, and today three
places do: `view.ts` reads and writes the template through `ctx.host.state`, and `index.ts`
reads and writes the window list through `getSessionStore()`. Both of those keys are project
keys after this change, so leaving either one direct would silently keep the template and the
window list install-global — and `view.resetLayout` in project B would re-apply project A's
template, which is the same class of bug this plan is fixing. `SessionState` (new, in main)
holds the two stores, implements `get`/`set`/`snapshot` by routing, and is what `CommandHost.state`
and every call site in `index.ts` take.

**The renderer keeps one flat snapshot.** `session:snapshot:sync` answers
`{...install.snapshot(), ...project.snapshot()}`. The two key sets are disjoint, so the merge
order matters only if they ever collide. The renderer's legacy read (`stored()`, which falls
back to the flat `pathux.layout` for window 0) is unchanged and goes on working, because the
merged snapshot still carries the install's keys.

**A window stamps its project-key writes, and main drops one that names another project.** The
`ws` parameter stays on the window URL and travels with `session:set`. A workspace switch
reloads every window, but a renderer that has not been torn down yet can still flush a debounced
write — including the `beforeunload` flush the reload itself triggers — and without a stamp
those bytes land in the newly opened project's file. Dropping them costs at most the last
`DEBOUNCE_MS` of rearranging in the project being left. The alternative, holding the closing
store open and routing late writes to it, buys back 400ms of border drag for a second live store
and an ordering rule; it is not worth it.

**A workspace switch reloads every window rather than re-applying in place.** Re-applying means
building a new screen mesh under a live one, and `loadScreen`'s own doc gives the failure:
`loadFile` unlistens and removes the old screen but does not destroy it, so a screen that still
holds its window listeners goes on answering the pointer from underneath the new one. A reload
re-runs the boot path that already restores layout, template and selection, and it is what the
comment in `switchWorkspace` ("Every window remounts") already claims happens. The switch is
already a hard boundary — the session, the command stack, the undo journal and the agent's
conversation are all dropped — so there is no renderer state worth preserving across it.

`refreshWorkspace()` is not the hook for any of this. It fires on the `undo` effect, which is
pushed after every command, and again on boot and after every scene edit; anything expensive or
one-shot hung there would run constantly.

**A project that cannot be written keeps no arrangement, and says nothing.** If
`SessionStore.open` on `.vnstudio` throws, project-key writes are dropped after one logged
warning and reads answer nothing. The alternative — falling back to the install file — would
have to invent scoped key names again, and two such projects would then overwrite each other. A
directory that cannot be written has already failed `ensureLayouts` and commit-on-save.

**The asset selection is persisted as a hash and repaired with one `asset.info`.** Saving a slot
key instead would mean resolving hash → slot at save time, and the eleven places that set
`ui.assetHash` do not know the slot. Resolution happens on the restore side, and it needs
neither a `pipeline:status` nor a plan: `exec('asset.info', {hash})` fails for a hash the
manifest no longer holds, and answers `newerTake` for one that has been superseded. So restore
writes the saved hash straight into `ShellState` — the common case paints correctly on the first
frame — and one command call afterwards clears it or moves it forward.

The asset editor cannot do this itself, and deliberately does not: `watchSlot` decides whether a
pane is holding its slot's current take at the moment it arrives on an asset, so a pane that
opens on a superseded take is one the author walked back to, and following would undo the walk.
Restore has the opposite intent, which is why the repair belongs to restore.

**`taskHash` is persisted with no repair rule.** A task hash is `sha256(kind, inputs)` and is
stable while the inputs are, so it usually restores correctly, and the one editor that reads it
already answers a miss by fetching once and drawing nothing. Inventing a slot-based repair for
it would need a previous-task record `SlotNode` does not keep.

**Only ids the workspace index can answer for are pruned.** `WorkspaceIndex` lists characters,
locations and scenes, so `sceneId` and `characterId` are checkable and `shotId` follows its
scene. `docPath` is not pruned: the doc tree caps a branch at `DEFAULT_CAP` rows and the
documents editor has a second file-tree mode, so absence from a fetched tree does not mean the
file is gone. A stale path already renders as an empty editor, which is the same outcome
pruning would produce, without the risk of clearing a valid selection.

**A restored value is only ever cleared while it is still the restored value.** Validation lands
after the first paint, so the author may have clicked something in between. Every prune and the
asset repair compare the field against what restore put there and leave anything else alone.

**The active agent thread is out of scope.** No thread id is in `ShellState` today; thread
selection arrives with the resumable-threads item in `todos.md`, which owns persisting it.

## Work

### Stage 1 — the project store and the router

`apps/desktop/src/shared/sessionkeys.ts`

- `layoutKey`, `selectionKey`, `templateKey` take `(window)` and drop the scope argument;
  `windowKeyPrefix` becomes `pathux.window.<n>.`; `windowsKey` becomes the constant
  `pathux.windows`.
- Add `isProjectKey(key)`: `pathux.`-prefixed and not in `LEGACY_KEYS`.
- Add `scopedWindowKeys(snapshot, scope)`: the install file's keys for one workspace, rewritten
  to their unscoped names. Pure, node-free, tested.

`apps/desktop/src/main/sessionstate.ts` (new) — `SessionState` over an install store and an
optional project store, with `get`, `set` and `snapshot` routing through `isProjectKey`. A write
carries the scope it was made under; one naming another project is dropped. Missing project
store means reads answer the default and writes are dropped.

`apps/desktop/src/main/index.ts`

- `openProjectStore(root)` opens `<root>/.vnstudio` inside a try/catch and hands it to the
  `SessionState`. On first open, if the project store holds no `pathux.` key, seed it from
  `scopedWindowKeys(install.snapshot(), workspaceScope(root))` and flush. The install's own keys
  are left in place, so an older build still opens the project as it did.
- `session:set` and `session:snapshot:sync` go through the router; so do `getWindowList`,
  `rememberedWindows` and `scope()`'s remaining callers.
- `switchWorkspace` closes the old project store and opens the new one before the `workspace`
  effect is broadcast. `before-quit` flushes both.
- `UNDO_PATHS` moves to `workspace.ts`, beside the ignore line that is what actually keeps the
  session file out of a snapshot.

`apps/desktop/src/main/commands/host.ts` — `CommandHost.state` narrows to the structural
`{get, set}` the commands actually use, which the existing test fake already satisfies.
`view.ts`'s `templateKeyFor` drops `workspaceScope`.

`apps/desktop/src/main/workspace.ts` — split the scaffolding that `openWorkspace` does at lines
200-214 into a writer and a committer, add `.vnstudio/session.json*` to what the writer ignores,
and call the pair from both open paths. The `whenReady` path currently calls `ensureLayouts`
alone, with a comment saying why (`index.ts:972-974`); routing it through the same pair fixes
that divergence rather than adding a second one. The `.gitignore` write is committed only when
the repo already existed and `ownsRepo` is true, on the same grounds as `.gitattributes`: a
project sitting inside somebody else's work tree is written to but never committed to, and
opening a project must not leave the worktree dirty for the open-time checkpoint to sweep up.

Renderer: `persist.ts` and anything else building a key drops the scope argument, and
`api.session.set` carries `ME.scope`. No behaviour change beyond the file the bytes land in.

Tests: `shared/tests/sessionkeys.test.ts` for `isProjectKey` and `scopedWindowKeys`;
`main/tests/sessionstate.test.ts` for routing, the stamp, seeding once, and an unwritable
directory.

### Stage 2 — the rest of the selection

- `StoredSelection` gains `assetHash` and `taskHash`; `saveSelection` writes them and
  `restoreSelection` reads them straight into `ShellState`.
- `installPersistence` watches `ui.assetHash` and `ui.taskHash` as well, or neither field is
  ever saved: the debounce is scheduled by the datapath watchers, and clicking an asset moves
  nothing else.
- `repairAsset(ui, restored)` in the renderer's boot path: one `exec('asset.info', {hash})`,
  then clear on failure or move to `newerTake`, in both cases only while `ui.assetHash` still
  holds `restored`. Pure decision half in `renderer/rules/uistate.ts` (new, with a `tests/`
  sibling) so it is tested without a live app; the call and the guard stay in the caller.
- `state.ts`'s two "not persisted" comments and `persist.ts`'s `StoredSelection` doc are
  rewritten to say what is persisted and how it is repaired.

### Stage 3 — pruning what no longer exists

`renderer/rules/uistate.ts` grows `prunedIds(restored, current, index)`, returning only the
fields to clear:

- `sceneId` cleared when `WorkspaceIndex.scenes` does not list it, `characterId` when
  `characters` does not.
- `shotId` cleared when its scene was cleared. A shot list is per scene and is not fetched at
  boot; a shot id under a scene that still exists is left to the coverage editor, which already
  draws nothing for one it cannot find.

Called once from the boot path, after the first `workspace.index()` the shell already fetches —
not from `refreshWorkspace()`, which runs after every command. Each call passes what restore
wrote, so a selection made in between survives.

### Stage 4 — a switch reloads every window

`createWindow`'s URL-building tail becomes `loadWindow(win, id, options)`, and
`switchWorkspace` calls it for every live window after the new project store is open. The
`workspace` effect stays for the windows that have not been reloaded yet. Each reloaded window
takes a fresh sync snapshot in its preload and restores the new project's layout, template and
selection through the boot path that already exists.

### Stage 5 — the documentation

- [`../reference/desktopAppState.md`](../../reference/desktopAppState.md): the storage section
  (:73-107), the boot-order list (:454), the two state tables (:425-429, :442) and the IPC table
  (:496). The worked key example is rewritten without the digest, and the new file gets its own
  row.
- [`../reference/desktop-app.md`](../../reference/desktop-app.md): the "Remembered UI state"
  section (:1517-1532) and its TOC entry, plus the template note at :436-437.
- Stale comments: `persist.ts:1-16` (which still names `.vndesktop/session.json` and calls it
  install-global), `sessionkeys.ts`'s header, `sessionstore.ts:3-7`, `view.ts:28-32`,
  `state.ts:25-37`, and `index.ts` at :322-323, :779-782, :784-788 and :955-957.

## Verification

`pnpm check`, `pnpm test`, `pnpm lint` at every stage. Live over CDP on `examples/test4`:

1. **Migration.** Launch the built app on a project that already has an arrangement in the
   install file. It opens exactly as it did, and `.vnstudio/session.json` now holds the same
   window keys.
2. Arrange two windows, select a scene, a character, a wiki page and an asset; quit; relaunch.
   Both windows return to their own arrangement and selection, and `git status` stays clean.
3. Rename the project directory and open it. The arrangement survives (this is the case the
   scope digest loses today).
4. Delete a selected scene's file outside the app, relaunch: the app opens, the scene selection
   is empty, and nothing throws.
5. Corrupt `.vnstudio/session.json` to `{`, relaunch: default screen, no hang, and the file is
   rebuilt. The warning is logged once per read of the bad file, so a boot that reseeds the
   project store logs it twice: once when the store opens, and once in the merge read the
   seeding flush does before it overwrites the file.
6. Re-render a selected shot, relaunch: the asset editor lands on the new asset rather than the
   superseded take. Then walk back to an earlier take by hand and confirm the pane stays there
   while a re-render lands, which is the behaviour `watchSlot` exists for.
7. Undo still works after a session write (the `.gitignore` line).
8. `project.open` a second project and back: each window reloads and opens into its own
   arrangement, and neither project's file has picked up the other's keys.

## Pressure test

Reviewed in a fresh context per
[`../reference/conventions.md`](../../reference/conventions.md#plans). Twelve findings came back;
each was checked against the source before being accepted.

**Fixed.**

1. `refreshWorkspace()` is not a switch hook — it runs on the `undo` effect after every command.
   Stages 3 and 4 no longer hang anything there.
2. `ctx.host.state` and `getSessionStore()` bypass any key-based routing, so the template and the
   window list would have stayed install-global. `SessionState` is the fix, and narrowing
   `CommandHost.state` is what makes a direct store reference a type error.
3. `writeFileAtomic` leaves a `.tmp-<hex>` sibling during a write, which a bare ignore line does
   not match, so the ignore entry is a glob.
4. The plan claimed a second machine would get the arrangement, which a gitignored file cannot
   do. The claim is gone from the Context and from the index row, and what does improve is
   stated instead.
5. Two restore rules had no data behind them: `SlotNode` records no previous `taskHash`, and
   `PipelineStatus` cannot tell a concept image from a deleted asset. One `asset.info` answers
   both questions directly, so `assetForSaved`, `taskForSaved`, the pending-hash machinery and
   the three `pipeline:status` call sites are all gone.
6. `ensureIgnored` is not called beside `ensureLayouts`, and an uncommitted `.gitignore` write
   at open time dirties the worktree for the open-time checkpoint. Stage 1 names both call sites
   and gates the commit on `ownsRepo`.
7. The two new selection fields had no datapath watcher, so nothing would ever have saved them.
8. A window that has not been reloaded yet can flush a debounced write into the newly opened
   project. `ws` becomes a write stamp and main drops a mismatch.
9. Stage 4's in-place rebuild risked a removed screen still answering the pointer, which
   `loadScreen`'s own doc warns about. The switch reloads windows instead.
10. There was no documentation stage. Stage 5 is one, and a migration case joins the
    verification list.
11. Pruning `docPath` against a fetched doc tree would clear valid selections, because the tree
    caps branches and has a second mode. It is not pruned.
12. `ws` was left on the URL with nothing reading it. It is the stamp in finding 8.

**Recorded rather than fixed.** The reviewer asked for the arrangement to be shared across
clones. That is what layout templates are, and they are already committed; a live arrangement
that git tracks would break undo through `Git.writeTree`, which is the first decision above.

## Found in live verification

Walking the list above on `examples/test4` turned up three defects the unit tests could not see.
All three are fixed, and each has a test or a documented rule behind it now.

1. A pane that swaps editors leaves the mesh the same shape, so `VnScreen.onLayoutChange` never
   fires and the window came back showing the editor it held before the swap. `applyView` schedules
   the save itself, on any effect the mesh did not correct.
2. Nothing announced a selection write. Every editor assigns `ui.sceneId` and its siblings as plain
   properties, and path.ux wakes a `DataPathWatcher` only from its own `setValue`, so the six
   watchers this plan installs never fired. The fields are accessors over one private record now,
   and `ShellState.onSelect` reaches `api.notifyChange`. Steps 2 and 6 appeared to pass beforehand
   only because finding 1's save was covering for them.
3. Those watchers took path.ux's default `raf` debounce, and a hidden or minimized window runs no
   animation frames, so the save stayed scheduled until the window was shown again. They are
   `immediate`; the 400 ms debounce in `schedule` is what coalescing the write costs.

## Undoing this

- The `.gitignore` line is a deliberate write into the author's repository and stays if the
  change is reverted. It is one ignored path and costs nothing to leave.
- The key rename has no reverse migration. An immediate downgrade still opens correctly, because
  the install file's keys are left in place, but the two files diverge from the first rearrange
  after that.
- `.vnstudio/session.json` becomes an on-disk format that `git status` does not show, so a
  backup that follows the repository does not carry it. That is the intended trade and is the
  same one `keys/` makes.
- Narrowing `CommandHost.state` touches every desktop command test that fakes it. The current
  fake is already structural, so the expected cost is zero, and a compile error is how any
  exception announces itself.
