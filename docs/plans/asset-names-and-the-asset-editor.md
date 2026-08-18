# Asset names, the asset editor, and art notes

## Context

`todos.md` holds two open items, both about the Assets branch of the document tree:

1. asset rows show `a1b2c3d4.png` — a hash, not a name;
2. clicking an asset should open an editor that previews it, lets the author **change its
   prompt**, regenerate it through the task graph, and approve it — placed in the largest pane
   that is *not* the one the tree was clicked from, or focused if it is already open.

Item 2's "update its prompt" cannot be taken literally. A prompt is a pure derivation
(`packages/pipeline/src/prompts.ts`), it is folded into the task's content hash, and
`planner.ts:341` overwrites `shot.prompt` on every planning pass — so there is no prompt to edit,
and an editable one would freeze that asset against every future improvement to the builders.
The user's own framing settles what is actually wanted: *"we do need some means for authors to
tweak assets. this will probably happen through the agent (e.g. 'make x location asset have more
of an architectural style like y')."* `vnauthor` is forbidden by the boundaries lint rule from
importing `@vn/pipeline`/`@vn/scheduler`, so the tweak has to be an **authored input field** —
one the agent already has a write path to, and one the prompt builders append to.

That field is `artNotes`. Because it enters `TaskInputs.prompt`, editing it re-keys the task; the
planner plans a fresh one and the next run regenerates exactly the assets it reached. No new
scheduler machinery, and the same edit is reachable from the agent, the palette and the new pane.

This is work item 13 in [`refactorTaskList.md`](refactorTaskList.md) ("generation from an
authored surface"), which was **needs plan** until this page.

## Decisions already taken (with the user)

- **Art notes live at five rungs**: `Character`, `Location`, `Shot`, **each `LocationVariant`** and
  **each `Outfit`** — so "the café *at night* is more architectural" and "her *track* outfit reads
  sportier" are separable from the entity as a whole.
- **Notes are appended to the derived prompt, never a replacement.** The style preamble, the
  reference scaffolding and the closing "single illustrated frame, no UI text" must survive.
- **The asset surface is a new `asset` editor — the eleventh** — keyed on a new `ui.assetHash`.
  Not the Inspector: its subject is a *task* hash, and an art-notes edit re-keys the task, leaving
  the Inspector pointing at nothing.
- **Labels are display names**: `Aiko`, `Aiko — uniform / front`, `Café Mori — night`, with a
  `(hash8)` suffix only on collision. Shot frames read `<sceneId> · <shotId>`, because that is how
  the tree already labels scenes and shots (a `Scene` has no title field).

## Stage 1 — descriptive asset labels (todo #1)

One choke point: the asset leaf in `apps/desktop/src/main/doctree.ts:155-179`.

- New pure module `apps/desktop/src/main/assetlabel.ts` with
  `assetLabel(asset, ctx): string` and `labelAssets(assets, ctx): Map<hash, string>` (the second
  applies the collision rule). `ctx` carries the model's characters and locations plus a
  `angleOf(sourceTask)` lookup.
  - `portrait` `{characterId}` → `Aiko`
  - `model_sheet` `{characterId, outfit}` → `Aiko — uniform / front`; the **angle is not in
    `Asset.satisfies`** (`runners.ts:88`), so it comes from `task.inputs.angle`.
  - `location_ref` `{locationId, variant}` → `Café Mori — night`
  - `shot_image` `{sceneId, shotId}` → `greet · s2`
  - no binding, or a binding naming something the model has lost → `a1b2c3d4.png` (today's label)
  - two assets in one group landing on the same label → both get ` (a1b2c3d4)`
- `buildDocTree` takes the labels through `DocTreeInput` (a new `assetLabels: Map<string,string>`
  or a `tasks` map — prefer passing the finished labels, keeping `doctree.ts` a projection).
  `WorkspaceSession.docTree()` (`session.ts:443-470`) already calls `loadProject`, which loads
  `project.graph`, so the angle lookup costs nothing extra.
- `linksFor` (`doctree.ts:185-224`) gets the same labels, so the backlink panel names assets too.
- Asset nodes deliberately keep **no `path`**: `documents.ts`'s open path routes `node.path` to the
  `wiki` editor, which would `doc.read` a PNG.
- Tests: `apps/desktop/src/main/tests/assetlabel.test.ts` — one case per kind, the unbound
  fallback, and the collision suffix. (No existing test pins the asset leaf label.)

## Stage 2 — `artNotes` as an authored field

**Types** (`packages/types/src/entities.ts`): `artNotes?: string` on `Character`, `Location`,
`Shot`, `LocationVariant`, `Outfit`. `Shot.camera?` is the existing precedent for free-form art
direction on an authored shot.

**Front-matter** (`packages/types/src/schemas.ts`). Outfits and variants are flat strings today
(`outfits: z.record(z.string())` :35, `variants: z.array(z.string())` :52), so both grow a second
accepted form and keep the first:

```yaml
art_notes: ink-wash linework, high contrast # character/location, top level
outfits:
  track: sports uniform, mid-thigh # legacy string form: description only
  gala:
    description: floor-length navy dress
    art_notes: satin sheen, rim light
variants:
  - day # legacy string form: id only
  - id: night
    description: after close, chairs up
    art_notes: sodium streetlight raking across the formwork
```

- `outfits: z.record(z.union([z.string(), z.object({description, art_notes?}).strict()]))`
- `variants: z.array(z.union([z.string(), z.object({id, description?, art_notes?}).strict()]))`
- `shotsFileSchema`'s shot object gains `artNotes: z.string().optional()` beside `camera`
  (camelCase, like `coversLines`). `shotDecompositionSchema` is **not** touched — art direction is
  authored, not proposed by the LLM.

**Round-trip** (`packages/model/src/entities.ts` / `serialize.ts`), keeping
`fromDoc(toDoc(x)) ≡ x`:

- `wardrobeOf` (:57) normalizes both forms into `Outfit[]`; `wardrobeData` (serialize :28) writes
  the **string** form when an outfit has no notes and the object form when it does.
- `locationFromDoc` (:153) stops discarding variant text — `fm.variants.map(...)` yields
  `{id, description, artNotes}`; `locationToDoc` (:62) writes a bare string when both are empty.
- `CharacterEdit`/`LocationEdit` (serialize :223, :268) gain `artNotes?: string`, and their
  `outfits` / `variants` fields widen to the richer shapes so the agent can set a per-rung note.
- Tests in `packages/model/src/tests/`: legacy string forms round-trip byte-identically; the object
  forms round-trip; a hand-written comment above an untouched key survives (`applyCharacterEdit`
  already preserves unnamed keys).

**Prompts** (`packages/pipeline/src/prompts.ts`). Each builder gains one clause, placed
immediately before the closing scaffolding sentence, entity note first and the specific rung
second (later reads as stronger):

- `buildPortraitPrompt` → `character.artNotes`
- `buildLocationPrompt(location, variant, config)` — signature unchanged; it looks the variant up
  in `location.variants` itself → `location.artNotes`, then the variant's `description` and
  `artNotes`
- `buildModelSheetPrompt(character, outfit, angle, config)` — likewise looks the outfit up →
  `character.artNotes`, then the outfit's `artNotes`
- `buildShotPrompt` → `shot.artNotes` only. Entity notes reach a shot through the plates and
  sheets it references, which were generated with them; re-stating them would double the voice.

**Hash stability is the acceptance test**: every builder already ends in
`.filter(Boolean).join(' ')`, so a project that authors no notes must produce byte-identical
prompts. A pipeline test asserts this against the sample project — otherwise the change re-keys
every task in every existing project and re-renders the world.

## Stage 3 — agent reach (`vnauthor`)

`packages/authoring/src/tools.ts`: `edit_character` (:363) and `edit_location` (:395) already run
`applyCharacterEdit`/`applyLocationEdit` and write through `docToMarkdown`, so only their zod
shapes change — add `artNotes`, widen `locationEditShape.variants` (`z.array(z.string())` today)
and the character `outfits` record to the union forms above. Their tool descriptions gain one
sentence saying what art notes are for and that changing them **re-renders the assets they
reach**, which is the sentence the agent needs to warn the author with.

Deliberately absent: a shot-level art-notes tool for the agent. It stops at authored inputs; if it
is wanted later, `set_outfit` (which reaches the shots file through `@vn/scriptedit`) is the
precedent to copy.

## Stage 4 — commands

Four new definitions in `apps/desktop/src/main/commands/`, wired in `index.ts` and covered by
`commands/tests/`.

`asset.ts` (new namespace, new file):

- **`asset.info(hash)`** — non-mutating. Returns the manifest entry (kind, ext, base/project,
  accepted, `sourceTask`, recorded `prompt`), the display label from Stage 1, the **freshly
  derived** prompt for the same binding, a `stale` flag (`derived !== asset.prompt` — exactly what
  an art-notes edit produces), and the art-notes rungs that apply to it: for each, its `target`
  string, current text, and whether the rung exists.
- **`asset.accept(hash)`** — `store.accept(hash)`, generic across both roots
  (`assetstore.ts:241`). Its `check` **refuses a portrait by name**, saying `gate.approve` is the
  command that also writes `character.md` and `approved.png` (`session.approveCharacter`
  :425-436).
- **`asset.regenerate(hash, run=false)`** — requeues the asset's `sourceTask` by appending a
  `pending` snapshot of the node to `vngen/state/tasks.jsonl` with `@vn/taskgraph`'s `logTask`
  (`loadGraph` replays last-writer-wins, which is how `requeueFailed` in `scheduler.ts:64-89`
  already works), bounded — like `requeueFailed` — to tasks in the **current planned set**, since
  `tasks.jsonl` is never pruned. `confirm: true`. Refusals: no `sourceTask`, an orphaned task, a
  base root that is `unavailable` (`planner.ts:202`). With a fixed `image_params.seed` a plain
  re-roll is deterministic — the refusal text says so, and points at art notes as the way to
  actually change the picture. `run: true` chains the existing `pipeline.run`.

`art.ts` (new namespace, new file):

- **`art.setNotes(target, notes)`** — one field, one rung. `target` uses the document tree's
  `kind:key` join vocabulary, extended by one `/sub` segment:
  `character:aiko`, `character:aiko/gala`, `location:cafe`, `location:cafe/night`,
  `shot:greet/s2`. Writes:
  - character/location targets → the sheet named by `entityFile(docs, id)`, through
    `applyCharacterEdit`/`applyLocationEdit` + `writeFileAtomic` (the same path `edit_character`
    takes, so one authorial act has one answer);
  - shot targets → `work/shots/<sceneId>.json`.
  Opt into the undo journal and the `Committer`, like the `story.*` document mutators. `check`
  refuses an unknown target, an entity with no sheet on disk, and an outfit/variant/shot id that
  does not exist — never creating one implicitly.

Two invariants this bends, and both docs get updated in Stage 6:

- `work/shots/<sceneId>.json` grows a **fourth** writer outside the planner (today:
  `story.setCoverage`, `story.setOutfit`, `editScene`).
- A non-scene document gains a **structured** writer beside the byte-level `doc.*`. The rule
  becomes: bytes move only through `doc.*`; a *named field* may also be set through a command that
  round-trips via `@vn/model`'s `apply*Edit`.

## Stage 5 — the eleventh editor and where it opens (todo #2)

**Registration.** One entry in `apps/desktop/src/shared/editors.ts` (`EDITORS`), one
`registerEditor(AssetEditor, 'vn.AssetEditor')` — never by hand, per the nstructjs naming rule —
and one import line in `renderer/pathux/shell.ts`. `shared/tests/editors.test.ts` currently pins
the count and the bidirectional `editorNameProblems` check; update it.

**Subject routing.** `ShellState` (`renderer/pathux/state.ts`) gains `assetHash = ''`, documented
like `taskHash`: machine identity, therefore **not persisted**. `withSubject` in
`renderer/pathux/view.ts` currently always writes `ui.docPath`; it becomes a small per-editor map
(`wiki`/`documents` → `docPath`, `asset` → `assetHash`), because pointing `docPath` at a `.png`
would make the wiki editor `doc.read` a binary.

**`elsewhere` placement.** Add `'elsewhere'` to `OpenWhere` / `OPEN_WHERE`
(`shared/editors.ts:34`), to the `WHERE` label map (`commands/view.ts:17`) and to the renderer's
`SPLIT` handling. New `paneElsewhere(panes, from)` in `renderer/pathux/panes.ts` beside
`paneToUse` — the biggest non-chrome pane that is not `from` (`const area = (p) => p.width *
p.height` is already there), falling back to splitting `from` when it is the only one. Order of
resolution in `open()`: already showing → `focus` it; else `paneElsewhere`; else split.
Tests in `renderer/pathux/tests/panes.test.ts`.

**Selection from the tree.** `selectionForNode` in `renderer/pathux/doctree.ts:71-100` gains an
`asset` case (`{...current, assetHash: key}`) and `nodeIsSelected` matches it. The renderer test
that pins "returns the very same selection for a node that names nothing"
(`tests/doctree.test.ts:137`) must move to a node kind that still names nothing (`more`), since
that contract is deliberately changing for assets.

**The click.** `DocumentsEditor.pick()` (`editors/documents.ts:413`) publishes the selection and,
for an asset node, dispatches
`exec('view.open', {editor: 'asset', where: 'elsewhere', subject: hash})` — mirroring `openDoc`
(:447).

**The pane** — `renderer/pathux/editors/asset.ts`, modeled on `inspector.ts` (same `stateKey()`
/ `drawn` repaint idiom, same coarse `onExec`/`onInvalidate` refetch):

- header: label, kind, `base`/`project`, `accepted`, `hash8.ext`
- the image, via `vnasset://<hash>.<ext>` — a raw DOM surface, so `VnEditor.appendSurface` plus
  `adoptStyle`, per the shadow-root rule (`documents.ts:393` `thumb()` is the existing example)
- the derived prompt, read-only, with a "rendered with an older prompt" banner when
  `asset.info` reports `stale`
- one text box per applicable art-notes rung (entity, and variant/outfit/shot), each committing on
  Ctrl+S or blur via `art.setNotes`
- buttons: **Approve** (`gate.approve` for a portrait, else `asset.accept`), **Regenerate**
  (`asset.regenerate` then `pipeline.run`, both already confirmed), **Show task** (sets
  `ui.taskHash` and opens the inspector)

Logic that can be pure goes in a `.ts` sibling with `tests/` — the desktop jest project is
node-only, so the surface itself is verified live over CDP.

## Stage 6 — docs and bookkeeping

- Copy this plan to `docs/plans/asset-names-and-the-asset-editor.md` **before the work starts**,
  keep it current, and list it in `docs/index.md`.
- `docs/plans/refactorTaskList.md` row 13: **needs plan** → link this plan (and mark shipped at
  the end).
- `docs/document-tree.md`: the asset label rule, and why asset nodes carry no `path`.
- `docs/desktop-app.md`: an `asset` section; the editor count; `elsewhere`.
- `docs/command-system.md`: the `asset.*` and `art.*` namespaces, the fourth shots-file writer,
  and the refined "documents are written as text" rule.
- `docs/pipeline-contracts.md` + `CLAUDE.md`: art notes as an authored field that **does**
  re-render what it reaches (the outfit invariant is the model for the wording), eleven editors,
  and the amended `doc.*` rule.
- `todos.md`: flip both `[ ]:` to `[x]:` — wording, ordering and whitespace untouched.
- Remove every `CLAUDENOTE:` and audit comments in the touched files.

## Verification

1. `pnpm check` **and** `pnpm check:renderer`, `pnpm test`, `pnpm lint`, `pnpm build`.
2. **Hash stability** — the key regression. Against a copy of `examples/sample` with no art notes
   authored: `node apps/cli/dist/cli.js cost <copy>` before and after the change must plan the
   same task hashes. The pipeline unit test asserts the same thing at the builder level.
3. **Labels**: `node scripts/vn-cdp.mjs "workspace.doctree()"` — asset leaves read
   `Aiko — uniform / front`, not `a1b2c3d4.png`.
4. **The pane**: `pnpm vndesktop --mock`, click an asset in the documents tree with two panes open
   — it opens in the *other* pane; click a second asset — the same pane updates; close it and
   click again with only one pane open — it splits.
5. **Round-trip**: `node scripts/vn-cdp.mjs "art.setNotes(target=location:cafe/night notes='sodium
   streetlight raking across the formwork')"`, then confirm `locations/cafe.md` gained only the
   variant's `art_notes` (`git diff`), and that `vngen cost` now plans a new `location_ref` task
   while every other task hash is unchanged.
6. **Agent**: `pnpm vnauthor <copy> --mock`, ask it to make the café more architectural; it should
   propose an `edit_location` plan touching `art_notes` and say the plates will re-render.
7. **Approve / regenerate**: from the pane, approve a non-portrait asset (`manifest.json` flips
   `accepted`), and confirm the portrait path refuses by name and points at `gate.approve`.

### What the run showed

Run against a throwaway copy of `examples/mySampleRepo` (56 generated assets), the app on CDP:

- **1** green: `pnpm check` (both passes), `pnpm test` (105 suites / 1382 tests), `pnpm lint`,
  `pnpm build`.
- **2** `cost` on the copy: `pending tasks: 0`, gate cleared — the whole existing project re-planned
  to the same hashes, so `artClause` moved nothing. `asset.info` on a plate reported
  `prompt === derived` for the same reason.
- **3** labels came back as `School Rooftop — evening`, `Aiko — uniform / front`, and
  `greet · greet__beat1 (09dd1198)` — the suffix being the collision rule firing where refine
  attempts left several frames satisfying one shot.
- **4** with four panes open, the asset opened in the biggest one that was not the tree's; a second
  asset reused it (`img.naturalWidth === 1024`, two rung boxes); closed down to one pane it split
  50/50, and the plate edited in step 5 came back `stale: true`.
- **5** `art.setNotes(target='location:rooftop/evening' …)` wrote `locations/rooftop.md` alone,
  turning the bare `- evening` into `id:` + `art_notes:`, and `cost` then planned exactly one
  `location_ref` and nothing else.
- **7** `asset.accept` flipped `accepted` on a plate; the same check on a portrait refused with
  `gate.approve(characterId='aiko' hash='…')` spelled out.
- **6 could not be run offline.** `vnauthor --mock` answers that it cannot reason without a model,
  so the agent path rests on `packages/authoring/src/tests/tools.test.ts`, which drives
  `edit_location` with `artNotes` plus a variant's `art_notes` and asserts the file it writes.

## As shipped

All six stages are built, and every decision above held. Ten things the plan did not say:

- **The label context is a function, not a hand-built object.** `labelContext(model, graph)`
  (`assetlabel.ts`) folds the characters, the locations and the `angleOf(taskHash)` lookup into one
  value, so `docTree()`, `linksFor` and `asset.info` cannot build three subtly different contexts
  from the same session. `assetLabel` returns `undefined` rather than a fallback string, and
  `labelAssets` is where the fallback and the collision suffix both live — one place that knows what
  the whole group looks like is the only place that can answer either question.
- **The derived prompt got its own module.** `assetprompt.ts`'s `derivePrompt(asset, ctx)` maps a
  binding back to the builder that would write it today. `asset.info` needs it to answer `stale`,
  and it is deliberately *not* in `@vn/pipeline`'s planner path: this is a read for a surface, and
  planning must stay the only thing that decides what gets rendered.
- **Art rungs got theirs too.** `artnotes.ts` holds `ArtTarget`, `parseArtTarget` /
  `formatArtTarget`, `rungAt` (one rung, for the write path) and `rungsFor` (every rung reaching an
  asset, for the pane). The command and the pane therefore agree on the vocabulary by construction —
  the string in a refusal is the same string the box is keyed by.
- **`art.setNotes` is `previewArtNotes` + `setArtNotes` on the session**, mirroring the `story.*`
  pattern: `check` renders the preview's sentence either way, and `run` throws the same sentence, so
  the refusal an author reads before acting is the refusal they would get.
- **`artClause` is variadic and trims.** `artClause(entity?, rung?)` filters empties and joins with
  a space behind one `Art direction:` lead, which is why a project with no notes produces
  byte-identical prompts: the clause is `''` and the builders' existing `.filter(Boolean)` drops it.
  That is asserted in `packages/pipeline/src/tests/pipeline.test.ts` rather than only by hand.
- **The variant lookup moved into the builder, and `Location.variants` now carries text.**
  `locationFromDoc` stopped discarding variant descriptions, so `buildLocationPrompt` looks the
  variant up itself and appends both its description and its notes. The legacy string forms
  (`variants: [day]`, `outfits: {track: '…'}`) round-trip byte-identically — pinned by tests, since
  the whole point is that no existing project moves.
- **A rung edit resends the whole list, and leaves empty keys out.** `applyCharacterEdit` /
  `applyLocationEdit` replace the wardrobe map and the variant list wholesale, so
  `art.setNotes` rebuilds them from what the model already normalized with the one entry changed —
  writing the long form only for entries that need it, and omitting `description` when the author
  never wrote one, which is what `wardrobeData` / `variantData` do on the serializer side. A
  variant that was the bare string `- evening` therefore becomes `id:` + `art_notes:` and nothing
  else.
- **`ui.assetHash` needed `withSubject` to become a map.** `view.ts` routed every `subject` to
  `ui.docPath`; it is now per-editor (`wiki`/`documents` → `docPath`, `asset` → `assetHash`), and
  `view.open`'s `subject` description says so. Nothing else about `view.*` changed.
- **`elsewhere` resolves in three steps, and `paneElsewhere` is only the middle one.** Already
  showing → focus (which is `paneShowing`, unchanged); else the biggest non-chrome pane that is not
  the asking one; else split the asking pane right. The tests pin the two cases that would be easy
  to get wrong: it never returns the asking pane even when that pane is the biggest, and it answers
  `NO_PANE` when there is nothing else.
- **The pane suppresses its own refetch while a box is dirty.** `onInvalidate` fires on every
  successful mutating command and on undo, including this pane's own `art.setNotes`; refetching
  under a half-typed note in another rung would discard it, so a dirty set gates the subscription
  and a `token` counter drops a slow read for an asset the author has already left.

## Afterwards: the seed rides the same rungs

Added later, under [`the-todos-sweep.md`](the-todos-sweep.md) — recorded here because it reuses
every mechanism above rather than adding one.

An **image seed** is authored at the same five rungs art notes are: `ArtRung` grows `seed`, the
rung box grows a narrow number field in its heading, and `art.setSeed` writes it through
`locateRung` — the refusals `art.setNotes` already gives, factored out so both halves say the same
sentence. `Character`, `Outfit`, `Location`, `LocationVariant` and `Shot` each gain `seed?: number`,
serialized the way `artNotes` is: an entry that authored none grows no key, and the short form
stays short.

Two differences follow from it being a number rather than a paragraph, and neither is optional:

- **It is not art direction.** Notes say how the picture should look; a seed asks for a *different*
  picture of the same words. Hence the box beside the notes rather than under them, and its own
  tooltip.
- **Zero is a seed.** Every "did the author write one?" test is `=== undefined`, never falsiness —
  which is why `setOrClear` could not be reused (`setSeed` in the serializer exists for this),
  `null` clears at the model, `-1` is the command prop's sentinel, and an empty box is "inherit" in
  the editor, placeheld by `AssetInfo.configSeed` so it names what it inherits.

The chain — character → outfit, location → variant, a shot alone, falling back to
`config.image_params.seed` — is written down **once**, in `seedFor` (`packages/artgen/src/prompts.ts`),
and applied *inside* `portraitInputs` / `locationInputs` / `modelSheetInputs` / `shotInputs`. No
planner call site changed, which is the point: adoption and `promoteConcept` build their inputs
through the same four functions, and a disagreement here would strand a shot on a plate nothing
planned.

## Out of scope

- Editing a prompt directly — the reason is in Context.
- A shot-level art-notes tool for `vnauthor`.
- Any change to `shotDecompositionSchema` (the LLM does not propose art direction).
- Watching the filesystem; both trees stay refetched-after-write.
