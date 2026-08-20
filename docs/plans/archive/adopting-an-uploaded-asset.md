# Adopting an uploaded picture as a slot's output

Status: **shipped**

## Context

`todos.md`:

> the asset editor should have an option to upload a custom asset for if e.g. a user pays someone
> to clean up artwork.

There is already an `asset.upload`, and it is **not** this. It files bytes under kind `reference`:
self-pinning, so it can never drift; refused by `asset.accept` and `asset.regenerate` by name,
because nothing generated it; and consumed by nothing. It exists *to be pointed at by a prompt
chunk*. That is the right answer for "here is a photo of the building I mean" and the wrong one for
"here is the café plate, repainted, use it" — the second wants the picture to **be** the plate: to
show up as the location's art, to be referenced by every shot in that location, to make
`vngen run` skip the render it would otherwise plan.

The mechanism for that already exists too, and it has exactly one caller. `promoteConcept`
(`packages/artgen/src/promote.ts`) writes a variant onto the location sheet, re-records the bytes
under kind `location_ref` with a `satisfies` binding, derives the plate's task identity **from the
sheet the same call just wrote**, and logs it `done` through `adopt`. `adopt`'s doc comment states
the guarantee that makes this safe: *"There is no way to pass a remembered task hash."* The inputs
are handed in and the hash is computed from them, so a call cannot mark done a task that nothing
describes.

So this plan is one sentence of work: **generalize promotion from "a location concept becomes a
plate" to "any bytes become any slot's output".**

## Decisions this plan settles

- **A slot is a `RefBinding`, addressed by the string vocabulary that already exists.**
  `slotKey` / `parseSlot` / `slotLabel` in `packages/artgen/src/refcycle.ts` already spell
  `plate:cafe/night`, `sheet:aiko/gala/front`, `portrait:aiko`, `shot:greet/s2`, with a round-trip
  test, and `prompt.addRef` already takes one. Inventing a second address for "which picture" —
  when the reference graph, the suspension walk and the cycle refusal all speak this one — would be
  a second answer to a question already settled.
- **`asset:<hash>` is not a slot, and the refusal says why.** An upload and a concept *are* their
  own identity; there is no task under them and nothing to satisfy. This is the same fact that
  makes them un-driftable, stated from the other side.
- **A portrait is refused: the P3 gate owns it.** `portrait:aiko` names a picture whose acceptance
  writes `character.md` and `approved.png` and releases every scene that character is in. Adoption
  would file the bytes and leave the gate untouched, which is the worst of both. The refusal names
  `gate.approve`, mirroring `asset.accept`'s existing refusal of a portrait and `promotionOf`'s
  refusal of an unbound concept.
- **Replacing an existing render is the common case, so it is a declared act rather than a
  refusal to route around.** `adoptionOf` refuses `ALREADY_RENDERED` when a `done` node holds
  different bytes — correctly, because a silent adoption over a real render would erase provenance.
  But "the frame we rendered, cleaned up by an artist" *is* a rendered task. So `asset.adopt` takes
  `replace` (default false); with it false the existing refusal stands verbatim, and with it true
  the adoption proceeds. Nothing is destroyed: `tasks.jsonl` is append-only and `loadGraph` keeps
  the **last** record per hash, so the superseded render is still in the log and its bytes are
  still in the store — content-addressed, and nothing is ever overwritten. The confirm sentence
  says which render is being superseded.
- **`adoptionOf`'s guard is not weakened; the caller passes the flag.** `replace` becomes a field
  on `AdoptRequest`, checked at the one place the refusal is raised. A second adoption entry point
  that skips the check would make the guarantee a convention.
- **A slot's task inputs are derived from the project as it stands, by the same helpers the
  planner uses.** Only `locationInputs`/`locationTask` exist today; `portraitInputs`,
  `modelSheetInputs` and `shotInputs` are extracted from `packages/pipeline/src/planner.ts` into
  `packages/artgen/src/prompts.ts` and the planner calls them. That refactor is the correctness
  argument: if the planner and the adopter compute inputs from one function, they cannot disagree
  about a hash, and the acceptance test is that every existing task hash in a fully-run fixture is
  byte-identical after the move.
- **Adoption re-records under the slot's kind, so the bytes land where that kind routes.** A
  `shot_image` goes to `vngen/build/assets/`, a `location_ref` or `model_sheet` to base `assets/`.
  The original `reference` row, if the bytes came in through `asset.upload`, stays where it is —
  one hash, two rows, two roots, each with honest provenance. `mergeBindings` keeps the earlier
  binding, so the tree still shows where the picture came from, exactly as it does after a promote.
- **Adopting a shot frame stamps `proseHash`, because the runner does.** `Shot.proseHash` is
  stamped beside the image when the bytes are new; an adopted frame that skipped it would read as
  drift-unknown forever. Adoption writes it from the scene as it stands — which is the honest
  claim, since the artist worked from these lines.
- **Nothing is auto-accepted.** Adoption says "this is the output of that task", not "a human
  approved it". `accepted` stays what it is, set by `asset.accept` / `gate.approve`, and an adopted
  picture is offered to them like any other. (An adopted plate is `location_ref`, which
  `asset.accept` already serves.)
- **Mock-marked bytes are refused, reusing `uploadOf`'s check.** A placeholder PNG carrying
  `vn-mock-placeholder` must never become a slot's real output; that marker *is* the "never mix
  mock assets into a real run" guarantee.

## Stage 1 — the inputs helpers

`packages/artgen/src/prompts.ts` gains, beside `locationInputs`/`locationTask`:

```ts
export function portraitInputs(character, config, params): TaskInputs['portrait'];
export function modelSheetInputs(character, outfit, angle, portrait, config, params): TaskInputs['model_sheet'];
export function shotInputs(shot, scene, model, config, params, refs): TaskInputs['shot_image'];
```

each being the object literal the planner builds today, moved. `packages/pipeline/src/planner.ts`
calls them and keeps its own dependency wiring — `deps` are not hashed, so they stay the planner's
business.

Acceptance for this stage alone, before anything new is built: `pnpm test` green, and a
`synthProject` run produces the same `L + 4C + 2N` tasks with the same hashes as before.

## Stage 2 — `adoptSlot`

New `packages/artgen/src/adoptslot.ts`, in the two-layer shape `promotionOf`/`promoteConcept` and
`uploadOf`/`uploadReference` both use:

```ts
export interface AdoptSlotRequest { hash: string; slot: RefBinding; replace?: boolean }
export interface AdoptSlotPlan {
  kind: TaskKind;
  taskHash: string;
  label: string;                    // slotLabel(slot)
  supersedes?: string;              // the hash currently recorded done, if any
}
export function adoptionForSlot(deps, req): Decided<AdoptSlotPlan>;
export async function adoptSlot(deps, req): Promise<{ ref: AssetRef; plan: AdoptSlotPlan }>;
```

Refusal codes, each naming what to do instead:

| code | when |
| --- | --- |
| `UNKNOWN_ASSET` | no such hash in either root |
| `MOCK_PLACEHOLDER` | the bytes carry the mock marker |
| `NOT_A_SLOT` | an `asset:` binding — an upload or a concept is its own identity |
| `GATED_SLOT` | `portrait:` — that is `gate.approve` |
| `NO_SUCH_SLOT` | the model has no such variant / outfit / angle / shot |
| `ALREADY_RENDERED` | a different render holds the slot and `replace` is false |

`adoptSlot` then does, in order: resolve the slot against a freshly loaded model, build the inputs
with the Stage 1 helpers, `store.write(bytes, ext, { kind, sourceTask: hash, prompt, refs,
satisfies })`, stamp `proseHash` for a shot slot, and `adopt(...)` with `replace` carried through.
`promoteConcept` is rewritten as a caller: sheet write, then `adoptSlot({ slot: { kind: 'plate',
… } })`. One adoption path, and the promote tests keep passing unchanged — which is how the
generalization proves it did not change behaviour.

`packages/artgen/src/adopt.ts` gains `replace?: boolean` on `AdoptRequest`, honoured at the one
`ALREADY_RENDERED` site.

Tests: `packages/artgen/src/tests/adoptslot.test.ts` — each refusal by code; a plate adoption over
a run fixture asserting the next `plan()` proposes nothing for that location; a shot adoption
asserting the frame appears in `story.play.json`; a `replace` adoption asserting the log holds both
records and `loadGraph` answers the new one.

## Stage 3 — the commands

`apps/desktop/src/main/commands/asset.ts`:

| command | props | what |
| --- | --- | --- |
| `asset.adopt` | `hash`, `slot`, `replace=false` | Bytes already in the store become that slot's output. `mutating`, `confirm: true`, `check` = `adoptionForSlot` |
| `asset.upload` | gains `slot=''` | Empty keeps today's behaviour exactly — a `reference`. Set, the same act files the bytes and adopts them |

`asset.upload`'s existing description gains one clause; its `check` runs `uploadOf` and then, when
`slot` is set, `adoptionForSlot` against the hash-to-be, so the refusal is visible before the
bytes are copied. If the adopt half fails after the upload succeeded, the message says so and the
bytes remain filed as a `reference` — recoverable with `asset.adopt`, never lost.

A file dialog is the one missing piece: `asset.upload` takes a typed path today. It gets one from
the same helper [`upload-and-archive.md`](upload-and-archive.md) adds for `upload.pick`, following
`workspace.pick`'s pattern including the re-check after the dialog closes — *the dialog is not a
permission*.

Neither command is `undoable`. The undo journal snapshots the document tree and excludes
`vngen/state`, so it could restore the sheet a promote wrote but not the `tasks.jsonl` line that
made it count — and a command whose journal entry cannot restore it must not claim it can.

## Stage 4 — the asset editor

The pane already knows the asset it is showing and therefore its binding, so the slot is not typed
by the author — it is the picture on screen. Below the Approve/Regenerate strip:

- **Replace with a file…** — the picker, then `asset.upload(slot=<this asset's slot> replace=…)`.
  Shown when the asset has a slot binding; on a concept or an upload the strip is absent and the
  existing Promote strip (or nothing) stands, which is `NOT_A_SLOT` expressed as layout.
- On a slot whose render exists, the confirm sentence names it: *"Supersedes the render `a1b2c3d4`
  for `cafe — night plate`. The old bytes stay in the store."*
- After adopting, the pane reloads on the new hash: the picture, the prompt chunks and the notes
  are the slot's, and the picture is the artist's.

The document tree needs nothing new — the adopted asset is already labelled by what it is
(`Café Mori — night`), because that label comes from the binding.

## Stage 5 — documentation

- `docs/asset-stores.md`: adoption as the second `done` record written outside the scheduler, and
  the one-hash-two-roots consequence of re-recording under a new kind.
- `docs/plans/on-demand-concept-images.md`: a line noting `promoteConcept` is now a caller of
  `adoptSlot`.
- `docs/desktop-app.md`, Asset section: the Replace strip.
- `CLAUDE.md`: the promotion invariant becomes the **adoption** invariant — *adopting is the one
  `done` record written outside the scheduler; it cannot forge work that never happened because the
  task identity is computed from the project as it stands, never from a passed hash; a portrait is
  refused because the P3 gate owns it; and superseding a real render is a declared act, not a
  silent one.*

## Acceptance

- `pnpm check`, `pnpm test`, `pnpm lint` green, and every task hash in a fully-run fixture
  unchanged by the Stage 1 move.
- Uploading a repainted café plate onto `plate:cafe/night` makes it the location's art, and the
  next `vngen run` plans nothing for that plate.
- Every shot set in the café now references the adopted bytes, because `locationRefs` resolves the
  slot and the slot's output changed.
- Adopting onto a slot that already rendered refuses by default and names `replace`; with
  `replace=true` it proceeds, and `tasks.jsonl` holds both records with the newer one winning.
- `asset.adopt(slot='portrait:aiko')` refuses with a sentence naming `gate.approve`.
- `asset.adopt` on a mock placeholder refuses.
- `art.promote` behaves exactly as it does today, with its tests unchanged.

## Shipped deviations

**`adoptionForSlot` is async, where `promotionOf` and `uploadOf` are not.** A slot has to be
resolved against the model, the shots on disk and the task graph, and none of those can be answered
from the manifest alone. The two-layer shape survives; only the signature moved.

**Three refusal codes the table did not name**, each a question the plan assumed away:

| code | when |
| --- | --- |
| `BASE_UNAVAILABLE` | the base root exists without a manifest — the same refusal every other base writer gives |
| `NOT_APPROVED` | a `sheet:` slot whose character has no approved portrait; a sheet is drawn *from* that portrait, so its identity does not exist yet |
| `UPSTREAM_MISSING` | a `shot:` slot whose plate, portrait or outfit sheet has not rendered — a frame's identity is built on those outputs, so there is no hash to log done |

**`AdoptSlotRequest` gained `bytes`.** `asset.upload(slot=…)` has to hear the refusal *at the
picker*, before the file is copied into the tree, and at that moment the store does not hold the
hash. It is a decision-time escape hatch only: `adoptSlot` ignores it and adopts what the store
holds, so the act cannot be tricked into recording bytes that were never filed.

**`AdoptSlotPlan.kind` is a three-member `SlotKind`, not `TaskKind`,** and the plan carries a
`note`. The narrow type is the refusal expressed as a type — `portrait` and `asset` are not adoptable
and so are not in it — and the note is what makes the confirm sentence the plan's own words rather
than a surface's paraphrase.

**The shot test asserts the build manifest, not `story.play.json`.** `@vn/artgen` cannot import
`@vn/export` (the boundaries rule), and re-deriving the playable inside the artgen tests would be a
second answer to what the export already answers. The claim is the same one: the frame is recorded
as that shot's output.

**Stage 4 shipped as a dedicated `asset.replace(hash)` rather than the plan's
`asset.upload(slot=… replace=…)` from the pane.** The plan had the pane compose the slot string and
hand it to the upload command. Taking the *hash* instead makes the slot un-typeable — it is the
picture on screen — and keeps one authority for the refusals. `asset.upload(slot=…)` still exists and
still works; the pane just does not use it.

**`AssetInfo.slot` is new, and it means the slot these bytes fill _now_** — gated on the source task
being `done` with this hash as its output, not merely on the binding the bytes carry. That is what
makes the strip honest: a superseded render keeps its `satisfies` binding forever, and a pane
offering to replace *that* would supersede a picture the project has already moved past.

**`pickFiles` gained a `FilePickOptions` argument.** The upload chooser's title, button, filters and
single-vs-multi were hard-coded; a replace chooser wants an image filter and one file.

**`previewReplace` deliberately ignores `MOCK_PLACEHOLDER`.** It reuses `adoptionForSlot`'s refusals
by asking about the *outgoing* asset, and in a mock project every render is placeholder-marked — so
that one code would refuse Replace everywhere. The rule judges the bytes coming *in*, and `uploadOf`
refuses mock art at the upload, which is where it belongs.

**Adoption across the two roots is one hash in two rows.** Adopting a base `reference` onto a
`shot:` slot writes a project-root row under `shot_image` and leaves the base row where it is;
`manifest()` is base-first, so `asset.info` keeps answering `reference`. Within the base root it is
still a rewrite in place, which is why promotion's behaviour is unchanged. Stated in
[`../asset-stores.md`](../../asset-stores.md).
