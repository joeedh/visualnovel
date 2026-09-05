# Asset stores: base and project

Generated art is split across two content-addressed roots, not one. Base art — the
portraits, model sheets and location plates every later prompt references — is stored
beside the authored inputs at `assets/`, and may be its own git repository. Project art —
the shot frames of a particular story — is kept under `vngen/build/`.

One `AssetStore` facade spans both, so every consumer (the pipeline runners, `@vn/export`,
the CLI, the desktop session, testkit) is unchanged by the split.

Plan:
[`../plans/archive/INDEX.md#base-and-project-asset-stores`](../plans/archive/INDEX.md#base-and-project-asset-stores).
The invariants in short form are in
[`pipeline-contracts.md`](pipeline-contracts.md#identity-and-storage).

<!-- toc -->

- [Why two roots](#why-two-roots)
- [Layout](#layout)
- [The rules](#the-rules)
- [Three states, because two would cost money](#three-states-because-two-would-cost-money)
- [Surfaces](#surfaces)
- [What this does not do](#what-this-does-not-do)

<!-- tocstop -->

## Why two roots

Base art is approved, expensive, referenced by everything downstream, and what an author
would share between projects. `vngen/` holds the generated tree, which is reproducible
from inputs plus a run. A subtree that may be its own repo has to carry its own
provenance, and indexing a base asset in `vngen/build/manifest.json` would put its bytes
in one repository and its meaning in another. So each root has its own manifest, and
`assets/` sits at the project root because `vngen/build/assets/` could not be a repository
root without taking the build tree with it.

## Layout

```
assets/manifest.json            the base manifest
assets/objects/<hash>.<ext>     base bytes — `objects/` because that is what they are
vngen/build/manifest.json       the project manifest (unchanged)
vngen/build/assets/<hash>.<ext> shot frames
```

## The rules

`AssetKind` alone determines routing. `location_ref`, `portrait`, `model_sheet`,
`outfit_sheet`, `concept` and `reference` go to the base root, and `shot_image` goes to
the project root. Neither `satisfies` nor a flag on the task affects the choice. One total
function maps a kind to a root, so every asset has exactly one place to live.

A `reference` is an upload, and it is the only asset that nothing generated. `uploadAsset`
in `@vn/artgen` reads bytes from outside the project, refuses anything that is not an
image and anything carrying the mock-placeholder marker, and records them in the base root
— it is authored input, so it belongs beside the art an author approved. Its `sourceTask`
is a synthesized hash of the request (the same shape a concept's is), not a node in the
graph, which is why `asset.accept` and `asset.regenerate` both refuse it by name: there is
no generated work to accept and no task to re-run. A reference enters a prompt through
`prompt.addRef`.

A `concept` is base art too, which is what makes promotion cheap. A concept is
authored-side. It is a sketch of a place or a person, asked for in a sentence rather than
planned, so it belongs beside the plates. Promoting one rewrites a record in place. The
kind flips to `location_ref`, `sourceTask` becomes the plate's own task identity, `prompt`
becomes the derived one, and `mergeBindings` keeps the concept's binding beside the new
`{locationId, variant}` so the tree still shows where the plate came from. Both kinds
route here, so the bytes never move.

Only adoption changes an asset's kind, and adoption is where a slot's routing takes
effect. `adoptSlot` in `@vn/artgen` re-records bytes already in the store under the kind
the slot implies — `plate:` → `location_ref`, `sheet:` → `model_sheet`, `shot:` →
`shot_image` — applying the routing rule above a second time to the same hash. Within the
base root, adoption rewrites the record in place. Across the roots it does not: a
`reference` an author uploaded lives in `assets/`, and adopting it onto a shot slot writes
the bytes to `vngen/build/assets/` as well. One hash then has two rows in two roots, each
with its own provenance — the base row still records that an author handed the picture in,
and the project row records which frame it is. Reads are base-first, so `asset.info`
answers from the base record, and both rows carry the same content because the hash
identifies the content.

`promoteConcept` is one caller of `adoptSlot`, covering the location-concept case and
writing the sheet before it calls. The general operation refuses a `portrait:` slot, which
the P3 gate handles; refuses mock-marked bytes; and refuses to supersede a render that
already holds the slot unless the caller declared `replace`. Adoption never accepts a slot
automatically. It records that the bytes are that task's output; it does not record that a
human approved them.

**Reads consult both roots, base first.** Hashes are content hashes, so a byte present in
both roots is the same byte and the two indices cannot disagree about content. Where both
hold a record for one hash, reads take the base record, and `manifest()` returns the union
deduped that way. `pathOf` resolves from whichever index holds the hash, and defaults to
the project root for a hash absent from both.

Nothing on disk moves. A project written before the split keeps its base art indexed in
`vngen/build/manifest.json`, and it keeps resolving, because the union reads that manifest
whole. The split determines where new bytes land. There is no migration, no rehash, and —
since `taskHash` contains no path — nothing regenerates.

**`satisfies` is a list.** An asset records everything it is for, because bytes are keyed
by content: two tasks producing the same image share one record, and the second binding
must not erase the first. A manifest written with a single record reads as a one-element
list, so every manifest ever written stays readable, and that manifest is rewritten in the
canonical form. Use `bindsTo(asset, binding)` rather than reading the list directly.

## Three states, because two would cost money

| State         | On disk                                            | Meaning                                                                                                     |
| ------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `absent`      | no `assets/` directory                             | Legacy or brand-new project. An empty, writable base — the first base write creates the directory.          |
| `unavailable` | `assets/` exists, with no readable `manifest.json` | Somebody cloned without the base repo. **Nothing is planned**; the store also refuses to write a base kind. |
| `ready`       | `assets/manifest.json` parses                      | Normal.                                                                                                     |

`unavailable` is a state worth keeping. A missing base repo shows an empty base manifest,
and without the distinction the planner sees no portrait for any character and a run
regenerates the entire approved base library. A missing submodule leaves behind the
directory without the index, and that is the evidence that distinguishes the two cases.

The refusal covers all work rather than only the four base kinds, and that is deliberate:
every shot references a location plate and a portrait, so an unreadable base root leaves
no plannable work at all. `baseRefusal(base)` in `@vn/pipeline` produces the one sentence,
`planTasks` returns nothing, and `RunSummary.refused` carries the sentence to the
surfaces. `vngen run`, `vngen cost` and `vngen run --mock` all print it and exit non-zero,
because a zero-work summary is otherwise indistinguishable from a finished project.

## Surfaces

- `AssetStore.base` returns `{ state, root, count }`. `baseAssetsOf(paths)` returns the
  same fields without opening the project store, so a caller with no reason to parse a
  build manifest can use it.
- `vngen status` prints the union total, then base and project counts, then the base state
  when it is not `ready`.
- `WorkspaceIndex.baseAssets` carries the same three fields, so the desktop can display
  "unavailable" instead of drawing an empty gallery. An empty gallery looks the same as
  "none yet".
- `Workspace.repos()` reports a `'base'` role when `assets/` is a repository of its own,
  and commit-on-save handles that repository under the existing policy — see
  [`repos-and-commits.md`](repos-and-commits.md).

## What this does not do

- **Move existing bytes.** A project can copy its base art into the new root. The app
  never copies it automatically.
- **Share a base library between projects.** The layout is a repo, so sharing is possible.
  There is no UI, config key, or path indirection for sharing.
- **Treat `assets/` as authored input.** Every file in `assets/` is generated art with
  provenance. Hand-drawn references stay in `characters/<id>/refs/`.
- **Collect garbage.** Unreferenced bytes are not pruned from either root.
