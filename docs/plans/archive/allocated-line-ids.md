# Allocated line ids

Status: **shipped** (see [As shipped](#as-shipped)). Move one of the direction argued in
[`../../research/scene-chunks-as-the-authored-unit.md`](../../research/scene-chunks-as-the-authored-unit.md)
— and the only one that stands entirely on its own. It ships against the existing single-file
screenplay, needs no editor, and closes a silent-corruption path that exists today.

<!-- toc -->

<!-- tocstop -->

## Why

`SceneLine.id` is documented as "Stable, scene-scoped id"
(`packages/types/src/entities.ts:93`). It is not. `splitScenes` stamps it positionally, last
(`packages/model/src/scenes.ts:129`):

```ts
scene.lines.forEach((line, i) => {
  line.id = `${scene.id}:L${i + 1}`;
});
```

`Shot.coversLines` binds to those ids. Insert one line at the top of a scene and every id below
shifts by one, so a shot that covered the first exchange now covers the line above it — and
**nothing reports this**, because `readShots(knownLineIds)` only drops ids the scene no longer
has, and after an insertion `L1..Ln` all still exist. They just mean different prose. The failure
is silent, it costs money (the frame illustrates the wrong line), and it is invisible in the one
surface built to reveal coverage problems.

Nothing can edit prose today, which is the only reason this has not bitten. It has to be fixed
before anything can.

## The shape

An id becomes **allocated and written down** rather than derived from position. It is written into
the screenplay as a Fountain note, the channel this project already uses for
`[[scene:]]` / `[[choice:]]` / `[[next:]]`:

```fountain
INT. SCHOOL GATE - AFTERNOON

[[nextline: 12]]

[[line: L1]]
Rain ticks off the gate.

AIKO
[[line: L4]]
Um… hello.

[[line: L7]]
She bows, a little too deeply.
```

- **`[[line: L4]]` leads the element it names.** The marker binds to the *next* line-bearing
  element, so it sits on its own line immediately above the prose.
- **`[[nextline: 12]]` is the scene's allocator**, a monotonic high-water mark. Insertion takes it
  and bumps it; deletion retires an id permanently. It is scene-scoped and becomes the chunk
  file's `nextLineId` front-matter field if move two happens.
- **The marker carries the bare local part** (`L4`, not `arrival:L4`). Scene ids can still be
  overridden by `[[scene:]]` after splitting, and the final id is composed as `${scene.id}:L4` in
  the same pass that does that today.

### The one hard constraint: where the marker may go

`isBlank` in `parseFountain` tests the **raw** line, not the note-stripped one
(`packages/parse/src/fountain.ts:83`). A line containing only `[[line: L4]]` is therefore
*non-blank* to every rule that requires a blank neighbour — and character cues, scene headings and
unforced transitions all require one.

So the rule is not "above the element", it is **above the element's text, inside its block**:

| Element                          | Marker goes                                            |
| -------------------------------- | ------------------------------------------------------ |
| action / narration               | on its own line directly above the paragraph            |
| dialogue, parenthetical          | **after the `CHARACTER` cue**, inside the dialogue block |
| scene heading, transition, lyric | never — they are not `SceneLine`s and have no id         |

Putting a marker directly above a cue turns the cue into an action paragraph and silently
un-speaks the dialogue. This is exactly the class of hazard `branchpatch.ts` already documents
("a removed note line that leaves a blank above a heading"), and it gets the same answer: the
writer re-parses and compares, and discards on any divergence.

The element order works out for free. `parseFountain` pushes a line's notes **before** its
stripped element (`fountain.ts:90`), and the dialogue-block loop does the same for notes inside
the block (`fountain.ts:171`), so in both placements the `note` element arrives immediately
before the element it marks. The intervening `character` element pushes no `SceneLine`, so a
pending marker survives it.

## Reading never writes

Allocation happens on read, in memory: `splitScenes` honours a marker where it finds one and
allocates for anything unmarked. It does **not** write markers back. Persisting them is a separate,
explicit, undoable command, because a model build is a pure function and a `vngen status` that
rewrites the screenplay would be indefensible.

That split gives the **backward-compatibility property this whole change rests on**: a screenplay
with no markers allocates `L1..Ln` in document order — byte-identical to what it gets today. So

- every existing project keeps its ids on upgrade,
- every existing `work/shots/<sceneId>.json` keeps its coverage,
- and running the writeback on an unedited file is a **no-op on the model**, which is the
  acceptance test.

## Failure modes, and what each does

Not-quiet is the point of the change, so none of these are warnings-in-a-log.

| Situation                                        | Behaviour                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Two lines in a scene marked `L4`                  | error-severity diagnostic; ids must not alias, or `coversLines` is ambiguous   |
| `[[line:]]` with no line-bearing element after it | error-severity diagnostic, marker dropped                                     |
| Two `[[line:]]` markers with nothing between      | error-severity diagnostic; the second is the dangling one                     |
| Marked id ≥ `[[nextline:]]`                       | the mark is raised to `max + 1`; a stale mark is a bug, not a licence to reuse |
| No `[[nextline:]]` at all                         | derived as `max(marked) + 1`, or `1` — the ordinary unmigrated case            |
| Unmarked element                                  | allocated in memory, no diagnostic — this is the normal path pre-migration     |

## Steps

1. **`@vn/parse`: two marker kinds.** `BranchMarker` gains `{ kind: 'line'; id: string }` and
   `{ kind: 'nextline'; value: number }`; `parseBranchMarker` gains the two `key` branches. Tests:
   both forms, a non-numeric `nextline`, and confirmation that unrelated notes still return `null`.
   Rename nothing — `parseBranchMarker` is now marginally misnamed and that is cheaper than
   touching every caller.

2. **`@vn/types`: `Scene.nextLineId?: number`.** Purely the allocator's high-water mark, carried on
   the scene so the writer does not have to re-derive it. Document it as such.

3. **`splitScenes` honours markers.** A `pendingLineId` carried across elements the way
   `currentSpeaker` already is; `pushLine` consumes it when set and allocates otherwise. The final
   pass stops stamping unconditionally and composes `${scene.id}:${local}` instead. Diagnostics per
   the table above, returned alongside `scenes`/`mined` (the signature grows a third field; the
   two call sites in `@vn/model` absorb it).
   Tests: fully marked, fully unmarked (**byte-identical to today's ids** — this is the one that
   matters), mixed, marked dialogue after a cue, `[[scene:]]` override composing with a marked
   local id, and each diagnostic.

4. **`assignLineIds` in `@vn/model`.** A surgical writer, sibling to `branchpatch.ts` and modelled
   on it: it inserts `[[line:]]` lines at the placements in the table, inserts or updates
   `[[nextline:]]`, and touches no other byte. Then the safety net, which is total — re-parse the
   result, re-run `splitScenes`, and require that the element list differs only by the added notes
   and that every line's `kind`/`speaker`/`text` is unchanged. Any other divergence discards the
   patch and returns a diagnostic. Tests: the placement rule per element kind, idempotency (running
   it twice changes nothing), a file where insertion would break a cue (discarded, reported), and
   the no-op property on `templates/basic`.

5. **`story.assignLineIds` command.** `mutating: true`, `undoable: true` (screenplay is the
   document data class the shadow-snapshot undo already covers), and a `check` that runs the same
   pure decision and reports how many ids would be allocated — or refuses with the safety net's
   diagnostic, which is the refusal the command would give. Optional `scene` prop; omitted means
   every scene. Registry, catalog, `commands.test.ts` namespace and precondition lists.

6. **Give diagnostics somewhere to go.** Step 3 produces error-severity diagnostics whose entire
   purpose is to be seen, and today the desktop app drops them: `workspace.index()` returns
   `diagnostics`, the STUDIO rail renders `characters` / `locations` / `scenes` and ignores them
   (`Rail.tsx:16-77`), and nothing else in the renderer reads `WorkspaceIndex`. Add a
   `DIAGNOSTICS` group to the rail — same collapsible shape as the three that exist, `--vermilion`
   for `error` and muted for `warning`, `code` in `--mono` and `message` in `--prose`, hidden
   entirely when the list is empty — plus a count badge in the topbar beside `badge-live`, so an
   error is visible from FLOOR and PLAY too. Nothing is clickable in this step; a diagnostic that
   navigates to its scene is a later nicety, and an invisible error is the actual bug.

7. **Wire the palette to the catalog.** Not required by the id work, and included deliberately:
   `story.assignLineIds` is the first command whose audience is the *author* rather than the agent,
   and `Palette.tsx` is a hardcoded list of skills plus a model picker that never calls
   `command:catalog`. Both `CLAUDE.md` and `docs/command-system.md` already claim the palette
   reaches the same registry as the agent and CDP; this is what makes that true.
   - Fetch `command:catalog` once (the live registry, never `dist/commands.json`) and render a
     `COMMANDS` group. `pal-search` becomes a real `<input>` with substring matching over `id` and
     `title`; the existing `'root' | 'model'` view state grows a `'props'` member rather than a
     new mechanism.
   - **Mutating commands are marked, and checkable ones are checked.** On focus, call
     `vn.check(id, props)` and show the verdict inline — `accept` with its note, `refuse` with the
     reason the command itself would give, and **nothing at all for `undeclared`**, which must not
     render as a green tick. This is the palette earning the precondition work: the refusal is
     shown before the command runs, the same honesty rule the mid-drag overlays follow.
   - A command with props opens the `'props'` view, generated from the catalog's prop specs
     (`type`, `default`, `description`, `enum`) — the "future properties panel" the command-system
     doc names. Re-check on change so the verdict tracks what is typed.
   - `confirm: true` (only `pipeline.run`) gets a confirm step before `exec`.
   - Execution goes through `vn.exec`, so provenance, undo and the history are unchanged.

8. **Verify on the seeded workspace.** Run it against `examples/mySampleRepo`, confirm
   `story.coverage` is unchanged for every scene, then hand-insert a line at the top of a scene and
   confirm the shots' coverage still names the same prose — which is the bug, demonstrated fixed.
   Drive it from the palette as well as over CDP, since step 7 is the path an author would take.
   Record the transcript in the As-shipped section.

9. **Docs.** This file's As-shipped section, the research doc's status, `CLAUDE.md` (the
   `[[line:]]` marker in the `@vn/parse` row, a bullet on allocated ids near the shots-are-
   persisted one, and the palette claim — which becomes true in step 7 rather than staying
   aspirational), `docs/command-system.md` (the palette is catalog-driven; `checkable` is what it
   consults), and `docs/fountain.md` (the marker table).

## As shipped

All nine steps landed. `pnpm check`, `pnpm test` (663 tests, 61 suites) and `pnpm lint` are green.

### Deviations

- **`FountainElement.line`** (zero-based source index) was added in step 1 rather than being
  assumed. The writer needs to know which raw line an element came from, and nothing carried that.
  `stripBoneyard` therefore **blanks in place** instead of deleting, so a boneyard never shifts the
  indices, and `srcLine()` adds the title-page lines back.
- **Step 4's "insertion would break a cue" test is a preservation test instead.** The placement rule
  puts a dialogue mark *after* the `CHARACTER` cue and inside the block, so with the rule applied
  correctly there is no input that breaks a cue — the case can only be reached by breaking the
  writer. What is pinned is the property that matters: cues, blanks and branch markers survive a
  write byte-for-byte, plus the safety net's own refusal path (`line_ids_verify`).
- **`branchpatch.ts` narrowed rather than widened.** `parseBranchMarker` now returns two kinds
  `markersOn` has no business rewriting, so it pushes only `choice`/`next` occurrences. A
  regression test (`leaves line-id markers alone while rewiring around them`) pins it: the branch
  editor and the id writer share one file, and a rewire must not eat a `[[line:]]`.
- **The palette executes over `command:exec`**, the channel `window.vn.exec` itself forwards to,
  rather than reaching for `window.vn`. Same stack, same provenance, same undo — and the
  browser-only design preview still renders, because `renderer/api.ts`'s fallback answers the
  channel. The fallback answers `command:check` with `undeclared`, not `refuse`: a preview has no
  precondition to consult, and dressing that up as a verdict would put a sentence in the palette no
  command ever said.
- **The palette's pure half is `renderer/app/catalog.ts`, not `palette.ts`.** TypeScript resolves
  `.ts` before `.tsx`, so on a case-insensitive filesystem `./Palette` from `App.tsx` bound to
  `palette.ts` and the two names collided. `catalog.ts` is also the more honest name — it is about
  catalog entries.
- **Highlighting a row is not navigating to it.** The first cut opened the props view on focus,
  which meant hovering a command left the list. `select` now only arms the check; the click decides
  between the props view and running. `run` takes its props as an argument because a click focuses
  the row first and the resulting `setValues` has not landed yet.
- **The verdict is re-asked after every execution.** A command that just ran changed what its own
  precondition would answer, and leaving the old sentence up would describe work already done.

### Verified on `examples/mySampleRepo`

Driven over CDP (`node scripts/vn-cdp.mjs`) against the real desktop app, mock mode:

```
$ vn-cdp --raw "window.vn.check('story.assignLineIds', {})"
{ "state": "accept", "message": "14 line id(s) would be written into the screenplay." }

$ vn-cdp "story.assignLineIds()"
"message": "Wrote 14 line id(s) into the screenplay."
"written": ["screenplay/script.fountain"]
"undo": { "pre": "6b5f923…", "post": "3e3b047…", "changed": true }
```

Coverage for all five scenes (every shot, with the first 46 characters of each line it covers) was
captured before and after: **identical**. Then a new opening paragraph was hand-inserted at the top
of `arrival`, above the marked `L1`:

| | `arrival__establishing` covers | `arrival__beat1` covers |
| --- | --- | --- |
| before | `L2` "Um… hello. I'm Aiko…" | `L1` "The door slides open…" |
| **marked**, after insertion | `L2` "Um… hello. I'm Aiko…" | `L1` "The door slides open…" |
| **unmarked** (same insertion, marks reverted) | `L2` "The door slides open…" | `L1` "Chalk dust hangs…" |

The third row is the bug, reproduced: both shots silently re-point one line down, and nothing
reports it. The second row is the fix. The inserted line reads as `arrival:L4` — the allocator's
next id — and `story.assignLineIds(scene='arrival')` then wrote `[[line: L4]]` and bumped
`[[nextline:]]` 4 → 5, leaving every other id untouched. A second run reports
`Every line in the screenplay already carries its id.`

The same command was then driven **from the palette** with trusted CDP input
(`Input.dispatchMouseEvent` / `Input.insertText`), which is the path an author takes:

```
groups:           "SKILLS · .aiagent/skills / SESSION / COMMANDS 26"
typed "assign" →  "story.assignLineIds"
hover           →  ✓ 1 line id(s) would be written into the screenplay.
click           →  props view, one field: scene
typed "greet"   →  ✓ 1 line id(s) would be written into scene "greet".
click run       →  Wrote 1 line id(s) into scene "greet".
--undo          →  Undid story.assignLineIds(scene='greet').
--redo          →  Redid story.assignLineIds(scene='greet').
```

**One environmental trap worth writing down**: an occluded Electron window is throttled by
Chromium, so `element.click()` and `.focus()` from `Runtime.evaluate` appear to be ignored — React
handlers are attached and simply never render. `Page.bringToFront` first, and prefer the `Input`
domain over synthetic DOM events.

## Not in this plan

- **Chunk files.** One scene per file, front-matter, the `@vn/store` mapper. Move two.
- **Prose editing of any kind.** No commands that change line text, no editor surface. This plan
  makes ids trustworthy; it does not make anything editable.
- **Drift marking.** Detecting that a shot's covered prose has changed since it was generated
  needs an editor to be worth having.
- **Widening `SceneLine.kind`.** Transitions, lyrics and centered text stay unretained and
  therefore uncoverable, exactly as today.
- **Palette refinements.** Step 7 is catalog-driven listing, substring search, generated prop
  inputs and the inline verdict. Not fuzzy matching, recent-command history, per-command
  keybindings, or a properties panel outside the palette.
- **Clickable diagnostics.** Step 6 makes an error visible. Navigating from one to the scene that
  caused it is a later nicety; being invisible is the bug.

## Alternatives considered

**Derive the allocator from `max(marked)` and skip `[[nextline:]]`.** Cheaper, and wrong in the
one way that matters: deleting the highest-numbered line regresses the counter, so the next
insertion reuses a retired id. A shots file that still names it — which is any shots file not
rewritten by a planner pass since the deletion — then binds a shot to unrelated prose. That is the
same silent re-pointing this plan exists to remove, and it would be shipped inside the fix.

**Content-hash ids** (`arrival:<sha8(text)>`). No allocator, no writeback, stable across
reordering — and destroyed by every typo fix, which makes the cheapest edit the most destructive
one.

**Opaque random tokens.** Reuse becomes impossible with no high-water mark to maintain. Rejected
for legibility: ids appear in `coversLines`, in the timeline, and in `story.setCoverage(lines=…)`
typed by hand, and `L4` is worth reading where `k3f9` is not.

**Trailing inline markers** (`She bows. [[L7]]`). Quieter on the page and they parse identically —
`extractNotes` is position-free within a line. Rejected because the token shares a line with prose,
so a re-wrap moves it and an ordinary edit can delete it without the author noticing they have
detached a shot from its line.
