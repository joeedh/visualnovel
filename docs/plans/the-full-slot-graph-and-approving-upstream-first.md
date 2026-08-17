# The full slot graph, and approving upstream first

## Context

The project can only ever see *part* of the work ahead of it. `planTasks` is deliberately
incremental — it runs once per scheduler wave, and a shot cannot even be *hashed* until its plate
has rendered, because `TaskInputs.shot_image.refs` embeds the upstream asset hashes and `taskHash`
covers the whole inputs object. The consequence leaks into the UI: the Task Graph pane draws
*ghost clusters* with estimated counts (`1 + scene.characters.length`), `vngen cost` undercounts,
and an author has no way to see what a picture is waiting on.

The asset editor has the same hole from the other side. It offers Approve with no idea whether the
things this asset was *drawn from* are themselves approved — so an author can bless a shot frame
composed from an unapproved plate, and nothing says so.

**Five deliverables:**

1. The task graph is fully built.
2. The asset editor lists what a given asset needs approved.
3. Approve is disabled while any of those is unapproved, its tooltip being the refusal.
4. Clicking a listed dependency makes it active in the asset editor.
5. An "Unapproved assets" subtree in the document tree, in two groups.

## The one architectural fact this rests on

**"Fully built" cannot mean "every real task hash."** A `shot_image` hash is unknowable until its
plate has actually rendered and its subjects are approved. So the full graph is a graph of **logical
slots** — `portrait:<id>`, `sheet:<id>/<outfit>/<angle>`, `plate:<loc>/<variant>`,
`shot:<scene>/<shot>` — with the planner's real task identity attached to the ones the project can
currently state one for, and a **sentence** on the ones it cannot.

That vocabulary already exists and already states the planner's edge rule declaratively:
`packages/artgen/src/refcycle.ts` — `slotKey`, `slotLabel`, `parseSlot`, `slotOf`, and
`refsOfSlot(binding, ctx)`, whose private `derivedRefs` says a sheet ← the character's approved
portrait, a shot ← its plate + each subject's portrait + each non-default subject's *front* sheet.
Nothing needs inventing; it needs enumerating and inverting.

**Never derive edges from `Task.deps`** — it is documented as incomplete (a `shot_image` lists only
its plate) and is not hashed.

## Two questions that look like one

The single most important decision here is that **the approval gate and the slot graph answer
different questions, and are computed by different walks**.

| | walks | answers |
| --- | --- | --- |
| **Prerequisites** (`prereq.ts`) | `Asset.refs` + authored pins — **hashes** | "what do *these bytes* rest on?" |
| **Slot graph** (`slotgraph.ts`) | `refsOfSlot` — **slots** | "what pictures does this project imply?" |

The asset editor's list and the Approve refusal use the **hash** walk. Three reasons, each decisive:

- **A row has to be clickable.** The author's requirement is that clicking a listed dependency makes
  it active in the asset editor, which needs a hash. A slot walk yields slots, and a slot may have
  no bytes at all.
- **They agree anyway, where it matters.** If an asset exists, everything it was derived from had
  bytes at render time and is in `Asset.refs`. The extra thing a slot walk would report is that an
  upstream slot has *moved since* — and that question already has a name and a walk and a sentence:
  **suspension**. Two derived-on-read walks giving two sentences about one asset is a design; the
  same walk giving two meanings is a bug.
- **A concept and an upload have no slot** (`slotOf` returns `undefined`) but do have `refs`, and
  `art.redraw` pins references onto a concept. A slot walk silently returns `[]` for them.

The slot graph earns its keep in the two places a slot is genuinely the subject: the *Not yet
rendered* group of the document tree, and the Task Graph pane.

## Phase 1 — one enumeration, shared *(done)*

The biggest correctness risk is two enumerations drifting: a slot the graph promises that the
planner never plans. The planner's four private helpers move out and both sides call them.

**`packages/model/src/used.ts`**, exported from `@vn/model` (which `@vn/artgen` already imports):
`reachableScenes`, `usedCharacters`, `usedLocationVariants`, and `usedOutfits(model, shots?)`.

`@vn/model` rather than `@vn/artgen` because all four are pure over a `ProjectModel` and
`usedOutfits` needs `outfitFor`, which already lives there — and because both `@vn/pipeline` and
`@vn/artgen` may import it, which is what "shared" has to mean.

`usedOutfits` gains the one behavioural addition: `shots?: ReadonlyMap<string, readonly Shot[]>`.
The planner omits it and reads `Scene.shots`, which it populates wave by wave; a caller holding the
persisted decompositions passes them and gets the whole answer at once.

`planner.ts` imports the four and loses ~70 lines. The proof the lift was inert is that
`@vn/pipeline`'s suites pass untouched.

## Phase 2 — the slot graph *(done)*

### 2a. `gate.ts` moves down

`isApproved` is needed by the graph builder (a `sheet:` slot has no identity before the gate) and by
the prerequisite rule (a portrait row is blessed by the gate, not by `Asset.accepted`). Move
`packages/pipeline/src/gate.ts` → `packages/artgen/src/gate.ts` and re-export by name from
`@vn/pipeline` — the treatment `prompts.ts` and `cycleRefusal` already got.

### 2b. Extract the slot → task-identity resolver

`packages/artgen/src/adoptslot.ts` already contains this, privately: `resolve()`, `shotUpstream()`
and `taskHashOf()` map a `RefBinding` to the planner's exact identity, with authored refusals for
every reason a slot cannot state one yet. **Extract it rather than writing a third copy** — that is
the duplication this whole plan exists to prevent.

Into `packages/artgen/src/slotgraph.ts`:

```ts
export type ResolvedSlot =
  | { kind: 'portrait'; inputs: TaskInputs['portrait'] }
  | { kind: 'location_ref'; inputs: TaskInputs['location_ref'] }
  | { kind: 'model_sheet'; inputs: TaskInputs['model_sheet'] }
  | { kind: 'shot_image'; inputs: TaskInputs['shot_image'] };

/** The planner's identity for a slot, or the sentence saying why the project cannot state one. */
export function resolveSlot(slot: RefBinding, ctx: SlotGraphContext): Decided<ResolvedSlot>;
export function slotTaskHash(r: ResolvedSlot): string;
```

Four deliberate differences from the version in `adoptslot`:

- It is **pure**. `adoptslot.resolve` does `loadInputs` + `modelFromInputs` + `readShots` inline,
  which a whole-graph pass must not do per slot. `adoptslot.resolve` becomes: load those three, then
  call this. Its `stamp` (the shots array it rewrites) stays in `adoptslot`.
- It gains a `portrait` arm. `adoptslot` refuses `portrait:` with `GATED_SLOT` — that refusal
  belongs to *adoption*, not to identity, and `adoptionForSlot` keeps it in front of the call.
- `shotUpstream`'s sentence loses its last three words (`, then adopt`): it is now also a tree tooltip.
- `graph` is optional. Without one, `shot:` slots resolve to `UPSTREAM_MISSING` and the graph is
  pure shape.

`packages/artgen/src/tests/adoptslot.test.ts` must pass **untouched** — that is the net.

### 2c. `buildSlotGraph`

```ts
export interface SlotNode {
  key: string;              // slotKey(binding)
  binding: RefBinding;
  label: string;            // slotLabel(binding)
  refs: string[];           // upstream slot keys, from refsOfSlot
  taskHash?: string;        // the planner's identity, where the project can state one
  status?: TaskStatus;
  blocked?: string;         // resolveSlot's own sentence, when it cannot
  hash?: string;            // resolveBinding's settled answer
  candidates: string[];     // every manifest asset bound here; empty == not yet rendered
  approved: boolean;
}

export interface SlotGraph {
  nodes: Map<string, SlotNode>;
  dependents: Map<string, string[]>;  // the reverse index TaskGraph has never had
  order: string[];                    // upstream before downstream
}
```

| slot | enumerated from | `taskHash` when |
| --- | --- | --- |
| `plate:<loc>/<variant>` | `usedLocationVariants` | always |
| `portrait:<id>` | `usedCharacters` | always |
| `sheet:<id>/<outfit>/<angle>` | `usedOutfits` × `MODEL_SHEET_ANGLES` | `isApproved(c)` |
| `shot:<scene>/<shot>` | persisted shots of `reachableScenes` | plate done, subjects approved, non-default front sheets done |

Three contracts for the doc comment, because each is the point:

- **Sheets are enumerated for every used outfit whether or not the gate has cleared.** That is
  exactly the difference between a slot graph and a plan, and it is what lets *Not yet rendered* say
  something before approval. **The slot graph is therefore not a prediction of what `planTasks`
  emits this wave** — `vngen cost` remains that answer.
- **Shots come only from persisted decompositions.** A scene with no `work/shots/<id>.json` has no
  shot slots and never gets fabricated ones. Completing the graph is Phase 8, and it is an explicit
  act, never a read path.
- **`hash` and `candidates` are two different answers and both are needed.** `resolveBinding` reads
  a portrait's slot off `character.approvedPortrait`, so it is `undefined` before approval even with
  three candidates in the manifest; and `pick()` deliberately declines when two unaccepted
  candidates tie. Either would land real bytes in *Not yet rendered*, which is a lie. **Empty
  `candidates` is what "not yet rendered" means** — hence `candidatesFor` in `refs.ts`, factored out
  so the filters are written once.

Edges are `refsOfSlot(binding, ctx)` mapped through `slotKey`, **not filtered to enumerated keys**:
an edge to an authored `asset:<hash>` pin is real, `nodes` simply has no entry, and a consumer
treats a missing node as an opaque upstream.

Traversal uses the `visiting`/`decided` shape of `suspendedAssets` — enforcement stops a cycle being
*written*, this guard stops a corrupt project wedging the app. Naming a cycle stays `firstCycle`'s job.

`dependents` is built here, not in `packages/taskgraph/src/graph.ts`: a reverse index over
`Task.deps` would answer a different question than anyone asks, because `deps` is incomplete.

## Phase 3 — prerequisites for one asset *(done)*

**`packages/artgen/src/upstream.ts`**, factored out of `suspend.ts` (whose
`[...asset.refs, ...attached.map(({ ref }) => ref.pin)]` becomes one call, with `suspend.test.ts`
as the net):

```ts
export function attachedRefs(asset: Asset, ctx: RungContext): { chunk: string; ref: ChunkRef }[];
export function upstreamOf(asset: Asset, ctx: RungContext): string[];
```

**`packages/artgen/src/prereq.ts`:**

```ts
export interface Prereq {
  hash: string;
  label: string;
  kind?: AssetKind;
  slot?: string;      // slotKey, so a command can name it
  approved: boolean;
  note: string;       // why it counts, or why it does not yet
  missing?: boolean;  // no manifest record; reported, deliberately not a refusal
}

export function assetPrereqs(asset: Asset, ctx: PrereqContext): Prereq[];
export function prereqRefusal(label: string, prereqs: readonly Prereq[]): string | undefined;
```

The `approved` rule, in order:

| upstream | approved | note |
| --- | --- | --- |
| not in the manifest | **true** | nothing to approve (+`missing`) |
| `portrait` | `isApproved(c) && c.approvedPortrait === hash` | the gate owns it |
| `reference` | **true** | an upload is not generated art |
| `concept` | **true** | a concept is a sketch nothing downstream consumes |
| otherwise | `asset.accepted` | |

Three of five arms are "true", each mirroring a refusal `previewAccept` already gives by name: a
portrait, a concept and an upload **cannot be accepted**, so requiring it would make Approve
permanently unreachable for anything drawn from one. That is the deadlock this table exists to
avoid. The `missing` arm follows `pick()`'s rule — "cannot say" must not read as "it changed".

**Direct prerequisites only.** Induction: `asset.accept` refuses whenever a direct prerequisite is
unapproved, so at the moment any asset was accepted its own direct prerequisites were approved, and
so on down. The closure holds at accept time, the pane stays small, and every row is one click from
actionable. Order is `Asset.refs` order — plate → portraits → sheets → pins — which is meaningful,
so it is **not** sorted.

## Phase 4 — `AssetInfo` and the session *(done)*

`apps/desktop/src/shared/ipc.ts` — `export type { Prereq } from '@vn/artgen'` (**type-only**, or
`vite build` breaks: `src/shared/` is in the browser bundle and neither `tsgo` pass catches it), and
on `AssetInfo`:

```ts
  /** The pictures these bytes were drawn from, in the order the task fed them to the model. */
  prereqs: Prereq[];
  /** Why Approve is disabled — the same sentence `asset.accept` refuses with. */
  unapproved?: string;
```

`prereqs` required (like `rungs`), `unapproved` optional (like `suspended`). Computed in
`session.assetInfo`, which already loads the model, the manifest, the shots and `labelContext`.

**`previewAccept` gets the same refusal**, after `suspended` and before the `ok` return. Four
reasons it must not live only in the pane: `asset.accept` is reachable from the tree's right-click,
the palette, the agent and CDP; suspension — the identical case — already refuses there and
`acceptAsset` calls `previewAccept` "rather than trusting that a check ran"; CLAUDE.md says absence
of a check is not permission; and the tooltip rule needs one sentence owned by the command.

Order matters: `suspended` first (a claim about *these* bytes resting on a moved reference), then
`unapproved` (a claim about other bytes).

**`gate.approve` is deliberately left alone.** A portrait's `Asset.refs` are authored uploads,
`kind: 'reference'`, always approved — the gate would never fire and it would be dead code.

## Phase 5 — the Approve button *(done)*

`apps/desktop/renderer/rules/assetview.ts`, in `approveAction`, after the `concept`/`reference`
refusals and before the `kind !== 'portrait'` split, so it gates both doors:

```ts
if (info.unapproved) return { ok: false, reason: info.unapproved };
```

That string is the disabled button's `.description` — the repo rule is that a disabled control's
tooltip is its refusal, verbatim.

## Phase 6 — the dependency list in the pane *(done)*

A strip headed **DRAWN FROM** in `rebuildBody()`, directly under the frame. One row per
prerequisite: label, an approved/pending badge, clickable.

**Click sets the subject in place** — `this.ui.assetHash = p.hash; this.announce();`, the pattern
`replace()` already uses. Not `view.open ... where: 'elsewhere'`: the point of the list is to walk
*up* the chain approving as you go, and a new pane per hop litters the mesh. A one-slot back chip
makes the walk reversible.

**This strip is deliberately not the reference strip, and a comment says why.** The ref strip shows
the pinned bytes fed to the model, per prompt clause, and its rows detach. This shows what the whole
picture rests on and nothing here detaches — you cannot un-draw a picture from its plate.

Tooltips on the heading and every row, per the absolute rule.

## Phase 7 — the Unapproved subtree *(done)*

Both groups are projections of the slot graph — one walk, no second enumeration, so a slot the tree
promises is a slot `resolveSlot` can name:

- **Awaiting approval** — for every `SlotNode`, every `candidate` the Phase 3 rule says no to. Using
  `candidates` rather than `hash` is what makes an unapproved character's three portrait drafts
  appear at all.
- **Not yet rendered** — every `SlotNode` with `candidates.length === 0`.

Disjoint by construction.

```
branch:unapproved              "Unapproved assets"
  unapproved:waiting           "Awaiting approval (7)"
    asset:<hash>               kind 'asset'  — routes to the Asset editor unchanged
  unapproved:unrendered        "Not yet rendered (23)"
    slot:<slotKey>             kind 'slot'   — no bytes, no path
```

- **Awaiting rows reuse the existing `asset:<hash>` ids.** Selection, `menuFor`, `routeFor` and the
  Asset editor's `claims` all work with zero renderer changes — the branch is a second index into
  the same nodes, which is what it is.
- Not-yet-rendered rows are the new `slot` kind, id `slot:<slotKey>` (`nodeKey` slices at the first
  colon, so the address survives). `note` = `SlotNode.blocked`, which is why Phase 2b was worth doing.
- Ordered by `SlotGraph.order`, so the top of each list is what can be worked on now.
- Both through the existing `capped()` / `DEFAULT_CAP`; the root is omitted entirely when both groups
  are empty.
- `DocTreeInput.slots` is **optional**, so every existing `doctree.test.ts` case passes unchanged.

A `slot` row selects nothing (`selectionForNode`'s `default:` returns `current` — the contract
`branch` and `more` already have). What it is *for* is its right-click menu:
`asset.upload(slot=…)`, `asset.adopt(slot=…)`, `pipeline.run` — all existing commands that already
take a slot string parsed by `parseSlot`, so a portrait slot's entries refuse themselves with the
sentence `adoptionForSlot` already gives.

`DocNode` gains `note?: string`, and `documents.ts` sets `line.title = node.note ?? <path text>` —
today a pathless row carries no tooltip at all, which the tooltip rule already forbids.

## Phase 8 — decomposing every reachable scene

`packages/pipeline/src/p5.ts`: the bare `catch` at :143 is the blocker — a bad key and a good answer
are indistinguishable, and the result is persisted forever. One scene inside a run is the
deterministic-fallback contract working; sixty at once with one bad key silently baselines the whole
project **permanently**, because an absent file is the only signal meaning "decompose". So change
the return type rather than adding a parallel function:

```ts
export interface Decomposition { shots: Shot[]; source: 'model' | 'baseline'; reason?: string }
```

`planner.ts` becomes `(await decomposeScene(...)).shots` — identical behaviour — plus a warning it
cannot emit today.

**`packages/pipeline/src/decompose.ts`** — `decomposeAll`, whose rules each guard an established
hazard: `reachableScenes` only; a scene with a file is `kept` with no provider call; **a baseline is
not persisted** unless `keepBaseline`; an unreadable file is one outcome and the batch continues;
`writeShots` already skips byte-identical rewrites. There is **no `force`** — `work/shots/` wins
forever and re-decomposing would change shot ids, hence task identities, hence re-render art at cost.

**`story.decomposeAll`** — `mutating`, `undoable` (one undo point for the whole batch, which is the
reason it is one command rather than N), `confirm: true`. Its `check` does the **cheap half only**
(a check must not call the model): count scenes with no file, name unreadable ones, and name scenes
carrying an `unknown_character` warning — `resolveSubject` silently drops a `characterId` the model
does not have, so decomposing before the cast exists permanently omits that character.

**`vngen decompose [dir]`** over the same function. `--mock` is **refused by name**: a mock
decomposition is a baseline, and persisting one is the exact failure this design avoids.

## Phase 9 — the Task Graph pane

`Ghost`, `ghostsFor`, `buildDepEdges` and `buildRefEdges` are all deleted — they exist purely to
repair the dishonesty of rendering `Task.deps` literally, and a real slot graph with real edges
answers what they were guessing at. Node identity becomes the slot key, so
`layout.byId.get(ui.slotKey)` needs no mapping table. A task whose slot the graph no longer names
becomes an `orphan` node rather than disappearing silently.

`barrierFor` **survives** — the P3 gate is a planner predicate, not an edge, so it stays a synthetic
node. The module header comment ("The graph is deliberately partial… Ghost clusters stand in for
it") is now false and is rewritten.

This phase can ship after 1–8; nothing else depends on it.

## Verification

```
pnpm exec jest --selectProjects @vn/model      # the lifted enumerators
pnpm exec jest --selectProjects @vn/pipeline   # MUST pass unchanged — proves the lift was inert
pnpm exec jest --selectProjects @vn/artgen     # slotgraph, prereq, cycle guard
pnpm exec jest --selectProjects @vn/desktop    # doctree branch, approveAction refusal
pnpm test && pnpm lint
pnpm check && pnpm check:renderer              # two passes — the renderer is not in the flat check
```

The single highest-value test: build the slot graph, run `planTasks` to exhaustion with mock
providers, and assert **every planned task hash appears as some slot's `taskHash`, and every slot
with a `taskHash` was planned.** That is the drift bug, caught.

Others worth writing by name:

- A slot with three unaccepted candidates lands in *Awaiting approval*, never in *Not yet rendered*.
- A portrait slot is `approved` from `character.approvedPortrait`, not from `Asset.accepted`.
- An upload and a concept upstream never block, and a hash absent from the manifest never blocks.
- A hand-authored ref cycle does not hang `buildSlotGraph`.
- `decomposeAll` with mock providers writes **nothing** and names every scene.
- `adoptslot.test.ts`, `suspend.test.ts`, `refcycle.test.ts` pass **unchanged** — the nets for the
  two extractions.

End to end over `examples/sample`: `story.decomposeAll()` under `--mock` must **refuse by name**;
`asset.accept` on a frame whose plate is unapproved must refuse with the same sentence the greyed
button showed.
