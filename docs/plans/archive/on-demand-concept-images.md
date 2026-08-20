# On-demand concept images, and promoting one to a plate

## Context

The author asked for a way to make a picture that the pipeline never asked for:

> I need to be able to have the agent directly create location assets, e.g.
> `/makeimage create an aerial shot of the high school` or something.

Nothing in the system does this today. Every image is the output of a **planned task**: the
planner derives a prompt from an authored sheet, mints a content hash over it, and the scheduler
runs it. That is the right shape for the art a story needs — a plate per used variant, a portrait
per used character — and it is deliberately closed: there is no "just render this sentence" door,
because a sentence has no rung to hang from and nothing downstream to serve.

But an author sketching a place wants exactly that door. The picture is a **concept** — a thing to
look at, to argue with, to paste into the wiki — not a promise the pipeline has to keep. And
sometimes the sketch turns out to be the real thing, at which point it should become the plate
rather than being re-rendered from scratch by the next `vngen run`.

The architectural obstacle is the layering. `vnauthor` is forbidden by the boundaries lint rule
from importing `@vn/pipeline`/`@vn/scheduler`, so it cannot reach `buildLocationPrompt`,
`imageParams`, or any runner. It *can* reach `@vn/providers` and `@vn/store` — everything needed
to generate and persist an image — but not the prompt scaffolding that makes the result look like
this project's art rather than a stock illustration. That gap is the whole reason this plan opens
a package instead of adding a tool.

This is the `@vn/scriptedit` / `@vn/bible` situation again, third time: **both the agent and the
desktop need the same policy, so it belongs to neither.**

## Decisions already taken (with the user)

- **A generated image is a `concept` by default, and promotable.** Ship a new `concept` asset
  kind — generated on demand, bound to the location or character it names, visible in the document
  tree, the asset editor and the backlink panel, and **never planned, never consumed, never
  exported**. Then a second, separate act promotes one to a real location-variant plate: it writes
  the variant onto the location sheet and records the planner's own task as `done`, so the next
  `vngen run` **adopts** the image instead of regenerating it.
- **Two surfaces, one implementation.** A `generate_image` tool plus `/makeimage <sentence>` in
  the `vnauthor` REPL, *and* an `art.generate` command in the desktop palette and agent pane that
  opens the result in the Asset editor. Both are thin wrappers over the shared leaf.

## Decisions this plan settles

- **The leaf is `@vn/artgen`**, and it takes prompt composition with it. `packages/pipeline/src/prompts.ts`
  moves there wholesale and `@vn/pipeline` re-exports it, so every existing prompt stays
  byte-identical and every existing task hash stays where it is. `baseRefusal` moves with it, for
  the same reason: an unavailable base root must refuse a concept in the same sentence it refuses a
  plan.
- **A concept is never `accepted`.** `accepted` means "a human approved this for use downstream",
  and nothing downstream consumes a concept. The Asset editor's Approve button refuses a concept by
  name and points at `art.promote`.
- **`@vn/authoring`'s allow-list gains `artgen` and nothing else.** `artgen` reaches
  `@vn/taskgraph` (it must, to mint the planner's hash); the agent still cannot, because the
  boundaries rule is per-import, not transitive.
- **Promotion targets a location variant only.** A character concept promoted to a portrait would
  walk around the P3 gate, which owns `character.md`, `approved.png` and the whole approval story.
  `art.promote` refuses a character concept by name and says so.

## Stage 1 — `@vn/artgen`, the shared leaf

New source-only package `packages/artgen`, allow-list
`['types','util','config','parse','model','store','providers','taskgraph']`, added to
`eslint.config.mjs`'s `ALLOWED` map and to the layering diagram in `CLAUDE.md` beside `export` /
`scriptedit` / `bible`. It is **node-side only** — it touches the store — so it never appears in
`apps/desktop/src/shared/`.

**`src/prompts.ts`** — moved verbatim from `packages/pipeline/src/prompts.ts`, imports unchanged
(`@vn/types`, `@vn/config`, `@vn/model`). `packages/pipeline/src/prompts.ts` becomes a one-line
re-export so `runners.ts`, `planner.ts`, `apps/cli/src/commands.ts`,
`apps/desktop/src/main/assetprompt.ts` and `apps/desktop/src/main/session.ts` keep their current
import paths. The pipeline's prompt tests move with the code; the re-export is covered by the
existing hash-stability test.

**`src/base.ts`** — `baseRefusal(base?: BaseAssets)`, moved from `planner.ts` and imported back.

**`src/subject.ts`** — pure, unit-tested:

- `ConceptSubject = {kind: 'location', id} | {kind: 'character', id} | undefined`
- `matchSubject(model, sentence): ConceptSubject` — case-insensitive match of each location's and
  character's `name` and `id` against the sentence, **longest match wins**, locations before
  characters on a tie. This is a convenience, not a contract: every surface reports what it matched
  and takes an explicit override.
- `conceptPrompt(sentence, subject, model, config): string` — the composition, in the same shape
  every other builder has and for the same reason (the preamble and the closing framing sentence
  are what keep a generation on-model):

  1. `stylePreamble(config)`
  2. the subject's grounding, when there is one: `Subject: <name>.`, its `description`, its `mood`
     (location) and `paletteClause` — the same clauses `buildLocationPrompt` /
     `buildPortraitPrompt` use, so a concept of the café looks like the café
  3. `artClause(entity.artNotes)` — an entity's authored art direction applies to a sketch of it
  4. **the author's sentence, verbatim, last** — later reads as stronger, and this is the one thing
     they actually typed
  5. `'Single illustrated concept frame. No text, no UI, no watermarks.'`

**`src/concept.ts`** — the act:

```ts
export interface ArtGenDeps {
  config: ProjectConfig;
  store: AssetStore;
  image: ImageProvider;
  model: ProjectModel;
}
export interface ConceptRequest {
  sentence: string;
  /** Explicit subject; omitted means `matchSubject` decides. */
  subject?: ConceptSubject;
}
export interface ConceptResult {
  ref: AssetRef;
  subject?: ConceptSubject;
  prompt: string;
}
export async function generateConcept(deps: ArtGenDeps, req: ConceptRequest): Promise<ConceptResult>;
```

- refuses an empty sentence, and refuses when `baseRefusal(store.base)` speaks (a concept is
  base-routed; writing into a root whose manifest is missing is how you lose the manifest)
- references: a bound concept feeds the subject's existing art as an identity reference — a
  location's accepted plates (any variant, oldest first, capped at 2) or a character's approved
  portrait — so "an aerial shot of the high school" is a shot of *that* high school. An unbound
  concept generates from words alone.
- `store.write(bytes, ext, {kind: 'concept', sourceTask, satisfies, prompt, refs, modelId})`,
  `accepted` left false.
- `sourceTask` is `sha256` of `{prompt, params, refs}` via `@vn/util` — a **request** hash, not a
  node in the graph. `Asset.sourceTask`'s doc comment widens to say so, which is cheaper and more
  honest than making the field optional and forcing every consumer to handle absence.

**`src/promote.ts`** — Stage 5, below.

## Stage 2 — the `concept` asset kind

`AssetKind` (`packages/types/src/entities.ts:10`) gains `'concept'`, and it joins `BASE_KINDS`
(`packages/store/src/assetstore.ts:48`): a concept is authored-side art that belongs beside the
plates and portraits in the base subtree, and promotion must not move bytes between roots.

The kind reaches five sites, all of which currently enumerate kinds exhaustively:

| Site | What it needs |
| --- | --- |
| `apps/desktop/src/main/doctree.ts:62` | a `Concepts` group. The asset groups sort alphabetically by kind, so it lands first rather than last — a position, not a policy, and not worth a special case |
| `apps/desktop/src/main/assetlabel.ts:46` | `<entity name> — <sentence>`, from the new `Asset.title`; an unbound concept is named by the sentence alone, and one with neither falls back to today's `a1b2c3d4.png` |
| `apps/desktop/src/main/assetprompt.ts:35` | no derived prompt: a concept's prompt **is** its recorded prompt, so it can never read `stale` |
| `apps/desktop/src/main/artnotes.ts:104` | the entity rung only (a concept has no variant/outfit/shot rung), and editing it does **not** re-render the concept — the note reaches the *next* one |
| `packages/store/src/assetstore.ts:52` | `BASE_KINDS` |

`apps/desktop/renderer/rules/taskGraph.ts` was expected to be a sixth and is not: it enumerates
**task** kinds, and a concept has no task node.

**A concept needs a name, so `Asset` gains `title?: string`** (mirrored on `AssetMeta`). Every other
kind is named by what it serves — `Café Mori — night` is derivable from the binding — but a concept
was asked for in a sentence, and that sentence is the only name it has. `AssetRoot.write` carries an
existing title across a write that offers none, so promoting a concept does not erase what it was
asked for.

**What the new kind must not do**, and why it doesn't: every binding lookup outside the document
tree filters by `kind` first — `playable.ts:103,115`, `cli/commands.ts:402`, `session.ts:487,503`,
`testkit/project.ts:282` — so a concept bound to `{locationId: 'cafe'}` cannot be mistaken for a
plate, a portrait or a shot frame. The planner is safer still: it resolves a shot's plate by
**task hash** (`doneOutput(graph, locTaskHash)`, `planner.ts:295-303`), never by manifest binding.
The one unfiltered lookup is `doctree.ts:219` (`linksFor`), which is precisely where a concept
*should* appear — under the location it sketches. A test pins each of these.

## Stage 3 — `vnauthor`

`ToolContext` (`packages/authoring/src/tools.ts:64`) grows one optional seam beside `confirm`:

```ts
/**
 * Image generation, wired by the host that knows whether this run is mocked and where the keys
 * are. Absent in bare contexts, in which case `generate_image` refuses rather than assuming an
 * API key exists to spend.
 */
art?: ArtGen;
```

where `ArtGen` (`packages/authoring/src/art.ts`) is the seam and `workspaceArtGen(workspace, {mock})`
the host-side factory — the tool never constructs providers itself, exactly as it never decides its
own permissions. The seam has **two** methods, not one: `generate(req)` and `preview(req)`, which
resolves the subject and composes the prompt for the price of a read. Plan mode needs the second —
the prompt is the part worth reading before spending anything — and it must be the *same*
composition, so it cannot be a surface re-implementing the clause order. `workspaceArtGen` re-reads
the project on every call: a sketch asked for after an edit must be drawn from the sheet as edited.
The seam re-exports `formatSubject`/`parseSubject`/`ConceptSubject` so a host surface can say what
it bound to without importing `@vn/artgen` itself.

**`generate_image`** — `mutating: true`, `confirm: true` (it spends money, which is the same bar
`git_revert` clears). Args: `sentence: string`, `subject?: string` (`location:<id>` /
`character:<id>`). It reports the subject it bound to, the hash, and the file it wrote, and its
description says what a concept is: *not planned, not rendered into any scene, promote it with
`art.promote` if it should become a plate*. `written` carries the object path and the manifest so
the plan's one commit picks them up.

**`/makeimage <sentence>`** in `apps/authoring/src/repl.ts`'s slash chain — a direct call, not a
turn through the model, so a one-line request costs one image and no tokens. It prints the matched
subject, the composed prompt, and the written path. It obeys plan mode like every mutating act: in
plan mode it composes and prints the prompt and refuses to generate. Shift-Tab is how you get out of
plan mode without a plan, and the `/help` line says so.

## Stage 4 — the desktop

**`art.generate(sentence, subject='', open=true)`** in `apps/desktop/src/main/commands/art.ts`
(the namespace already exists, from `art.setNotes`). `confirm: true`. `check` refuses an empty
sentence, an unavailable base root (`baseRefusal`), a subject naming nothing, and a session with no
providers configured. On success it pushes a `command:ui` effect running
`view.open(editor='asset', where='elsewhere', subject=<hash>)` when `open` — the same route a
click on an asset in the document tree takes — so the picture appears in a pane that is not the one
that asked for it.

The session builds the `ArtGen` from its existing `providers()` (`session.ts:337-342`), so
`--mock` produces a marked placeholder PNG and a real run produces real art, with no second policy
about which.

It is **not** undoable and **not** journalled: it writes new content-addressed bytes and a manifest
row, so there is nothing to restore to — the same reason `asset.regenerate` isn't. It is committed
by the `Committer` like any other act.

## Stage 5 — promotion

**`art.promote(hash, variant, description='')`** — the second act, and the only one that touches
the task graph.

1. Refuse: an unknown hash; an asset whose `kind !== 'concept'`; a concept bound to a character
   (out of scope — see Decisions); a concept bound to nothing (there is no location to write the
   variant onto); a `variant` that is not a legal id; an unavailable base root.

   **As shipped, this list is a function.** `promotionOf(store, {hash, variant})` in
   `promote.ts` answers `{ok: false, code, reason}` or `{ok: true, plan}` from the manifest
   alone — no `loadInputs`, so a surface can ask it cheaply — and `promoteConcept` **calls it
   first** rather than re-deciding. That is what makes `art.promote`'s `check` and its `run`
   give the identical sentence; a test pins the two together. It stops short of the sheet on
   purpose: a location the model has and disk does not is a broken project, not a bad request,
   so that one surfaces as a throw from the act.
2. If the location's sheet has no such variant, add it through `applyLocationEdit` +
   `writeFileAtomic` on the file `entityFile(docs, id)` names — the same write path `art.setNotes`
   and `edit_location` take, so one authorial act has one answer. `description` lands on the
   variant when given.
3. Reload the model, then compose exactly what the planner would:
   `prompt = buildLocationPrompt(location, variant, config)`,
   `params = imageParams(config)`,
   `task = makeTask('location_ref', {locationId, variant, prompt, refs: [], params})`.
4. `store.write(await store.read(ref), ext, {kind: 'location_ref', sourceTask: task.hash, satisfies:
   {locationId, variant}, prompt, refs: [], modelId})` — the bytes already exist so nothing is
   copied (`AssetRoot.write` skips an existing file), the kind flips, and `mergeBindings` **keeps**
   the original concept binding so the tree still shows where the plate came from.
5. `logTask(paths, {...task, status: 'done', output: hash, attempts: [{attempt: 1, prompt, refs: [],
   output: hash, at}]})`. `loadGraph` replays last-writer-wins and `TaskGraph.add` returns the
   canonical node, so when the planner next calls `graph.add(makeTask('location_ref', …))` it gets
   this `done` node back, `ready()` skips it, and `doneOutput` hands its hash to every shot in that
   location. **The next `vngen run` adopts the concept instead of rendering over it.**

Two consequences to state plainly, because both are new:

- Promotion **changes an asset's kind**, which is the first time anything does. It is safe because
  routing is by kind and both kinds are base-routed, so the bytes never move.
- Promotion is the first writer of a `done` record outside the scheduler. It is bounded to one
  task identity that it computes itself from the model it just wrote, so it cannot forge a node for
  work that was never done: the image it points at is the image that node would have produced.

**Since shipped:** steps 3–5 are no longer written here. They were generalized into `adoptSlot`
(`packages/artgen/src/adoptslot.ts`) — "any bytes become any slot's output" — and `promoteConcept`
is now one **caller** of it: `promotionOf`, the sheet write, then
`adoptSlot({hash, slot: {kind: 'plate', locationId, variant}})`. The two consequences above are
unchanged and are now stated once, for every slot kind, rather than once for plates. See
[`adopting-an-uploaded-asset.md`](adopting-an-uploaded-asset.md).

The Asset editor grows a **Promote** strip, drawn only when `promoteAction(info)` in
`renderer/rules/assetview.ts` says it applies — a concept bound to a location, so a character
concept never offers a control that would walk around the gate. It names that location, takes a
variant id and runs `art.promote`; what is half-typed there survives a refetch of the same asset
and is dropped when the pane moves to another. The refusal is made twice on purpose, once in each
layer that could be reached alone: `approveAction` returns `{ok: false}` for a concept so the
Approve button is dead, and `asset.accept`'s `check` refuses one by name and points at
`art.promote(hash=… variant=…)`, so the command says the same thing to CDP and the palette.

`vnauthor` gets no promote tool in this plan — the agent proposes the sketch, the human decides it
is canon.

## Stage 7 — redrawing a concept (the author asked for this after Stage 6 shipped)

This stage **reverses one line of Out of scope below**: "editing a concept's prompt after the
fact — a concept is a snapshot of a sentence; make another." The author's objection is the
reasoning this plan already used, followed one step further. A derived asset's prompt cannot be
edited because a builder rewrites it every planning pass, so an edit would freeze that asset
against every future improvement to the builders. **A concept has no builder.** It is a root
asset: nothing derives its prompt, nothing will ever recompose it, and `derivePrompt` returns
`undefined` for it by design. The objection does not reach it, so the prompt is authored — and an
authored field is editable. It is the one asset kind where that is true, and the reason is the
reason, not an exception.

Three things follow, and the third is the bug the author actually hit.

**`asset.regenerate` refuses a concept, and today it refuses badly.** `regeneration()` looks the
asset's `sourceTask` up in the graph; a concept's is a hash of the *request*, deliberately not a
node, so the refusal reads "records no task in the graph, so there is nothing to re-run" — true,
unhelpful, and indistinguishable from a corrupt project. It becomes a refusal that names the
command that does work: `art.redraw`.

**`redrawOf(store, {hash})` → `art.redraw`.** Same two-layer shape as `promotionOf`: a pure
decision from the manifest alone that both the `check` and the act call, so the sentence is
written once. Refusals: no such hash; not a concept (naming `asset.regenerate` for a planned
asset, since that one *is* re-runnable); an `unavailable` base root. `redrawConcept` in
`@vn/artgen` then draws the new picture from the prompt it is handed, carrying the original's
`satisfies` binding and its references, so a redraw of a bound sketch stays bound to the same
place. `art.redraw(hash, prompt='', title='', open=true)` is `mutating` and **`confirm: true`** —
it spends an image call, like every other command that costs money.

- **A redraw is a new asset, not an overwrite.** Bytes are content-addressed, so different bytes
  are a different hash; there is no `forget` on the store and this stage does not add one. The
  old sketch stays under Concepts and the message says the new hash. That is the right behaviour
  anyway — concept art is drawn in candidates.
- **`prompt` defaults to the recorded one**, which makes a bare `art.redraw(hash=…)` a re-roll.
  With `image_params.seed` fixed that returns the same bytes and therefore the same hash; the
  note says so before the call is spent, exactly as `asset.regenerate` does.
- **`title` defaults to the old one**, so a redraw keeps its name in the tree. Passing one renames
  it — the only way a concept's name is ever edited, and cheap because `title` is already the one
  authored field on an `Asset`.

**The pane's prompt box is editable, and only for a concept.** `promptEditable(info)` in
`renderer/rules/assetview.ts` — a pure rule beside `approveAction` and `promoteAction`, tested
the same way. The box is prefilled with the recorded prompt, which is what makes "edit the
sentence" and "rewrite the whole prompt" the same gesture: the style preamble is in the text
being edited, so it survives unless it is deliberately deleted. A **Redraw** button runs
`art.redraw` with whatever the box holds.

Nothing is written until Redraw. That is what keeps `Asset.prompt` meaning *the prompt these
bytes were made from* — a stored draft would make the manifest describe a picture that does not
exist. The half-typed text lives in the pane exactly like the Promote strip's: it survives a
background refetch of the same asset and is dropped when the pane moves to another one.
`AssetInfo` gains `title` so the pane can prefill the name.

**The agent can do both, and asks first.** `ArtGen` gains `redraw` and `list`; `tools.ts` gains
`edit_image` **M C** and `list_images`. The listing is not padding — the agent cannot edit what it
cannot see, and a fresh session has no hash from a `generate_image` it never ran. `edit_image` is
`confirm: true` for the same reason `generate_image` is, which is precisely the author's
"it should ask the user before regenerating the actual artwork" — and, with
[`desktop-agent-permissions.md`](desktop-agent-permissions.md) fixed, that confirmation now
actually reaches a user in the desktop instead of being auto-allowed.

## Stage 6 — docs and bookkeeping

- Keep this plan current as the work proceeds, and add its row to [`../index.md`](../index.md) — a plan
  is indexed there, not in [`../index.md`](../index.md), which lists `docs/` pages.
- `CLAUDE.md`: `@vn/artgen` in the layering diagram and the package table; a core-ideas bullet for
  the concept kind (generated on demand, bound but never consumed, promotable) and for promotion's
  adopt-don't-regenerate contract.
- `docs/asset-stores.md`: `concept` joins the base kinds; what promotion does to a record.
- `docs/pipeline-contracts.md`: the one place that says a `done` record can be written outside the
  scheduler, and under what bound.
- `docs/command-system.md`: `art.generate`, `art.promote` and (Stage 7) `art.redraw`, including why
  none of the three is undoable, and why `asset.regenerate` refuses a concept.
- `docs/document-tree.md`: the Concepts group and concept labels.
- `docs/desktop-app.md`: the Asset editor's Promote control, and (Stage 7) the editable prompt +
  Redraw box, which is the one place the pane's "the prompt is read-only" rule has an exception.
- `docs/vnauthor.md`: `generate_image` and `/makeimage`, the `art` seam on `ToolContext`, and
  (Stage 7) `list_images` / `edit_image` with the tool count.
- `CLAUDE.md` (Stage 7): a core-ideas bullet saying a concept's prompt is authored and therefore
  the one prompt an author may edit.
- `todos.md` is **untouched** — no entry covers this, and the list is the author's.
- Remove every `CLAUDENOTE:` and audit comments in the touched files.

## Verification

1. `pnpm check` **and** `pnpm check:renderer`, `pnpm test`, `pnpm lint`, `pnpm build`.
2. **Hash stability, again the key regression.** Moving `prompts.ts` must change no prompt: against
   a copy of `templates/basic`, `vngen cost` reports the same task hashes before and after the move.
   Run this *before* touching anything else, so a later failure has one suspect.
3. **The agent**: `pnpm vnauthor <copy> --mock` → `/makeimage create an aerial shot of the high
   school`. It reports the matched location, writes a placeholder PNG into `assets/objects/`, and
   the manifest row reads `kind: "concept"` bound to that location.
4. **The pipeline ignores it**: `vngen cost <copy>` plans exactly the same tasks it planned before
   the concept existed, and `vngen export` produces a byte-identical `story.play.json`.
5. **The desktop**: `pnpm vndesktop --mock`, then
   `node scripts/vn-cdp.mjs "art.generate(sentence='an aerial shot of the high school')"` — the
   Asset editor opens in another pane showing the image, its prompt, and `Concepts` in the tree
   with a readable label; the location's backlink panel lists it.
6. **Promotion**: `art.promote(hash=<h> variant=aerial)` → `locations/highschool.md` gains only the
   variant, the manifest row flips to `location_ref` keeping both bindings, and `vngen cost` now
   plans **one fewer** `location_ref` than a fresh project would — because that one is already
   `done`. A following `vngen run` renders no plate for it.
7. **Refusals, by name**: a concept through `asset.accept`, a character concept through
   `art.promote`, `generate_image` with no `art` seam, and either surface against an `unavailable`
   base root.
8. **Stage 7 — the redraw**: `asset.regenerate` on a concept refuses by naming `art.redraw`;
   `art.redraw(hash=<h> prompt='…')` writes a *new* concept carrying the same binding and opens
   it; a bare `art.redraw(hash=<h>)` re-rolls and says so when the seed is fixed; `art.redraw` on
   a plate refuses by naming `asset.regenerate`; and `check` and `run` give the identical sentence
   in every one of those cases.

## Out of scope

- Promoting a concept to a portrait, a model sheet or a shot frame (see Decisions).
- ~~Editing a concept's prompt after the fact — a concept is a snapshot of a sentence; make
  another.~~ **Reversed by Stage 7**, on the author's objection: a concept is a root asset, so
  there is no builder for an edit to freeze it against.
- Forgetting an asset. A redraw adds a candidate; nothing in this repo deletes bytes from a
  content-addressed store, and this stage is not the place to start.
- Changing what a concept is *of*. A redraw carries the original's binding; a sketch of somewhere
  else is a new sketch, which is `art.generate`.
- Any concept-driven change to `story.play.json`, the gate, or `vngen approve`.
- A promote tool for `vnauthor`.
