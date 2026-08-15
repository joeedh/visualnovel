# Asset stores: base and project

Generated art lives in **two** content-addressed roots, not one. Base art — the portraits,
model sheets and location plates every later prompt references — lives beside the authored
inputs at `assets/`, and may be its own git repository. Project art — the shot frames of a
particular story — stays under `vngen/build/`.

One `AssetStore` facade spans both, so every consumer (the pipeline runners, `@vn/export`, the
CLI, the desktop session, testkit) is unchanged by the split.

Plan: [`plans/base-and-project-asset-stores.md`](plans/base-and-project-asset-stores.md).
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

Base art is approved, expensive, referenced by everything downstream, and the thing an author
would share between projects. `vngen/` is the opposite: the generated tree, reproducible from
inputs plus a run. A subtree that may be its own repo has to carry its own provenance — a base
asset indexed in `vngen/build/manifest.json` is bytes in one repository with their meaning in
another. So each root has its own manifest, and `assets/` sits at the project root because
`vngen/build/assets/` could not be a repository root without dragging the build tree along.

## Layout

```
assets/manifest.json            the base manifest
assets/objects/<hash>.<ext>     base bytes — `objects/` because that is what they are
vngen/build/manifest.json       the project manifest (unchanged)
vngen/build/assets/<hash>.<ext> shot frames
```

## The rules

**Routing is by `AssetKind`, and that is the only rule.** `location_ref`, `portrait`,
`model_sheet`, `outfit_sheet` and `concept` go to the base root; `shot_image` goes to the project
root. Not by `satisfies`, not by a flag on the task — one total function from a kind to a root, so
no asset is ambiguous about where it lives.

**A `concept` is base art too, which is what makes promotion cheap.** It is authored-side — a
sketch of a place or a person, asked for in a sentence rather than planned — so it belongs beside
the plates. `promoteConcept` then rewrites one record in place: the kind flips to `location_ref`,
`sourceTask` becomes the plate's own task identity, `prompt` becomes the derived one, and
`mergeBindings` **keeps** the concept's binding beside the new `{locationId, variant}` so the tree
still shows where the plate came from. The bytes never move, because both kinds route here. That is
the only thing in the system that changes an asset's kind.

**Reads consult both roots, base first.** Hashes are content hashes, so a byte present in both
roots *is* the same byte and the two indices cannot disagree about content. Where both hold a
record for one hash the base record wins, and `manifest()` is the union deduped that way.
`pathOf` answers from whichever index holds the hash, defaulting to the project root for a hash
neither knows.

**Nothing on disk moves.** A project written before the split keeps its base art indexed in
`vngen/build/manifest.json`, and it keeps resolving, because the union reads that manifest
whole. The split governs where *new* bytes land. There is no migration, no rehash, and — since
`taskHash` contains no path — nothing regenerates.

**`satisfies` is a list.** An asset records everything it is for, because bytes are keyed by
content: two tasks producing the same image share one record, and the second binding must not
erase the first. A manifest written with a single record reads as a one-element list, so every
manifest ever written stays readable, and it is rewritten in the canonical form. Ask with
`bindsTo(asset, binding)` rather than reaching into the list.

## Three states, because two would cost money

| State | On disk | Meaning |
| --- | --- | --- |
| `absent` | no `assets/` directory | Legacy or brand-new project. An empty, writable base — the first base write creates the directory. |
| `unavailable` | `assets/` exists, with no readable `manifest.json` | Somebody cloned without the base repo. **Nothing is planned**; the store also refuses to write a base kind. |
| `ready` | `assets/manifest.json` parses | Normal. |

`unavailable` is the state that earns its keep. A missing base repo shows an empty base
manifest; without the distinction the planner sees no portrait for any character and a run
regenerates the entire approved base library. The distinguishing evidence is exactly what a
missing submodule leaves behind: the directory, without the index.

The refusal is deliberately total rather than limited to the four base kinds — every shot
references a location plate and a portrait, so with the base root unreadable there is no
plannable work at all. `baseRefusal(base)` in `@vn/pipeline` is the one sentence, `planTasks`
returns nothing, and `RunSummary.refused` carries it to the surfaces. `vngen run`, `vngen cost`
and `vngen run --mock` all print it and exit non-zero: a zero-work summary is otherwise
indistinguishable from a finished project.

## Surfaces

- `AssetStore.base` → `{ state, root, count }`. `baseAssetsOf(paths)` answers the same without
  opening the project store, for a caller with no reason to parse a build manifest.
- `vngen status` prints the union total, then base and project counts, then the base state when
  it is not `ready`.
- `WorkspaceIndex.baseAssets` carries the same three fields, so the desktop can say
  "unavailable" instead of drawing an empty gallery — which is the same picture as "none yet".
- `Workspace.repos()` reports a `'base'` role when `assets/` is a repository of its own, and
  commit-on-save picks it up with no new policy — see [`repos-and-commits.md`](repos-and-commits.md).

## What this does not do

- **Move existing bytes.** A project that wants its base art in the new root can copy it;
  nothing in the app does it silently.
- **Share a base library between projects.** The layout makes it possible (it is a repo); there
  is no UI, config key, or path indirection for it.
- **Treat `assets/` as authored input.** Everything there is generated art with provenance.
  Hand-drawn references stay in `characters/<id>/refs/`.
- **Collect garbage.** Neither root prunes unreferenced bytes.
