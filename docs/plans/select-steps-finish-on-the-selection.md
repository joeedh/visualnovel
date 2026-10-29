# Finishing a tour's select step on the selection

Status: **planned**. Revised once, after a fresh-context pressure test; see
[Pressure test](#pressure-test).

A guided tour cannot get past a `select` step. This plan makes a `select` step finish when
the shared selection holds the subject it names, read through path.ux data paths. It also
validates the kinds a select step may name, lets the ring find a subject's row under
either of its key spellings, and fixes a stale-redraw bug found while diagnosing it.

## The fault

Observed 2026-10-28 in the running app. An agent-written tour (`show_me`) opened on a
`select` step for `item:character/susan`. Clicking the Susan row in the Documents tree ran
`view.open(editor='wiki' where='here' subject='characters/susan/character.md')` three
times (`--history` shows seq 33, 34 and 39), and the tour stayed on step 0.

The cause is in `apps/desktop/renderer/rules/tour.ts`:

- A tour advances only from `onExec` (`renderer/pathux/app/bridge.ts`), which reports
  commands. A row's own action is the `ui.publish` effect, and effects never reach
  `onExec`.
- `actionOf` returns `undefined` for a `select` step (line 48), so `satisfies` returns
  `false` for every command (line 281).
- `guide`'s select branch (lines 130–139) rings the row but sets no `awaits`, unlike a
  gesture ring. Nothing that runs can ever match.
- `rules/tests/tour.test.ts:374` asserts that a select step never advances, on the stated
  premise that it "runs nothing".

No `select` step can complete, whatever the author clicks. The three curated tours in
`src/shared/tours.ts` contain no `select` step, so only agent-written tours hit this.

## Decisions

### A select step is met when the selection holds its subject

A select step names a subject (`itemKind`, `key`). It is **met** when the shared selection
already holds that subject. The tour checks this on arriving at the step and whenever the
selection changes, and advances past a met step.

The test reads the step, not the row:

- `met` looks up the step's `itemKind` in a subject table (next section). The table names
  the one data path that identifies a subject of that kind. The step is met when that
  path's value equals the step's `key`.
- No anchor is consulted for completion. While the step is unmet, the overlay rings a row
  as described in [Where the ring goes](#where-the-ring-goes).

Why not read the ringed row's `ui.publish` props for completion, which was the first
proposal:

- An expandable row stops being a `ui.publish` once its click would change nothing. Its
  offer becomes `tree.expand` (`rules/documents.ts:404-407`) and its `item:` key
  disappears, so there would be no row left to read at the moment the step is met.
- Documents rows and task cards publish a diff against the current selection
  (`publishedBy`, `taskPublishes` in `rules/selection.ts`). An empty diff means either
  "already selected" or "selects nothing shared", and a per-row `selected` flag to tell
  them apart would only be as fresh as the pane's last redraw.
- One key can be drawn by several panes with different props. `item:scene/X` comes from
  the Documents tree, the branch cards and the diagnostics rows, and only the diagnostics
  row always clears `shotId` (`rules/diagnostics.ts:55`). The answer would depend on which
  pane registered first (`resolveItem` takes the first match).
- Nothing ties an effect offer's declared props to what its click handler writes
  (`docs/reference/command-system.md`, effects section). Making those props decide
  completion would turn any drift between them into a stuck tour.

Reading the step instead avoids all four. It also covers a subject selected from a pane
that does not draw the row, or by `view.open`'s `subject`, which a row-based test cannot
see.

### The subject table

A new module, `apps/desktop/src/shared/subjects.ts`, lists the kinds a select step may
name. Each kind maps to the data path that identifies it and to a sentence telling the
agent what its key is. The value is always the step's `key`; a kind whose selection value
cannot be read straight off its key is left out.

| Kind        | Data path        | Key                                                                    |
| ----------- | ---------------- | ---------------------------------------------------------------------- |
| `scene`     | `ui.sceneId`     | the scene id                                                           |
| `shot`      | `ui.shotId`      | the shot id as stored in `work/shots/<scene>.json`, e.g. `greet__s1`   |
| `character` | `ui.characterId` | the character id (the row highlight tests this field alone)            |
| `asset`     | `ui.assetHash`   | the asset's content hash                                               |
| `graph`     | `ui.graphSlug`   | the graph's slug, its file name under `work/graphs/`                   |
| `task`      | `ui.taskHash`    | the task hash; exactly one task, unlike the card highlight (see below) |
| `file`      | `ui.docPath`     | the workspace-relative path, with no leading `/`                       |

The paths are typed `` `ui.${Published}` `` (`Published` from `src/shared/effects.ts:80`),
so `tsgo` fails if a selection field is renamed. Nothing types them against the shell's
DataAPI (`renderer/pathux/app/api.ts:17-23`), which maps all seven today; a field added to
`PUBLISHED` and missed there would read `undefined` and never be met.

Left out, with the reason:

- **`location`.** Its row publishes the sheet's path, and the sheet's file is looked up
  from the model (`main/doctree/doctree.ts:199-202`), not derived from the location's id.
  A sheetless location publishes nothing shared at all; only the Documents pane's own
  `picked` remembers it.
- **`wiki`.** The node key is the path under the wiki directory (`doctree.ts:243-244`),
  not `ui.docPath`. An agent names the same page as `file`, with its full path.
- **`skill`.** The key is the skill's id, and its file is looked up.
- **`link`, `back`, `recent`, `wardrobe`, `prompt`.** These are `item:` keys for controls
  that lead to a subject (`apps/desktop/anchors.json` lists them). They are not subjects
  themselves.

A tour that needs one of the excluded subjects can use a `command` step instead: when the
command's control is on a different subject, the existing `wrong-subject` resolution rings
the row that selects the right one first (the `pick` guidance).

The `task` choice differs from the task cards' highlight, which lights every card about
the selected shot or character (`taskIsSelected`, `rules/selection.ts:80-87`). A step that
names one task means that task, so `ui.taskHash` is the honest test.

**Assumption: shot ids are unique across scenes.** The shots schema allows any string
(`packages/types/src/schemas.ts`, `shotsFileSchema`); namespacing as `<sceneId>__<raw>` is
the generators' convention (`packages/artgen/src/storyboard.ts`,
`packages/scriptedit/src/shotcreate.ts`), not a rule. `sceneOfShot` and Shot Coverage
already rely on it. A hand-edited shots file reusing `s1` in two scenes would make a
`shot` select step for `s1` met by either.

### Reading the selection through path.ux

The selection fields are already DataAPI paths (`renderer/pathux/app/api.ts:17-23`), and
every write to them goes through a `ShellState` setter that calls
`api.notifyChange('ui.<field>')` (`renderer/pathux/app/shell.ts:92`). That includes a
pinned pane's writes, which reach the real state through its proxy. The tour therefore
reads and watches data paths rather than importing `ShellState`:

- `pathux/tour/tour.ts` takes an injected reader, set once by the shell in the way
  `tourReadsPanes` is today:
    - `read(path)` → `api.getValue(ctx, path)`;
    - `watch(path, onChange)` → a `DataPathWatcher` over `api` and `ctx` with
      `{ debounce: 'immediate' }`, returning a function that calls its `remove()`.
- The shell builds both exactly as `pathux/app/persist.ts:262-271` already watches the
  same seven paths, including the `ctx as unknown as ContextLike` cast.
- The tour knows data paths, not field names or `ShellState`. That keeps app vocabulary
  out of the engine and matches the direction in `docs/research/ux-behaviour-model.md`,
  which reserves `StdUXMeta.valuePath` for "the data path a control publishes to".

**`immediate`, not the default `raf` debounce.** `persist.ts:259-261` states the reason: a
hidden or minimized window runs no animation frames, so a `raf`-coalesced watcher stays
dirty and never fires. For the tour this matters twice:

- A window covered by a terminal during a CDP check would otherwise never advance.
- A click on a Documents row publishes and then runs `view.open` over IPC
  (`pathux/editors/documents.ts:753-754`). If the tour's next step is that same
  `view.open`, its reply can reach `onExec` before a `raf` flush has advanced past the
  select step. `ran` ignores it, and the next step then waits for a command that already
  ran. Clicking the row again does not repeat it, because a click that changes nothing
  returns before routing (`documents.ts:734-740`).

**The callback only schedules.** An `immediate` watcher fires synchronously on the write,
and `subscribe()` calls `markDirty()`, which fires it inside `subscribe()` itself
(`vendor/path.ux/scripts/path-controller/controller/pathwatch.ts:330, 358-361`) — that is,
inside the tour's own `step()`. So the callback does nothing but `queueMicrotask` a check:
if the tour is still on the same step and the step is met, move to the next one. The
microtask runs after the click handler returns, before any IPC reply, and never inside the
overlay's synchronous `ask`.

The watcher registry holds only weak references, so `tour.ts` keeps the watcher it creates
and removes it when the step changes or the tour stops.

### Where the advance happens

The tour advances past a select step in exactly two places:

- **On arrival.** `step()` moves past every met step before showing one. The loop is a
  pure function in `rules/tour.ts`, `skipMet(state, read)`, so it can be unit-tested.
- **From the watcher's microtask,** for the path of the step currently shown.

It never advances inside the overlay's re-resolve. `overlay.ts:126-139` calls `ask()`
(that is, `showingNow`) and then writes the banner and `key` after it returns. If `ask`
finished the tour, `stop()` → `unfollow()` would run in the middle of that, and
`reresolve` would then turn the banner back on with no timer left to clear it.

`satisfies` keeps returning `false` for a select step, since no command completes one. The
test at `tour.test.ts:374` keeps its assertion and loses the wrong premise in its name.

### Where the ring goes

`guide` rings a select step's row by its exact key (`resolveItem`,
`rules/anchors.ts:393-401`). Two kinds often have no row under that key:

- **`shot`.** The Documents tree keys a shot row `item:shot/<sceneId>/<shotId>` (`on` is
  built from `nodeKey`, `rules/documents.ts:391`); Shot Coverage keys its bracket
  `item:shot/<shotId>` (`rules/timeline/controls.ts:104`).
- **`file`.** `item:file/<path>` exists only in the tree's Files mode. In Documents mode
  the character, scene or wiki row that selects the same `docPath` is on screen under
  another key.

So when the exact key is absent, `guide` falls back to the first `ui.publish` anchor whose
props carry the table's field with the step's key as its value, preferring one in the pane
that was last ringed (the same preference `resolveSubject` applies with `from`). This is
safe where reading publish props for completion was not:

- The step is unmet whenever it is shown, so every row that selects the subject carries
  that field in its props, diff publishers included.
- An offer whose props have drifted from its click gives a wrong ring, which the author
  can see, not a stuck tour.

With the fallback, neither spelling of a shot key has to change, so no recorded key,
`ux-model.json` record or `anchors.json` entry moves.

### Validating select steps

`checkTour` (`src/shared/tourcheck.ts:69-71`) accepts any non-empty kind today, so a
hallucinated kind is shown and then stays blocked forever.

- `checkStep` imports the subject table directly. Both modules are in `src/shared/`, so no
  `Known` member is needed, and none of the five places that build a `Known` changes.
- A select step whose kind is not in the table is refused, and the message lists the kinds
  that are. This applies to both entrances, `show_me` and `tour.start(custom=…)`, since
  both call `checkTour`.
- `show_me`'s schema (`src/main/agent/showme.ts:93-98`) takes `itemKind` as
  `z.enum(subjectKinds())` instead of a free string, and the `key` description is built
  from each entry's key sentence instead of "its id".

The key itself is not shape-checked. A shot id's form is a convention (see the assumption
above), so a check that rejected an id without `__` could refuse a real shot.

### A stale Documents redraw (standalone fix)

The Documents pane redraws when `stateKey()` changes
(`pathux/editors/documents.ts:288-306`). That key lists five selection fields and leaves
out `graphSlug`, which `selection()` (`documents.ts:276-285`) reads and which graph rows
and graph-bound shot and asset rows depend on (`rules/selection.ts:115,120,137,142,178`).
When another pane changes `ui.graphSlug`, the tree's highlight and its recorded offers go
stale until something else forces a redraw. The fix adds `ui.graphSlug` to the key.

This plan does not need the fix, because `met` reads no offers. It ships here because the
diagnosis found it and it is one line.

## Accepted behaviour

Each of these follows from judging the step by the selection, and each is stated in the
docs change:

- **An already-selected subject's step is skipped on arrival.** The banner's step count
  moves on and nothing else is said.
- **A tour whose steps are all met finishes at once.** The author sees only the
  `Done — <what>` notification (`pathux/tour/tour.ts:190-193`), even though `show_me` has
  just told the agent it is walking the author through the steps.
- **Something other than the author's click can complete the step.** Script and Shot
  Coverage overwrite `ui.sceneId` when it names no known scene
  (`pathux/editors/script.ts:370-372`, `timeline.ts:284`), Play publishes on rebuild
  (`play.ts:284-285`), and `view.open` writes its `subject`
  (`pathux/panes/view.ts:77-85`). The step's goal is that the subject is selected, and
  that goal has been met.
- **An undrawn row does not stop a step being met.** If the subject is selected while its
  row is scrolled away or its pane is closed, the step still finishes.
- **A pinned pane counts the global selection.** A pane pinned to X while the selection is
  Y does not meet a step for X. A click in a pinned pane writes through to the global
  field as well (`pathux/doctree/pin.ts:45-48`), so clicking the ringed row there still
  completes the step.
- **Each window judges its own steps.** `ShellState` and the running tour are both per
  renderer.

## Work

Three commits, each green under `pnpm check`, `pnpm test` and `pnpm lint`.

### Commit 1 — the Documents redraw key

Status: **done.** Verified in the running app on a copy of the sample project. The sample
has graphs but no graph-bound shot, and the Gen Graph pane follows `ui.graphSlug` without
writing it, so the graph was changed with `view.open(editor='gengraph' subject=…)`. The
tree's graph-row offers moved to the new slug; a build without the line left them on the
old one.

- `pathux/editors/documents.ts`: add `ui.graphSlug` to `stateKey()`.
- No anchor sweep: `stateKey` only decides when the pane redraws, and no offer, key or tag
  changes.
- The pane has no unit test for `stateKey`. Verify in the running app: select a shot bound
  to a graph, change the graph from the Gen Graph pane, and check that the tree's
  highlight follows.

### Commit 2 — the subject table and validated select steps

Status: **done.**

- `src/shared/subjects.ts` (new): the table above, as a frozen record from kind to
  `{ path, key }` with paths typed `` `ui.${Published}` ``, plus `subjectKinds()`. It
  imports nothing from the renderer, because main (`tourcheck`, `showme`) reads it as
  well.
- `src/shared/tourcheck.ts`: `checkStep` refuses a select step whose kind is not in the
  table, and the message lists the known kinds.
- `src/main/agent/showme.ts`: `itemKind` becomes `z.enum(subjectKinds())`; the `key`
  description is built from the table's key sentences.
- Tests:
    - `src/main/tests/showme.test.ts`: an unknown kind is refused and the message lists
      the known ones; the existing `asset` select step still passes; the generated schema
      lists the kinds.
    - `src/main/tests/tours.test.ts`: the curated tours still pass (they have no select
      step, so this is a regression check only).

### Commit 3 — select steps finish on the selection

- `renderer/rules/tour.ts`:
    - `met(state, read)`: true when the current step is a select step whose subject path
      reads as its key. A kind not in the table is never met.
    - `skipMet(state, read)`: the state at the first step that is not met, or past the
      end.
    - `guide`'s select branch: when `resolveItem` answers `absent`, fall back to the first
      `ui.publish` anchor whose props carry the table's field equal to the key, preferring
      the given pane. `guide` takes that preference as a new optional argument.
    - `satisfies` is unchanged.
- `renderer/pathux/tour/tour.ts`:
    - `tourReadsData({ read, watch })`, stored beside `openPanes`.
    - `step()` calls `skipMet` before showing a step.
    - Showing a select step installs one watcher on its subject path. Its callback queues
      a microtask that advances when the tour is still on that step and `met` holds.
      Showing any other step, and `stop()`, remove the watcher.
    - `installTour`'s `window.__vnTour` also reports the watched path.
- `renderer/global.d.ts`: the new field on `__vnTour`'s return type.
- `renderer/pathux/app/shell.ts`: call `tourReadsData` beside `tourReadsPanes`, with
  `read` over `api.getValue` and `watch` over an `immediate` `DataPathWatcher`, as
  `persist.ts` builds its own.
- Tests, in `rules/tests/tour.test.ts`:
    - `met` for each kind in the table, an unknown kind, a non-select step, and a select
      step whose key differs from the path's value.
    - `skipMet` over a run of met steps, a tour that is all met, and an unmet first step.
    - The ring fallback: a tree shot row keyed `item:shot/<scene>/<shot>` is rung for a
      `shot` step keyed by the shot id; a character row is rung for a `file` step naming
      its sheet; the exact key wins when both exist.
    - Rename the test at line 374 to drop "which runs nothing".
- Docs, in `docs/reference/guided-tours.md`:
    - "Steps" (line 513): the select row completes when the subject is selected, not only
      by clicking an `item:` anchor; point to the subject table.
    - "Advancing" (line 622): the selection rule, the two places it fires, the `immediate`
      watcher, and the accepted behaviour above.
    - The CDP note at lines 644-646: a select step advances on a selection made over CDP,
      unlike a command step, because it watches state rather than `bridge.exec`; and
      `__vnTour` reports the watched path.
    - The Files table: a row for `src/shared/subjects.ts`.
    - Run `pnpm markdown-toc` if a heading changes, then prettier on the touched files.
- `docs/plans/index.md`: flip this plan's row to shipped and `git mv` the file to
  `archive/` in the same change, so `pnpm check:doclinks` stays green.
- Verification in the running app, over CDP. The window may be covered, since the watcher
  does not depend on frames. Start a tour whose first step selects an unselected character
  and whose second is the `view.open` that row's click runs. Click the row with
  `window.__vnAnchors.press(key)`, then read `window.__vnTour()`: the tour should have
  finished both steps. Then start a one-step tour on an already-selected character and
  check that it finishes at once.

## Cost of undoing

- Commit 1 is one line.
- Commit 2 tightens validation. Reverting it lets unknown kinds through again; no stored
  data changes.
- Commit 3 adds functions, one optional injection and a ring fallback, and changes no
  stored data and no recorded key. Reverting it restores the stuck behaviour exactly.

## Out of scope

Raised by the reviews (see the two review sections) and left for later, each because this
plan does not need it:

- **Publishing a subject's own fields instead of a diff.** It would make every
  `ui.publish` offer comparable with plain equality. Completion reads the step and the
  ring fallback works with diffs, so the churn across the Documents and task fixtures buys
  nothing yet.
- **One spelling for a shot's item key.** The first version of this plan changed the
  tree's shot key to `shot/<shotId>`. The ring fallback makes it unnecessary, and the
  change would have broken the `pick` guidance for shot-targeted commands:
  `resolveSubject` turns a composite id such as `shot:arrival/arrival__s1` into exactly
  the current tree key (`rules/anchors.ts:433-434`), and Shot Coverage's model select
  records such targets (`rules/timeline/cast.ts:138,152`).
- **A `subject` on `Control`, so a row keeps its `item:` key whatever its click does.**
  The key only changes once the click would change nothing, which is when the step is
  already met.
- **One publish runner installed by `act()`.** About twenty sites write the selection by
  hand; a runner would make every click write what its offer declares. It belongs with the
  publish-props change above.
- **One declared list of selection fields.** The list exists in at least seven places
  (`PUBLISHED`, `SelectionField`, `Selection`, the shell API, `PinField`, the Documents
  pane, persistence); the `graphSlug` omission in commit 1 is one result. Typing the
  table's paths against `Published` is enough for this plan.
- **Selection as a data-path write.** `ui.publish` could become `api.setValue` on the
  `ui.*` paths, which would also make `ShellState.onSelect` unnecessary. Pinned panes
  write through a per-pane proxy (`pathux/app/editor.ts:51-62`) that a global path does
  not reach, so this needs a design of its own.
- **Anchors for the Task Graph's slot and cluster nodes.** They write `ui.*` with no
  anchor (`pathux/editors/graph.ts:481-503`), and the comment at
  `rules/taskGraph.ts:583-587` says they are not subjects. Both are wrong, and neither
  affects select steps.
- **Moving the tour engine into path.ux.** The first review lists what the engine would
  need to take as configuration: an action catalog with check and a feed of what ran, the
  homes, strings and theme keys, and the gesture judge. The injected data reader in this
  plan is a step in that direction.
- **`openFirst` interpolates a raw popup id** into its caption (`rules/tour.ts:89-90`). It
  is a copy bug unrelated to select steps.
- **Pane-local selections** (the Documents pane's `picked` location, History's selected
  save). A select step cannot name them until they are data paths.

## Review of the first proposal

The first proposal, made in conversation before this plan was written, judged a select
step by the ringed row's `ui.publish` props against the selection, with a `selected` flag
on Documents rows and the advance in the overlay's re-resolve. A fresh-context review
found these problems; this is where each one went.

| Finding                                                                      | Where it went                                                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| An expandable row loses its `item:` key once its click would change nothing  | Fixed: `met` reads the step, not a row                                                                         |
| Advancing inside the overlay's `ask` is re-entrant                           | Fixed: advances happen on arrival and from the watcher's microtask, never in `ask`                             |
| The `selected` flag can go stale; the Documents redraw key omits `graphSlug` | Flag dropped; the omission is commit 1                                                                         |
| One key gives different answers from different panes                         | Fixed: no row is read for completion                                                                           |
| "Met" can disagree with the highlight                                        | `character` uses the highlight's field; `task` deliberately does not, with the reason in the table section     |
| An offer's declared publish props need not equal what the click writes       | Fixed for completion; for the ring, a drift gives a visible wrong ring; the runner is out of scope             |
| Automatic publishers can complete a step                                     | Accepted and documented                                                                                        |
| Documents rows do not drop `view.open` once selected (premise of the brief)  | Correct; it did not change the choice, because panel links, brackets, cards and asset-view rows run no command |
| Select steps are unvalidated; shots have two keys                            | Commit 2 validates kinds; the ring fallback handles both shot spellings                                        |
| Pins, multiple windows and pane-local selections                             | Pins and windows accepted; pane-local selections out of scope                                                  |
| `selected` is a one-producer field in the shared `Offer` schema              | Fixed: no field is added                                                                                       |

## Pressure test

A fresh-context agent reviewed the first version of this plan against the code on
2026-10-28. It confirmed the file:line citations and found the following. Each is fixed in
the text above unless the row says otherwise.

| #   | Finding                                                                                                                                                                                                                                                                                 | Outcome                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The default `raf` debounce never fires in a hidden window (`persist.ts:259-261` already says so), and its delay lets a row's own `view.open` reach `onExec` before the select step has advanced, leaving the next step stuck. `immediate` fires inside `subscribe()`, so it must defer. | Fixed: `immediate` watcher whose callback only queues a microtask                                                                                                     |
| 2   | Changing the tree's shot key breaks `resolveSubject`'s mapping of `shot:<scene>/<shot>` targets onto the tree row, with no failing test                                                                                                                                                 | Fixed by dropping the key change (finding 3); recorded under Out of scope                                                                                             |
| 3   | The ring finds rows only by exact key, so `file` steps in Documents mode and tree shot rows show "Nothing on screen names that yet"                                                                                                                                                     | Fixed: a fallback to any `ui.publish` anchor carrying the subject's field                                                                                             |
| 4   | `Known.subject` is unnecessary and would touch five constructions; the plan named only one                                                                                                                                                                                              | Fixed: `checkStep` imports the table                                                                                                                                  |
| 5   | The agent is told the kinds but not the key format, and `itemKind` stays a free string                                                                                                                                                                                                  | Fixed: `z.enum` and per-kind key sentences. Shape checks on keys were suggested as optional and are not adopted, because a shot id's form is a convention, not a rule |
| 6   | The shot key change left `data-anchor`, a doc comment and docs on the old spelling                                                                                                                                                                                                      | Moot: the key change is dropped                                                                                                                                       |
| 7   | An all-met tour shows only "Done"; Script and Shot Coverage overwrite an unknown scene, not only an empty one                                                                                                                                                                           | Fixed: stated as accepted behaviour, wording corrected                                                                                                                |
| 8   | No test of the advance loop; `global.d.ts` missing; paths could be typed rather than tested                                                                                                                                                                                             | Fixed: `skipMet` is pure and tested; `global.d.ts` listed; paths typed against `Published`                                                                            |
| 9   | Shot ids being namespaced is a convention, not a schema rule                                                                                                                                                                                                                            | Fixed: stated as an assumption                                                                                                                                        |
| 10  | The doc list missed four places in `guided-tours.md` and the Files table                                                                                                                                                                                                                | Fixed: listed in commit 3                                                                                                                                             |
| 11  | Commit 1 touches `editors/**` without saying why no sweep is needed                                                                                                                                                                                                                     | Fixed: one line in commit 1                                                                                                                                           |
