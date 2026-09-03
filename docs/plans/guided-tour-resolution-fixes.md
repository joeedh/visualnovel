# Guided tour resolution fixes

_Status: **planned** (2026-09-03). Five independent fixes to the tour layer, written from a bug
review of `src/shared/tours.ts`, `src/shared/tourcheck.ts`,
`renderer/rules/{tour,anchors,precheck}.ts`, `renderer/pathux/{tour,overlay,gestures}.ts`,
`src/main/commands/tour.ts` and `src/main/showme.ts`, then rewritten against a pressure test whose
findings are recorded in [Review](#review).
[`../reference/guided-tours.md`](../reference/guided-tours.md) is the authority on the layer itself;
this file is the authority on what gets changed and in what order._

<!-- toc -->

- [What this builds](#what-this-builds)
- [Not in scope](#not-in-scope)
- [Stage 1 — a `wrong-subject` step points at the subject](#stage-1--a-wrong-subject-step-points-at-the-subject)
- [Stage 2 — the refusal cache stops outliving what it was about](#stage-2--the-refusal-cache-stops-outliving-what-it-was-about)
- [Stage 3 — `tour.start` checks the tour it is handed](#stage-3--tourstart-checks-the-tour-it-is-handed)
- [Stage 4 — gesture verdicts come only from open panes](#stage-4--gesture-verdicts-come-only-from-open-panes)
- [Stage 5 — an `input` step waits for a value](#stage-5--an-input-step-waits-for-a-value)
- [What it costs to undo](#what-it-costs-to-undo)
- [Review](#review)

<!-- tocstop -->

## What this builds

Five fixes, each independently green under `pnpm check`, `pnpm test` and `pnpm lint`, and each
useful if the next never lands. Stage 1 is the only one an author can see going wrong today; the
rest are boundary conditions.

1. A `wrong-subject` step stops telling the author to press a control that would act on the wrong
   thing. Where the subject is on screen it rings the row that selects it; where it is not, it
   refuses and says which subject is missing.
2. The `stack.check` refusal cache is cleared when a tour restarts and when any command succeeds.
3. `tour.start` runs `checkTour` over a `custom` tour before the author sees any of it, and
   `resolveAnchor` stops matching every item anchor for a step with no command id.
4. `verdictsFor` answers only for a pane that is currently open.
5. An `input` step advances only when the author actually typed something.

Nothing here touches `apps/desktop/renderer/pathux/editors/**`, so `scripts/sweep-anchors.mjs` does
not need re-running and `anchors.json` does not change.

## Not in scope

- **`resolveNamed`'s suffix matching.** The review called it a wrong-anchor risk with two examples
  (carried `"1"` matching `item:scene/s1`, carried `"s1"` matching `item:scene/as1`). Both are
  impossible: the test is `entry.key.endsWith('/' + key)`, anchored at a slash, so it can only match
  a whole final segment. The residual risk is narrow — `nodeKey` returns multi-segment keys like
  `greet/greet__s1` (`renderer/pathux/doctree.ts:26`), so two items of different kinds in one editor
  could share a final segment. The suggested repair (anchor the match to the step's `itemKind`)
  cannot be applied: a `gesture` step carries no kind, which is the reason `resolveNamed` exists at
  all. Left as is.
- **Two open panes of the same editor.** `gestureState` is keyed by namespace, so two timeline panes
  leave one entry and the last redraw wins. That is the rule the anchor layer already follows —
  `redrawing(editor, part)` keys its passes by `editor/part`, so a second instance replaces the
  first's anchors too. Both being per-editor keeps the ring and the verdicts consistent with each
  other. Making gestures per-instance without making anchors per-instance would introduce a
  disagreement rather than remove one, and doing both is a change to the anchor layer's identity
  model rather than a bug fix.
- **Reordering `gesture()` so `grab` resolves before the `UNRESOLVED` verdict.** Considered and
  rejected. The `UNRESOLVED` reasons in `src/shared/interactions.ts` name the scene the pane is on
  (`No shot "s2" in greet.`), which tells the author more than the message that would replace it
  (`Nothing on screen names s2.`). Stage 4 removes the case that made the ordering look wrong.
- **The overlay's `marks` pool.** It grows to the largest number of drop targets ever marked and
  reuses the divs after that. That is a pool, not a leak.
- **`askedAs`'s replacer.** `JSON.stringify(props, Object.keys(props).sort())` drops nested keys.
  `PropValue` is scalar or `string[]`, so there are none. Left until there are.
- **A rung-to-asset map.** Stage 1 cannot point at `character:aiko/gala` because nothing on screen
  is keyed by a rung below the entity (see [what it reaches](#what-it-reaches)). Building one means
  the anchor layer learning which asset came from which rung, which is a new index, not a fix.

## Stage 1 — a `wrong-subject` step points at the subject

**The bug.** `guide` answers `wrong-subject` with `{ show: 'ring', say: step.say, where }`
(`renderer/rules/tour.ts:115-116`) and discards the `needs` action `resolveAnchor` computed. The
author is told to press a control whose recorded props act on a different subject. If they press it,
the write lands on the wrong subject, and then `satisfies` compares the step's props against what
ran, does not match, and the tour does not advance — it re-rings the same wrong control. For
`art.setNotes` that means art direction written onto the wrong rung.

The docs promise otherwise: the resolution table's response for `wrong-subject` is "Ask the author
to select the right subject first" (`docs/reference/guided-tours.md:173`), and the archived plan says
it "emits a selection step". `resolveItem` exists to be that target and says so in its own doc
comment; `renderer/pathux/editors/asset.ts:1261` records an item anchor for the same reason. The
machinery was built and never wired up.

Only agent-written tours reach it. All three curated tours carry no `props`, and `wrong-subject`
needs a prop conflict.

### Which props name a subject

`subsumes` puts a prop into `needs` for two different reasons (`renderer/rules/anchors.ts:151-158`):
the anchor records it with a different value, or the anchor does not record it at all and does not
`supplies` it. Only the first is a subject conflict. The second is free text, an enum, a number — a
step naming a prop this control does not take, which `subsumes`'s own doc comment calls an
incomplete anchor.

Conflating them is what makes a value-only search unsound. A step
`story.setLine {sceneId:'greet', lineId:'l3', speaker:'aiko', text:'…'}` against an anchor recording
only `sceneId` puts `speaker:'aiko'` into `needs`, and `'aiko'` names the document tree's character
row — so a search over every needed value would ring the character row and stay stuck there.

So `subsumes` reports which of them the anchor itself holds:

```ts
| { state: 'wrong-subject'; needs: Action; holds: string[] }
```

`holds` names the props in `needs` that are `name in anchor.props` with a different value. It is
carried through the `wrong-subject` `Resolution` (`anchors.ts:99`) unchanged.

### Finding the row

`resolveSubject` searches only the values of held props, and only the string ones — a conflict on a
boolean or a number is not a subject.

```ts
export function resolveSubject(live: LiveAnchors, needs: Action, holds: readonly string[], from?: AnchorHome): Resolution {
  const values = new Set<string>();
  const keys = new Set<string>();
  for (const name of holds) {
    const value = needs.props[name];
    if (typeof value !== 'string' || value === '') continue;
    values.add(value);
    // `character:aiko`, `location:cafe` — a rung id is a kind and a key, which is an item key.
    const cut = value.indexOf(':');
    if (cut > 0) keys.add(itemKey(value.slice(0, cut), value.slice(cut + 1)));
  }
  if (values.size === 0) return { state: 'absent' };
  const selects = (a: Anchor): boolean =>
    keys.has(a.key) || Object.values(a.publishes ?? {}).some((v) => values.has(v));
  const found = live.anchors.find((a) => a.editor === from && selects(a)) ?? live.anchors.find(selects);
  if (!found) return { state: 'absent' };
  if ((live.offscreen ?? []).includes(found.key)) return { state: 'offscreen', anchor: found };
  return { state: 'ready', anchor: found };
}
```

Two matches rather than one, because a subject is named two ways. A bare id (`asset.regenerate`'s
`hash`, a `sceneId`) is what an item anchor's click publishes, and `publishes` records those fields
(`publishedBy` in `renderer/pathux/doctree.ts:188`, `taskPublishes` in
`renderer/pathux/selection.ts:35`). A composite rung id (`art.setNotes`'s `target`) is a kind and a
key, which is the shape of an item key.

Empty strings are excluded from both: `publishedBy` records a field a click clears as `''`, and
without the guard every anchor that clears the same field matches every other.

The editor that gave the mismatch is preferred so the pane the author is already looking at is the
one that retargets. The selection is shared, so any pane's row would work; this only picks the least
surprising one.

### What to show

`guide`'s `wrong-subject` case, in order:

```ts
case 'wrong-subject': {
  if (where.holds.length === 0) {
    // The step names props this control does not take. That is not a subject the author can pick,
    // so the answer is the control's own, which is a refusal when it is greyed.
    if (!where.anchor.enabled) {
      return { show: 'blocked', say: step.say, reason: where.anchor.reason ?? UNAVAILABLE, where };
    }
    return { show: 'ring', say: step.say, where };
  }
  const subject = resolveSubject(live, where.needs, where.holds, where.anchor.editor);
  if (subject.state === 'absent') return { show: 'blocked', say: step.say, reason: missing(where) };
  return { show: 'pick', say: step.say, where: subject, first: PICK_FIRST };
}
```

- `holds` empty and the anchor enabled keeps today's behavior, so nothing regresses on the
  incomplete-anchor path.
- `holds` empty and the anchor greyed is the case an empty-props refusal produces — `record` stores
  `props: {}` for a refused offer (`renderer/pathux/anchors.ts:113`), so `nothingShown('asset.regenerate')`
  (`editors/asset.ts:596`) reaches `wrong-subject` today and sends the author subject-hunting when the
  honest answer is the control's own sentence.
- `PICK_FIRST` is one sentence: "Click this first. The button acts on what is selected, and it is on
  something else."
- `missing` is a module-level helper in `renderer/rules/tour.ts` beside `guide`, taking the
  resolution and returning `` `Nothing on screen selects ${names}, which is what this step acts on.` ``
  where `names` is the held string values joined with `, `. It is only called with `holds` non-empty
  and at least one string value, so it never has to describe an empty list.

A new `Guidance` variant, `pick`, rather than `select`: `Step` already has `kind: 'select'`
(`src/shared/tours.ts:34`), and a `select` step resolves to `ring`, so a variant of the same name
returned for a `command` step would put one word on both sides of the table in
`docs/reference/guided-tours.md`.

```ts
| { show: 'pick'; say: string; where: Resolution; first: string }
```

### What it reaches

`resolveSubject` answers for a step whose held prop is a subject something on screen is keyed by:

| Step | Held prop | What it rings |
| --- | --- | --- |
| `asset.regenerate {hash}` | `hash` | the asset row (`item:asset/<hash>`, published as `assetHash`) |
| `story.*` on a scene | `sceneId` | the scene row |
| `art.setNotes {target:'character:aiko'}` | `target` | the character row, by item key |
| `gengraph.*` on a graph | slug | the graph row (published as `graphSlug`) |

It answers `absent` — and the step becomes `blocked` — for a rung below the entity:
`character:aiko/gala`, `location:cafe/night`, `shot:greet/s2`. The document tree has no node under
`character:<id>` (`src/main/doctree.ts:171-191`), and no `publishes` record carries a composite rung,
so there is nothing on screen to ring. That is the correct outcome rather than a shortfall: today the
tour rings the notes box for the wrong rung and the author's note is written to it, and a refusal
naming the rung writes nothing. The curated `art-direction` tour is unaffected either way, since it
carries no props.

### Consumers

Four switch on `Guidance.show`, plus two that test it in passing:

- `renderer/pathux/overlay.ts` `aimOf` — accepts `pick`, caption is `say` then `first` on its own
  line, the way `blocked` already joins its reason; `also` is empty. An item anchor is
  unconditionally `enabled: true` (`renderer/pathux/anchors.ts:134`), so the ring draws live.
- `renderer/pathux/overlay.ts` `asks` — an `if` chain with a `return []` default, so it accepts the
  new variant silently. `tell` only calls it when `aimOf` returned nothing, and `aimOf` answers for
  `pick`, so the default is right; it is listed because the compiler will not name it.
- `renderer/pathux/tour.ts` `explain` — gains a `pick` arm saying `say` then `first`.
- `renderer/rules/tour.ts` — the union itself.
- `renderer/pathux/tour.ts:152-153` (`awaiting`, `askAbout`) and `:188` (`present`) test for
  `ring`/`blocked`/`route` and are correct unchanged: a `pick` answer awaits no invocation and points
  at an anchor with no command to check.

`window.__vnTour` exposes only the tour id, the step index, its `say` and the ring key
(`renderer/pathux/tour.ts:48-58`), so CDP and the sweep are unaffected.

### Converging

Clicking the ringed row publishes a selection, the pane redraws, and the next beat re-resolves.
Where several held props conflict, one click fixes one and the next re-resolve rings the next row.
Two that could not both be satisfied would ping-pong; `ui.*` fields are independent and
`publishedBy` records only the fields a click changes, so this is not reachable today, and
`tour.next` is the escape if it becomes so.

### Verify

- `renderer/rules/tests/anchors.test.ts`: `subsumes` reports `holds`; the four existing
  `wrong-subject` assertions (lines 53, 82, 130, 162) gain the field. `resolveSubject` prefers
  `from`, matches a bare id through `publishes` and a rung id through the item key, skips empty
  values, reports `offscreen`, answers `absent` when nothing names it.
- `renderer/rules/tests/tour.test.ts`: the four `guide` answers — `pick`, `blocked` for a subject
  nothing draws, `ring` for `holds` empty and enabled, `blocked` for `holds` empty and greyed. The
  `story.setLine` case above is worth a test of its own, since it is the one a value-only search got
  wrong.

Both modules are pure and node-testable.

### Docs

The `wrong-subject` row of the resolution table in
[`../reference/guided-tours.md`](../reference/guided-tours.md) states what the code now does and that
a rung below the entity has nothing to point at; the `Guidance` list gains `pick`; the `subsumes`
bullets record the `holds` split.

## Stage 2 — the refusal cache stops outliving what it was about

**The bug.** `asked` maps an anchor key to what `stack.check` said about it. It is cleared in
`stop()`, but `applyTour`'s `start` branch does not call `stop()` when a tour is already running — it
re-`watch()`es and calls `step(start(tour))`, so refusals from the previous tour stand.

They stand indefinitely rather than for one re-ask: `askAbout` returns early when
`asked.get(key)?.as === as` (`renderer/pathux/tour.ts:136`), so the entry is never asked again. Its
only invalidation is `onWrote`, and `wrote()` returns early on `paths.length === 0`
(`renderer/pathux/bridge.ts:179`) — so a command that changes what a precondition answers without
reporting a path never clears it. `project.setKey` at the user scope is exactly that: it returns
`written: []`, because the key file is outside every repository.

The overlay already resets its own per-tour state on a restart: `follow()` calls `unfollow()`, which
clears `scrolled` and `warned`. This is the missing half of that.

**What changes**, all in `renderer/pathux/tour.ts`:

- `stop()` closes a palette the tour opened. It sets `routed = false` today and leaves the palette
  on screen, so `tour.cancel` over a routed step already leaves a form up with no tour behind it.
  Only `shownNow`'s `routed && shown.show !== 'route'` ever calls `closePalette`, which is the wrong
  owner for a tour that has ended. Fixing this first is what makes the next change safe.
- `applyTour`, after the parse succeeds and before `watch()`: `stop()`. It goes after the `!tour`
  return, so a tour that fails to parse does not end the one already running.
- `ran()`: clear `asked` on any successful outcome, before the `satisfies` test. A command that ran
  is reason to ask again whatever it reported writing.
- The doc comment on `asked` records that `onWrote` is one signal rather than the only one, and why
  a write reporting no paths never reaches it.

`ran()` fires from `onExec`, which sees every command through `bridge.exec` — buttons, the palette,
hotkeys — but not `window.vn.exec` and not the agent's tools, whose writes `onWrote` still covers.
The clear is unconditional rather than restricted to mutating commands, so navigating with `view.*`
re-asks too; one `command:check` on the next beat is cheaper than deciding which commands can change
a precondition. There is no re-entrancy: the clear happens before `step()`, and `step()` →
`shownNow()` → `askAbout()` refills the entry synchronously with the verdict landing a beat later,
which is the same transient the existing `onWrote` clear produces.

**Verify.** Not unit-testable: the desktop jest project is `testEnvironment: 'node'` and
`renderer/pathux/tour.ts` reaches the palette and the overlay. Verified by reading, and over CDP
against a running app — start a tour on a refused anchor, start a second tour, and read
`window.__vnTour()` beside the ring's caption. The palette teardown is checked the same way, by
cancelling a tour on a routed step.

## Stage 3 — `tour.start` checks the tour it is handed

**The bug.** `show_me` runs `checkTour` before pushing (`src/main/showme.ts:115`). `tour.start`
accepts a `custom` JSON tour and pushes it unchecked; the renderer's `parse()` runs only `readTour`,
which decides the shape and nothing else. A step naming a command that does not exist resolves
`unanchored`, routes to `openPalette('<nonexistent>')`, and the author gets a palette filtered to
`COMMANDS · 0` with no form and nothing saying why.

The review filed this as high severity on the grounds that agent-written tours enter here. They do
not: the agent's registry is `historyTools` plus `showMeTool` (`src/main/session.ts:1323-1330`), so
the agent cannot call `tour.start` at all. The reachable callers are CDP and a human pasting JSON
into the palette's `custom` field. It is worth closing because main holds the registry and the check
already exists, not because the agent can reach it.

One consequence is worse than a bad id, and it is a trap for any future caller rather than only for
this one. A step that is not an object at all has `step.kind === undefined`, falls through to the
command branch, and `resolveAnchor` filters on `anchor.id === step.id` (`renderer/rules/anchors.ts:184`)
— `item:` anchors have no `id`, so `undefined === undefined` matches **every** item anchor,
`subsumes` answers `ready` over no props, and the tour rings an arbitrary tree row it can never
advance past.

**What changes.**

- `renderer/rules/anchors.ts`: `resolveAnchor` filters on `anchor.id !== undefined && anchor.id === step.id`.
  One line, and it closes the hole rather than the route to it.
- `src/main/commands/host.ts`: `CommandHost` gains `known: Known`, the interface already in
  `src/shared/tourcheck.ts`. `CommandHost` is documented as what the desktop's commands may reach,
  and a command validating machine-written input against the catalog needs the catalog.
- `src/main/index.ts`: fill it from the registry already built at line 661, `desktopInteractions`
  from `commands/interaction.ts`, and `coerceProps`. `getStack()` is the only place a `CommandHost`
  is constructed, and every test builds its context as `as unknown as CommandContext<CommandHost>`,
  so a required field breaks nothing.
- `src/main/commands/tour.ts`: `run` reads a custom tour with `readTour` and checks it with
  `checkTour(read.tour, ctx.host.known)`, throwing the problems joined by newlines. The command
  refuses instead of the author being walked into a dead palette.

  Injection through the host rather than calling `createDesktopRegistry` directly, because
  `commands/index.ts:142` imports `./tour.js`, `import/no-cycle` is an error
  (`eslint.config.mjs:274`), and the rule follows transitive edges, so no intermediate module escapes
  it.
- The renderer keeps `readTour` in `parse()` — the effect still crosses IPC and the shape is still
  worth deciding there — and its comment, along with the module comment in
  `src/shared/tourcheck.ts`, stops claiming `show_me` is the only entrance.

This is the third construction of the same catalog: `main/index.ts:661` for the stack,
`session.ts:1327` for `show_me`'s own `Known`, and now the host field. Consolidating them is a
separate change; `createDesktopRegistry` only registers definitions, so a third call costs nothing
at runtime.

**Verify.** `src/main/tests/tours.test.ts` gains two cases: `tourStart.run` with a `custom` naming a
command that does not exist rejects, and one naming a real command with real props resolves. The
file already builds the registry and the interactions, so it can build the same `Known` main does.
`renderer/rules/tests/anchors.test.ts` gains a case for a step with no id resolving `unanchored`
rather than ringing an item anchor.

## Stage 4 — gesture verdicts come only from open panes

**The bug.** `gestureState` never removes entries, and `verdictsFor` judges against whatever last
registered the namespace whether or not that pane is open. The doc comment admits the leftover entry
and argues it is harmless because the anchor lookup then finds nothing in the closed editor — true of
where the ring goes, and not of the verdicts the guidance text is built from. `gesture()` tests the
`UNRESOLVED` verdict before it resolves what the author would pick up
(`renderer/rules/tour.ts:158-165`), so a closed pane's refusal is reported as the step's answer.

**What changes.**

- `renderer/pathux/gestures.ts`: `verdictsFor` takes the open set as a third parameter and answers
  `undefined` for a namespace whose editor is not in it. `undefined` already means "no open surface
  holds the state this is judged against", which is what a closed pane is; `gesture()` turns it into
  "Nothing on screen runs `<id>` yet."
- `renderer/pathux/tour.ts`: `shownNow` reads `openPanes()` once, passes it to `anchorSnapshot`, and
  passes `guide` a closure `(id, carried) => verdictsFor(id, carried, panes)`. The `Judge` type
  (`renderer/rules/tour.ts:130-133`) and what `guide` calls are unchanged.
- The `gestureState` doc comment records that the open check is what makes a leftover entry
  harmless, replacing the anchor-lookup argument.

An entry for a pane that is open but showing a different subject still answers, and should: the
`UNRESOLVED` reason names the scene it is on, which is the useful sentence.

`verdictsFor` has one caller. Main's `interaction.*` commands reach the interactions through
`desktopInteractions` and `stateFor`, a separate path, and no test imports it.

**Verify.** `renderer/pathux/tests/gestures.test.ts`, new: registering a namespace and asking with
the editor absent from the open set returns `undefined`; with it present, the verdicts come back.
`gestures.ts` imports only `src/shared/interactions.ts`, so it is node-testable.

## Stage 5 — an `input` step waits for a value

The one stage that changes a path working today. It can be dropped without affecting the others.

**The behavior.** `satisfies` skips the typed prop when matching (`renderer/rules/tour.ts:210-224`)
and never asks whether the author supplied one, so committing the field empty advances the step and
the tour says "Done" over a no-op.

The review's example does not fire: `project.setKey` with an empty key returns
`{ ok: false, message: 'No key given.' }` (`src/main/session.ts:3591`), `run` throws, and `ran()`
returns before `satisfies` because `outcome.ok` is false. The real case is `art.setNotes`, where
empty is a documented legitimate value ("empty removes it") — so the command is right to accept it
and the tour is wrong to count it. The rule belongs to the step rather than to the prop: an `input`
step exists to have the author supply a value.

**What changes.** `satisfies` returns false for an `input` step whose typed prop came back
undefined, empty string, or empty array.

**What it cannot see.** `digestProps` skips only `undefined` (`packages/commands/src/digest.ts:44`),
so an empty `prop.secret` is recorded as `<secret>` and an empty `prop.digest` as a hash of the empty
string — both non-empty, both indistinguishable from a real value. The rule therefore does not cover
an input step on a redacted prop. It is harmless for the one such step that exists, since
`project.setKey` refuses an empty key before the record is written, and there are no `prop.digest`
call sites at all. It is a limitation of the rule rather than a case the rule handles.

**Verify.** `renderer/rules/tests/tour.test.ts`.

**Docs.** The Advancing section of
[`../reference/guided-tours.md`](../reference/guided-tours.md) says an `input` step "matches
regardless of the value the author typed"; it becomes regardless of the value, provided there is one,
with the redacted-prop limitation named.

## What it costs to undo

- Stages 2, 4 and 5 are a few lines each inside one function; reverting is a revert. Stage 2's
  palette teardown is worth keeping either way, since it fixes `tour.cancel` independently.
- Stage 3 leaves `known` on `CommandHost` behind if only the check is reverted. It is one field with
  one filler, and nothing else reads it. The `resolveAnchor` id guard is independent of the rest.
- Stage 1 is the widest. Reverting means deleting `resolveSubject`, the `pick` variant and its four
  consumers, restoring the two-line `wrong-subject` case, and taking `holds` back out of
  `Subsumption`, the `wrong-subject` `Resolution` and the four anchor tests that assert on them.
  `holds` is computed inside `subsumes` from what it already has, so no editor and no `publishes`
  record changes — the anchor-recording surface is untouched, which is what keeps this a leaf change
  rather than a contract across five editors.

## Review

Pressure-tested by a fresh-context agent on 2026-09-03, per
[`../reference/conventions.md`](../reference/conventions.md#plans). Eleven findings; the disposition
of each:

1. **The value-only subject match is unsound** — `subsumes` puts every unmatched prop into `needs`,
   not only subject ids, so a step's `speaker:'aiko'` would ring the character row and stick.
   **Fixed**, and it is why Stage 1 was rewritten: `subsumes` now reports `holds`, and only held
   props are searched.
2. **Stage 1 does not resolve `art.*` rungs below the entity** — no `publishes` record and no
   document-tree node carries `character:aiko/gala`. **Accepted and stated**: those steps answer
   `blocked`, which is the right outcome because the alternative is a note written onto the wrong
   rung. [What it reaches](#what-it-reaches) now says which commands resolve and which refuse, and
   the rung-to-asset index is named as out of scope.
3. **`stop()` never closes a routed palette**, so reusing it on restart would leave a form over the
   new tour's ring. **Fixed**: Stage 2 closes the palette in `stop()` first, which also fixes
   `tour.cancel` over a routed step.
4. **`select` collides with `Step`'s `kind: 'select'`.** **Fixed**: the variant is `pick`.
5. **`asks()` in `overlay.ts` is a fourth consumer, and it fails open.** **Fixed**: all four are
   listed, `asks` with the reason its default is correct, and the undo section no longer claims the
   compiler names every site.
6. **The secret exemption is wider than claimed** — `digestProps` skips only `undefined`, so an empty
   secret records as `<secret>`. **Fixed**: stated as a limitation of the rule, with `prop.digest`
   named as the latent case.
7. **`unselectable` was undefined, and a non-string conflict would misdescribe the screen.**
   **Fixed**: `missing` is specified, and the `holds`-empty and no-string-value paths keep today's
   ring. The related observation that a disabled empty-props anchor reaches `wrong-subject` is also
   fixed, by answering with the control's own refusal.
8. **Stage 3's cycle and cheapest-fix claims check out**, with two additions. **Both taken**: the
   third catalog construction is named, and the `anchor.id !== undefined` guard is now part of the
   stage.
9. **Stage 4 is sound; the closure was left implicit.** **Fixed**: spelled out, along with the fact
   that `verdictsFor` has one caller.
10. **Stage 2's cost estimate was low** — the clear fires for non-mutating navigation too.
    **Fixed**: stated, with the reason for clearing unconditionally.
11. Every other file:line claim verified correct. No action.
