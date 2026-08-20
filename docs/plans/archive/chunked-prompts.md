# Chunked prompts: a composable prompt editor for assets

Status: **shipped** (stages 0–17). Two parts — Part I (§1–§10) is the chunk model and the prompt editor; Part II
(§11–§16) is reference images and the asset reference graph, landed on top of a shipped Part I.

<!-- toc -->
<!-- tocstop -->

## Context

Today an image prompt is a flat string, derived and thrown away on every planning pass. The four
builders in `packages/artgen/src/prompts.ts` each assemble an array of clause strings and collapse
it with `.filter(Boolean).join(' ')`; the result goes into `TaskInputs.*.prompt`, which is folded
into the task's content hash, and onto the manifest as `Asset.prompt`.

That design was deliberate — see the Context section of
[`asset-names-and-the-asset-editor.md`](asset-names-and-the-asset-editor.md), which rejected an
editable prompt on the grounds that a hand-written one would freeze an asset against every future
improvement to the builders. The escape hatch shipped instead was `artNotes`: free text at five
rungs, **appended** to what the builder derived.

Art notes turned out to be the right idea at the wrong granularity. An author who wants the palette
clause gone, or the scaffolding sentence reworded, or the whole thing condensed because the image
model is choking on a 400-character run-on, has no move. And the one prompt that *is* editable — a
concept's — is editable only by hand-copying the entire string, which `editImageTool`'s own
description admits (`packages/authoring/src/tools.ts:948`: "pass the whole prompt, starting from the
one `list_images` reports, so the style preamble and the framing line survive").

This plan keeps the builders authoritative and makes their **internal structure visible and
overridable**. The array of clauses each builder already builds becomes a first-class
`PromptChunk[]`; `renderPrompt` collapses it exactly as today, so a project that overrides nothing
produces byte-identical prompts and every existing task hash stays where it is. On top of that sit
per-chunk overrides, a user-written whole-prompt replacement, and an agent-condensed prompt that
must remain faithful to the chunks it condensed.

A chunk is also where a **reference image** attaches — either a linked asset already in the store or
a custom upload — which makes the chunk list the authored half of the reference graph as well as the
prompt. That half is **Part II**; it is independently landable after Part I and roughly doubles the
work.

**Every override in this plan records what it was written against.** A replaced chunk snapshots the
derived text it replaced, a condensed prompt snapshots the chunk list it condensed, and a linked
reference snapshots the hash it pinned. That one repeated shape is what makes the whole design
answerable by an agent: "the thing under you changed, here is what it used to say, carry your edit
forward."

### The three hard constraints

1. **`TaskInputs.*.prompt` stays a flat `string`.** `taskHash` is `hashParts(kind, inputs)` over
   `canonicalJson` with **no allow-list** (`packages/taskgraph/src/hash.ts:10`,
   `packages/util/src/hash.ts:12-31`) — any new key in the inputs object re-keys every task in every
   existing project, and orphans every recorded fixture, since `requestKey`
   (`packages/providers/src/cache.ts:27-33`) hashes the flat prompt too. Chunks are an
   authoring/presentation structure; `composePrompt` is the boundary.
2. **Byte-identity is the acceptance test.** A project authoring no override must produce
   character-for-character the same prompts, and therefore the same task hashes. This is the same
   bar `artNotes` cleared and it is pinned by a test written *before* any code changes.
3. **A held agent prompt must not move the task hash.** "Flag and hold" means the stale text stays
   in place — so `composePrompt` in `agent` mode returns the stored text *unconditionally* and never
   falls back to freshly rendered chunks. If it fell back, the asset would re-render, which is
   exactly what holding exists to prevent.

---

## 1. The chunk model — `packages/artgen`

New `packages/artgen/src/chunks.ts`, exported from the package barrel.

```ts
export type ChunkCategory =
  | 'style' | 'subject' | 'description' | 'mood' | 'variant' | 'palette'
  | 'camera' | 'framing' | 'art-notes' | 'scaffolding' | 'request';

export interface PromptChunk {
  /** Stable across re-derivation — an override is keyed by it. Derived from the origin
   *  address, never from position or text, so editing art notes keeps the override. */
  key: string;
  category: ChunkCategory;
  /** The sentence this chunk contributes, already punctuated and whitespace-normalized. */
  text: string;
  origin: ChunkOrigin;
}

export type ChunkOrigin =
  | { kind: 'project'; field: 'art_style' }
  | { kind: 'character'; id: string; field: string }
  | { kind: 'outfit'; id: string; outfit: string }
  | { kind: 'location'; id: string; field: string }
  | { kind: 'variant'; id: string; variant: string }
  | { kind: 'shot'; sceneId: string; shotId: string; field: string }
  | { kind: 'art-notes'; target: string }   // an `art.setNotes` address
  | { kind: 'request' }                     // a concept's authored sentence
  | { kind: 'builder' };                    // scaffolding — no document behind it

export function renderPrompt(chunks: readonly PromptChunk[]): string;
export function composePrompt(chunks: readonly PromptChunk[], o?: PromptOverride): Composed;
export function chunkFingerprint(chunks: readonly PromptChunk[], o?: PromptOverride): string;
```

`renderPrompt` is character-for-character the tail of every existing builder
(`prompts.ts:47-50`), so byte-identity is structural rather than lucky:

```ts
chunks.map((c) => c.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
```

Two spacing subtleties get a comment in the source, because they _are_ the byte-identity argument:
`paletteClause` (`prompts.ts:21-23`) returns a **leading-space** string that per-chunk normalization
trims (harmless — `join(' ')` re-supplies it), and the old `.filter(Boolean)` kept an all-whitespace
clause that the final collapse erased anyway. Both are asserted in tests rather than argued.

### Chunk inventory — one chunk per existing array slot

| Builder                        | Chunks, in order                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| portrait (`prompts.ts:38-51`)  | `style` · `subject` · `description` · `palette` · `art-notes`(`character:<id>`) · `scaffolding`                     |
| location (`prompts.ts:54-77`)  | `style` · `subject` · `description` · `mood` · `variant` · `variant-desc` · `palette` · `art-notes` · `scaffolding` |
| model sheet (`prompts.ts:80-99`) | `style` · `subject` · `reference` · `description` · `palette` · `art-notes` · `scaffolding`                       |
| shot (`prompts.ts:102-132`)    | `style` · `framing` · `subject` · `camera` · `art-notes`(`shot:<scene>/<id>`) · `scaffolding`                       |

Two consequences of the one-slot-one-chunk rule that must be written down, not discovered:

- **There is no `wardrobe` chunk.** `prompts.ts:88` puts the outfit _inside_ the subject sentence
  (`Full-body front view of AIKO wearing the gala dress.`). Splitting it out changes the model-sheet
  prompt for every project and re-keys every sheet task. The outfit is recorded as a second source
  on the `subject` chunk instead, so the card can still name the rung it came from.
- **`art-notes` is one chunk even where two rungs feed it.** `artClause(a, b)` (`prompts.ts:32-35`)
  emits a _single_ `Art direction: A B` sentence; two chunks would emit the prefix twice.

### Override shape — `packages/types`

```ts
/** Authored text plus the derived text it was written against. */
export interface ChunkEdit {
  text: string;
  /** sha256 of the chunk's derived text when this was written. Absent on a pre-`of` edit. */
  of?: string;
}

export interface PromptOverride {
  mode: 'chunks' | 'custom' | 'agent';
  mute?: string[]; // chunk keys
  order?: string[]; // partial; unlisted keys keep derivation order, after
  replace?: Record<string, ChunkEdit>;
  append?: Record<string, ChunkEdit>;
  custom?: string; // mode === 'custom'; verbatim, trimmed only
  agent?: { text: string; of: string; modelId?: string; at?: string };
  refs?: Record<string, ChunkRef[]>; // Part II — see §12
}
```

`composePrompt` order of operations: per-chunk `replace` → `append` → `mute`; then reorder; then
whole-prompt (`custom` wins outright; else `agent.text` **always**, with
`stale = agent.of !== chunkFingerprint(...)`; else `renderPrompt`).

### Every override records what it replaced

`ChunkEdit.of` is the per-chunk analogue of `agent.of`, and it is what makes propagation possible.
Without it, an author's replacement is an orphan string: when the derived text underneath moves —
the art style is retuned, a description is rewritten — nothing can tell whether the replacement is
still apt, and an agent asked to carry the edit forward has the author's text and no idea what it
was reacting to. With it, the agent gets the **old derived text, the new derived text, and the
author's replacement**, which is enough to rewrite the replacement the way the author would have.

So a chunk carries its own staleness, independent of the whole-prompt hold:
`chunkStale = edit.of !== undefined && edit.of !== sha256(derivedText)`. The card shows it, the same
flag drives a future propagate action, and — like every other staleness in this plan — it is
**derived on read, never stored**. An `of` that is absent (an edit written before this field
existed) reads as unknown, never as stale, exactly as `Shot.proseHash` does.

**Fingerprint rule:** `sha256` over `key\ntext` of the **enabled** chunks after replace/append, in
effective order. Muting and unmuting round-trips to the same fingerprint. Reordering does _not_ —
the agent chose that sentence order for the image model — and the reorder gesture warns about this
before the drop.

`packages/artgen/src/resolve.ts` (pure) maps an asset to its override; see §2. New
`packages/artgen/src/coverage.ts` holds the representation check used by condensing and by the pane:
lowercase, strip punctuation, drop a stopword list plus the builders' own connectives, and require a
chunk's distinctive content words to be present. It is a heuristic and every surface must say
"not found", never "the agent dropped it".

---

## 2. Storage: one override, at the rung that names the whole picture

The override lives at exactly the rung that names one prompt, so "which override applies" is a
lookup and never a merge chain:

| asset kind                     | owning rung                | file                                        |
| ------------------------------ | -------------------------- | ------------------------------------------- |
| `portrait`                     | `character:<id>`           | `characters/<id>/character.md` front matter |
| `model_sheet` / `outfit_sheet` | `character:<id>/<outfit>`  | same file, inside the `outfits:` entry      |
| `location_ref`                 | `location:<id>/<variant>`  | `locations/<id>.md`, inside `variants:`     |
| `shot_image`                   | `shot:<sceneId>/<shotId>`  | `vngen/work/shots/<sceneId>.json`           |
| `concept`                      | none — already authored    | —                                           |

Character-level and location-level rungs _contribute chunks_ but never _hold_ overrides, which is
what removes the need for a surface-keyed map. Front matter is snake_case like its neighbours:

```yaml
prompt_override:
  mode: chunks
  mute: [palette]
  order: [style, subject, description, palette, scaffolding]
  replace: { subject: 'Aiko, seen from behind' }
```

**Model sheets accept a known coarseness:** the angle is recorded only on the _task_
(`assetprompt.ts:50-51`), never on a rung, so one override covers all four angles of an outfit. The
card says so — _"this override covers every angle of this sheet"_ — rather than the plan inventing a
per-task override home that would break the one-rung rule for one kind.

Files to touch, none of which invents a new pattern:

- `packages/types/src/entities.ts` — optional `promptOverride?` on `Character`, `Outfit`,
  `Location`, `LocationVariant`, `Shot`.
- `packages/types/src/schemas.ts` — the zod object, wired into `characterFrontMatter`,
  `locationFrontMatter`, `outfitEntry`/`variantEntry` (both `.strict()`, so this is required before
  any sheet can carry one) and the shots-file schema beside `artNotes` at `schemas.ts:234-242` —
  **never inside `shotDataSchema`**, which is the derived half.
  **No `.default()` anywhere in this schema**: defaults would make `compact()`
  (`serialize.ts:18-20`) keep an empty key on every sheet's first edit, which is the exact failure
  `wardrobeData`'s `synthesized` check at `serialize.ts:29-34` exists to prevent.
- `packages/model/src/entities.ts` / `serialize.ts` — read in `characterFromDoc`/`locationFromDoc`,
  write in `*ToDoc`. `wardrobeData` (27-45) and `variantData` (48-55) must escalate to long form when
  a `prompt_override` is present, exactly as they already do for `art_notes`; otherwise an outfit's
  override is silently dropped on the next write. `CharacterEdit`/`LocationEdit` gain
  `promptOverride?`, cleared by `undefined`/empty per the existing `setOrClear` idiom.
- `packages/store/src/shots.ts` — round-trip `promptOverride` as an authored top-level field in
  `readShots` (near line 82) and `serialize` (near line 104).

---

## 3. Staleness and holding: derived, never written

Nothing flips a stored flag. Two derived answers:

- **`stale`** — today's string comparison in `session.ts:582` (`derivePrompt` vs `asset.prompt`),
  unchanged for `chunks` and `custom` mode.
- **`held`** — `mode === 'agent' && chunkFingerprint(now) !== override.agent.of`. One line, computed
  on every read, and it cannot be missed by a write path we do not control (an author editing
  `description:` through `doc.write` changes chunks and will never call an unapprove helper).

This means **no `AssetStore.unaccept`, no `Asset.promptChunks` manifest field, and no `Task`
field.** All three were considered and rejected: writing acceptance would touch `manifest.json`,
and `assets/manifest.json` is inside `UNDO_PATHS` while `vngen/build/assets/manifest.json` is
excluded (`commands/index.ts:314`) — so undoing a condense would restore a portrait's acceptance and
silently not restore a shot frame's.

`held` gates two doors: `asset.accept` and `gate.approve` refuse while held (both already call
`assetInfo`, so this is free), and `vngen status` reports the count. It deliberately does **not**
gate the planner — a held prompt does not move the task hash, so the planner would plan nothing
anyway, and adding a predicate there would be a vacuous one that reads as load-bearing.

---

## 4. Condensing

New `packages/artgen/src/condense.ts`:

```ts
export async function condensePrompt(
  chunks: readonly PromptChunk[],
  text: TextLLM,
  keep?: string, // an existing custom prompt to reconcile against (force mode)
): Promise<{ prompt: string; coverage: ChunkCoverage[]; source: 'llm' | 'fallback' }>;
```

`ArtGenDeps` is **not** widened — condensing is not part of on-demand generation, and an optional
`text` there would tell every reader that concept generation might use an LLM, which it does not.
The caller already holds `providers.text`.

Follows the P5 house pattern (`p5.ts:117-145`) exactly: a system prompt stating the contract
(rewrite into one prompt an image model handles well; every enabled chunk must be represented; name
what you could not fit), a numbered `[key] text` user prompt, `text.structured` against
`z.object({ prompt: z.string().min(1), omitted: z.array(z.string()).default([]) })`, and on any
throw a deterministic fallback to `renderPrompt(chunks)` — which is what makes `--mock` behave.

The model's `omitted` list is **advisory only**; the authoritative answer is the local
`coverage()` check run over the returned text. A model asked "did you cover everything?" answers yes.
Nothing rejects a condensation for poor coverage — it is reported, the same posture as `driftOf`.

Condensing is an **authoring-time action**. It never runs during planning, which keeps `planTasks`
deterministic and offline.

---

## 5. Commands — a new `prompt.*` namespace

New `apps/desktop/src/main/commands/prompt.ts`, `defineFor<CommandHost>()` with the same `verdict()`
helper as `art.ts:17-19`, registered in `commands/index.ts`. A new namespace rather than more
`art.*` because `art.setNotes` writes _authored input that feeds the derivation_ while these write
_an override of the derivation_ — different act, different block on disk.

Every command addresses the asset by **hash**; the session resolves hash → owning rung with the same
binding logic as `rungsFor` (`artnotes.ts:100-138`).

| id                 | props                                                                                     | undoable | check                 |
| ------------------ | ----------------------------------------------------------------------------------------- | -------- | --------------------- |
| `prompt.info`      | `hash`                                                                                     | —        | —                     |
| `prompt.setChunk`  | `hash`, `chunk`, `op: oneOf(['replace','append','mute','clear'])`, `text: string(default '')` | yes      | `previewPromptChunk`  |
| `prompt.moveChunk` | `hash`, `chunk`, `after: string(default '')` (`''` = top)                                   | yes      | `previewMoveChunk`    |
| `prompt.setCustom` | `hash`, `text: string(…, {digest:true})` — **required**                                     | yes      | `previewCustomPrompt` |
| `prompt.condense`  | `hash`, `force: boolean(default false)`                                                     | yes      | `previewCondense`     |
| `prompt.clear`     | `hash`, `part: oneOf(['all','chunks','order','custom','agent'], default 'all')`              | yes      | `previewClearPrompt`  |
| `prompt.check`     | `hash`                                                                                     | —        | —                     |

Shape notes:

- **One `setChunk` with an `op`, not four commands.** Replace/append/mute/clear are one authorial
  act on one card; four ids would quadruple the palette cost and make the undo history read as four
  unrelated verbs.
- **No `digest` on `setChunk.text`** — digesting records a sha instead of the text
  (`props.ts:47,89`), right for a whole prompt, wrong for a sentence where the history line _is_ the
  record. Conversely `setCustom.text` must be digested and therefore **required**: the overload set
  in `props.ts:56-58` has no digest-plus-default signature.
- **`moveChunk`, not `setOrder`** — matches `story.moveShot`/`story.moveLine` verbatim; a whole-list
  order prop is a thing an agent gets subtly wrong and no gesture produces. "Reset the order" is
  `prompt.clear(part='order')`.
- **`condense` is not `confirm: true`** — `art.generate` confirms because it spends an _image_ call;
  this is the text call P5 already makes per scene without asking. It _is_ undoable.
- **`force` is the reconciliation flag.** Without it, `check` refuses when `mode === 'custom'`,
  naming the flag: _"A custom prompt is already written. `prompt.condense(hash='…' force=true)`
  reconciles it against the chunks instead of discarding it."_ With it, the custom text is handed to
  the model as the thing to preserve.
- Every write lands in `characters/**`, `locations/**` or `vngen/work/shots/**` — all inside
  `UNDO_PATHS`, nothing in `vngen/state` or `vngen/build`.

Plus `project.setArtStyle(style)` in a new `commands/project.ts`: mutating, undoable, and
**`confirm: true`**, because `stylePreamble` is in every image prompt (`prompts.ts:15-18`) and
changing it re-keys every image task. `check` reports the count. It writes through a new
`withArtStyle`/`setArtStyle` in `packages/config/src/config.ts`, spliced line-wise beside the
existing `withStartScene`/`setStartScene` (`config.ts:34-42`) — the YAML is never re-serialized.

---

## 6. Session

In `apps/desktop/src/main/session.ts`, following `artNotesPlan`/`previewArtNotes`/`setArtNotes`
(`session.ts:751-812`) exactly.

`promptView(hash)` loads the project, resolves the owning rung, derives chunks, reads the stored
override, and projects a plain-data `PromptView` (mode, chunks with per-chunk override state and
coverage marks, the effective string, `held`, `missing`, and a `frozen` reason for a concept). It is
folded into `AssetInfo` (`shared/ipc.ts:374-402`) as `prompt?: PromptView` and `held: boolean`, so
the pane makes one round trip and there is one invalidation path; `prompt.info` is a thin command
over the same projection for agents and CDP.

**The renderer must not import `@vn/artgen`** (CLAUDE.md forbids it in `src/shared/`), so
`apps/desktop/src/shared/prompt.ts` re-declares `ChunkOrigin` and `PromptChunkInfo` as plain data,
the way `AssetInfo` already projects `Asset`. `session.ts` maps between them in one place.

Six preview/act pairs funnel into one private `overridePlan(project, hash, edit)` returning
`{ok:false, reason}` or `{ok:true, note, file, write}`. It refuses a concept by name (_"A concept's
prompt is the sentence it was asked for — edit it above, or `art.redraw`"_) and returns one of two
writers: the entity-doc writer (`applyCharacterEdit`/`applyLocationEdit` + `writeFileAtomic`) or the
shots writer (`readShots`/`writeShots`) — the same two-branch shape as `session.ts:790-812`, and the
only place the storage split appears.

---

## 7. Pure rules, and where each is tested

The desktop jest project is node-only, so every _rule_ goes in a `.ts` with a `tests/` sibling.

- **`apps/desktop/src/shared/promptops.ts`** — `effectiveOrder`, `moveChunk`, `enabledChunks`. Mirrors
  `shared/coverage.ts`. `moveChunk` returns the `noop` flag the same way `planShotMove` does
  (`interactions.ts:357`): a drop that changes nothing is not a target.
- **`apps/desktop/renderer/rules/promptview.ts`** — parallel to `rules/assetview.ts`: `chunkVoice`,
  `chunkTag`, `originAction`, `modeStrip`, `heldNote` (sibling to `driftNote`), `condenseAction`
  (including the force rule, so button and agent give the same answer).
- **`apps/desktop/src/shared/interactions.ts`** — one new `promptReorder` interaction beside
  `timelineReorder`, added to `INTERACTION_IDS` and `createDesktopInteractions()`. It earns its place
  as an interaction rather than a click handler because it has two real refusals: a no-op drop is
  omitted entirely, and in custom mode the whole gesture is `UNRESOLVED` — _"A custom prompt has no
  chunk order; the list below is only what the agent would be given."_ An accept's note also carries
  the reorder-invalidates-agent warning, so the author reads it before the drop.

---

## 8. The pane

In `apps/desktop/renderer/pathux/editors/asset.ts`, `rebuildBody()` (line 277) keeps the head,
frame, promote strip and drift note. The read-only `PROMPT · AS DERIVED TODAY` block at lines
306-322 is replaced by, in order:

1. **Mode strip** — segmented `Chunks` / `Custom` / `Agent`, plus `Condense…` and `Check`. It never
   sets a mode field: `Chunks` runs `prompt.clear(part='custom')`, `Custom` runs `prompt.setCustom`
   **prefilled with the composed text whole** (same reasoning as `promptStrip`'s comment at
   `asset.ts:406-409`), `Agent` runs `prompt.condense`. A disabled button carries the refusal
   sentence as its tooltip, as `approveAction`'s already does (`asset.ts:258-261`).
2. **The effective prompt** — the existing `.as-prompt` block, in _every_ mode. Whatever the chunks
   are doing, the one string that would be sent is on screen.
3. **The held banner** (`.as-held`, shaped like `.as-drift`) with a `Recondense` button.
4. **Chunk cards** in effective order: a coloured drag rail, a tag row (mono category tag, the chunk
   address, a `⇱` origin button), the text (a replacement shows the original beneath at
   `--mist-dim`; an appendix is prefixed `+`), and `Mute`/`Replace…`/`Append…`/`Reset`. The inline
   textareas commit on **Ctrl+S or blur** exactly like `rungBox` (`asset.ts:452-482`), including
   `event.stopPropagation()` on every keydown. In custom/agent mode the cards stay, dimmed, marked
   `represented ✓` / `not found ✗` — that is how "the agent's prompt represents every chunk" is
   shown, on the chunks themselves rather than in a dialog.
5. **The custom box** (custom mode), then **`ART NOTES`** — the existing rung boxes, unchanged.

The pane's `dirty: Set<string>` guard (`asset.ts:38-39`) gains `chunk:<key>` and `custom` keys so a
background refetch cannot eat a half-typed replacement.

**The reorder gesture** follows `pathux/timeline.ts` line for line: one `targets()` call on grab,
every move a lookup that draws a 2px insertion rule and shows the verdict sentence in the footer,
**no card moves until pointerup**, and the drop executes `verdict.invoke` verbatim. `Alt+↑`/`Alt+↓`
on a focused card runs the same command through the same lookup — worth having for its own sake, and
it is what lets the CDP script drive a reorder without synthesising pointer events.

### Colour: hue carries voice, texture carries category

Twelve categories cannot be twelve hues, and CLAUDE.md's "don't add new accent hues" is what keeps
the app legible. So:

- **Hue = who wrote the words.** `--sodium` when the text comes verbatim out of a document an author
  edits (`style`, `description`, `mood`, `variant`, `palette`, `camera`, `art-notes`, `request`);
  `--signal` when the _builders_ wrote the sentence (`subject`, `framing`, `scaffolding`). Rendered
  as a 3px left rail plus a 7% wash — the idiom `.as-promote` and `.as-drift` already use
  (`asset.css:112-124,167-176`). This extends `styles/asset.css`'s own machine-above/human-below
  sentence one level down rather than contradicting it.
- **Category = a rail texture + a mono uppercase tag** (`PALETTE`, `ART NOTES`) in the existing
  `.as-badge` typography. Zero new tokens.
- **Muted** = 45% opacity, struck through, rail flattened to `--ink-line`. **Overridden** = a 5px
  rail and `· REPLACED` / `· APPENDED` on the tag, mirroring `.as-badge.stale`.
- `--vermilion` is spent on exactly one thing: the `not found ✗` coverage marker.

All of it goes in `renderer/styles/asset.css` — the chunk editor lives in the asset pane's shadow
root, and two adopted sheets in one root create a cascade question nobody should have to answer.

---

## 9. The twelfth editor: `project`

The `style` chunk originates in `project.yaml`, which has no editor — so `⇱` needs one.

- `apps/desktop/src/shared/editors.ts`: `{ id: 'project', title: 'Project', what: 'project.yaml — art style, models, image params' }`. That one line puts it in `view.open`'s `oneOf(EDITOR_IDS)`, the palette and `editorNameProblems`.
- `apps/desktop/renderer/pathux/editors/project.ts`: `ProjectEditor extends VnEditor`, `areaname: 'project'`, `registerEditor(ProjectEditor, 'vn.ProjectEditor')` at the bottom, side-effect import in `shell.ts`. Raw-DOM surface via `appendSurface` + `adoptStyle` from a new `renderer/styles/project.css` (adopted into the shadow root, **not** added to `styles/index.css`).
- **Not in `SUBJECT_OF`** — a singleton has no subject, so `commands/view.ts` is untouched.
- Deliberately narrow: one editable textarea for `art_style`, read-only rows for `title`, `start`, `models.*`, `image_params.*`.
- _Rejected:_ routing `project.yaml` through the `wiki` editor as raw text. It has no front matter, `doc.read`/`doc.write` are markdown-shaped, and a malformed YAML save breaks `loadConfig` → every pane blanks at once with the only recovery outside the app.

### The `⇱` routing table (`originAction`, node-tested)

| origin                | opens       | how                                                                                       |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `project#art_style`   | `project`   | `view.open(editor='project' where='elsewhere')`                                            |
| `character` / `outfit`| `wiki`      | publish `ui.characterId`; `view.open(editor='wiki' … subject='characters/<id>/character.md')` |
| `location` / `variant`| `wiki`      | `subject='locations/<id>.md'`                                                              |
| `shot`                | `timeline`  | set `ui.sceneId` + `ui.shotId`, `announce()`, **then** `view.open`                         |
| `art-notes`           | stays put   | scrolls to that rung's box further down this pane                                          |
| `request`             | stays put   | scrolls to the concept prompt strip above                                                  |
| `builder`             | no button   | the card shows `built in` where the address would be                                       |

`script`/`timeline` are absent from `SUBJECT_OF` (`view.ts:47-51`) and stay absent — a shot needs
_two_ selection fields. So the pane publishes then opens, which is exactly `showTask()`'s pattern
(`asset.ts:200-206`); the ordering matters, or the new pane reads the previous selection on its
first `update()`. A shot chunk must never route to `wiki`, since `doc.write` refuses `scenes/**`
(`doc.ts:6-8`). `where: 'elsewhere'` throughout, per `documents.ts:436-442`.

---

## 10. Concepts

A concept records one flat prompt string and `derivePrompt` returns `undefined` for it by design
(`assetprompt.ts:36-38`); the author's original sentence is not stored separately, so its chunks
cannot be recovered after the fact. This plan does **not** reverse-engineer them. A concept shows a
single read-only `request` chunk holding its whole recorded prompt, `frozen` explains why, and the
existing redraw strip is unchanged. Recording a chunk list at draw time is a clean follow-up.

---

# Part II — Reference images and the asset reference graph

Independently landable after Part I, and roughly the same size again.

## 11. What already exists

Worth stating before designing, because more of this is built than it looks:

- **`Asset.refs: string[]`** — _"Reference asset hashes fed into the generation, in order"_
  (`packages/types/src/entities.ts:256`) — is written at **every** generation site
  (`runners.ts:49,86,121`, `concept.ts:107,231`) and persisted verbatim into `manifest.json`
  (`assetstore.ts:141`). A real, ordered asset→asset edge set is already on disk for every asset ever
  generated: a model sheet records the portrait, a shot records `[plate, portrait…, sheet…]`. It is
  read in exactly one place (`concept.ts:198-201`, redraw carrying refs forward). **No traversal, no
  reverse index, no invalidation.** The graph exists; nobody walks it.
- **`TaskInputs.*.refs: AssetRef[]`** is inside the task hash, and `canonicalJson` maps arrays
  positionally (`packages/util/src/hash.ts:14`) — so both membership *and order* re-key a task.
- **Cycle enforcement is nearly vacuous.** `topoOrder()` throws `VnError('CYCLE')`
  (`graph.ts:77-79`), but its only production caller is the cost preview (`pipeline.ts:76-83`); the
  scheduler drives off `ready()` and would **silently starve** instead. And it walks `deps`, which is
  not the ref graph: a `model_sheet` references the portrait with **no dep edge at all**
  (`planner.ts:103-110` passes no third argument), and a `shot_image` records edges only for the
  plate and non-default sheets (`planner.ts:344`), not the portraits it references. Nothing derives
  `deps` from `refs` and nothing checks they agree. There is no real check today because
  planner-derived refs are *structurally* acyclic — portrait→sheet→shot, plate→shot. Cycles only
  become expressible once an author can link arbitrary assets.
- **No ingest path for outside bytes.** `AssetKind` is the six generated kinds; `store.write` is the
  only ingress and all six call sites feed it provider output or bytes already in the store.
- **`Character.referenceImages: string[]`** (`entities.ts:60-61`) — _"User-supplied reference image
  paths"_ — round-trips through front matter (`serialize.ts:68,259,293`) and is settable by the agent
  (`tools.ts:372`), and is **never read by the planner, any prompt builder, or any provider.** The
  feature was designed, its storage shipped, and it was never connected. **This plan supersedes it**
  (§15).

## 12. A reference attaches to a chunk

A reference is *evidence for a clause* — "this is what the gala dress looks like" belongs to the
wardrobe sentence, not to the prompt at large. Scoping refs to chunks buys two properties for free:
muting a chunk drops its references too, and the `⇱` origin button and the reference sit on the same
card, so what the model is being told and what it is being shown are read together.

```ts
export type ChunkRef =
  /** A linked asset: pinned by hash, remembering the slot it was resolved from. */
  | { pin: string; ext: string; from: RefBinding; note?: string }
  /** A custom upload: bytes with no slot behind them, so it can never drift. */
  | { pin: string; ext: string; note?: string };

/** The logical slot a linked reference was resolved from — never a hash. */
export type RefBinding =
  | { kind: 'portrait'; characterId: string }
  | { kind: 'sheet'; characterId: string; outfit: string; angle: string }
  | { kind: 'plate'; locationId: string; variant: string }
  | { kind: 'shot'; sceneId: string; shotId: string }
  | { kind: 'asset'; hash: string }; // a concept or an upload — identity *is* the hash
```

**Ordering into `TaskInputs.refs`:** planner-derived refs first, in exactly today's order, then
authored refs in effective chunk order and within a chunk in authored order. Derived-first is what
keeps a project with no authored refs byte-identical, and it is the only ordering that does — arrays
are positional in the hash.

**A muted chunk contributes no refs.** Stated explicitly because it is the one place the prompt
structure reaches into the task hash, and someone will otherwise assume mute is cosmetic.

## 13. Pinning, and why suspension needs it

The requirement is that a changed upstream asset **suspends** its dependents — existing bytes stay,
marked out of date, and the author chooses re-approve or regenerate. That is *incompatible* with a
live reference: `refs` is inside the task hash, so a reference that resolved freshly on each pass
would re-key the task and the scheduler would regenerate it automatically on the next run, with
nobody asked. Auto-cascade and suspension are the same fork; you cannot have both from one value.

So a linked reference **pins a hash and separately remembers the binding**. The task hash sees the
pin, so nothing moves on its own. Drift is a comparison, derived on read:

```
refDrift(ref) = ref.from !== undefined && resolve(ref.from) !== ref.pin
```

`resolve` is a new pure function mapping a `RefBinding` to the hash that slot holds today — for a
portrait, `Character.approvedPortrait`; for a sheet or plate, the manifest entry whose `satisfies`
binding matches; for an upload or concept, the hash itself. It is the binding→hash resolver the
planner conspicuously lacks (refs come from `approvedPortrait` or `doneOutput` today, never from a
lookup), and it belongs in `@vn/artgen` beside `resolve.ts`.

### Suspension is derived and transitive

An asset is **suspended** when any authored reference on its effective chunk list has drifted, **or**
any asset it references is itself suspended. The second clause is what makes it viral: a plate going
stale suspends every shot pinned to it, with nothing written and nothing to keep in sync. A stored
flag would need a cascade pass that could be interrupted halfway; a walk on read cannot be.

The walk goes over `Asset.refs` from the manifest (already on disk, §11) plus the authored pins, is
memoized per project load, and carries a `visited` set — so a cycle that reached disk some other way
is **reported**, not hung on. That guard is not redundant with §14: enforcement stops cycles being
written, and the guard stops a corrupt project from wedging the app.

Suspension gates the same doors as `held`: `asset.accept` and `gate.approve` refuse, and
`vngen status` reports the count. It must also be **enumerable, not just per-asset** — an agent
clearing a subtree needs every suspended asset in dependency order with the reason for each, so
`asset.suspended` is a listing command, not a field on `AssetInfo`.

### Clearing it

- **Regenerate** — repin to the resolved hash and let the scheduler run the newly-keyed task. Nothing
  novel; this is what happens today, just requested rather than automatic.
- **Re-approve** — repin **without** regenerating: the existing bytes are still right despite the
  upstream change. Repinning re-keys the task, so the new identity has no output and would be planned
  — which means re-approve has to log that task `done` with the existing asset as its output.

There is exactly one precedent for writing a `done` record outside the scheduler: `promoteConcept`
(`promote.ts:168-185`), which is careful to compute the task identity **from the state it just
wrote**, so it cannot forge work that never happened. Re-approve is the second, and it must hold the
same property. **The guard goes in a standalone function** taking an asset and its pin state and
returning either a `done` record or a refusal — not inline in the command handler — so the batched
version in a later plan is a loop plus a transaction boundary rather than a reimplementation of the
same safety property. `promoteConcept` should be refactored onto it, since it is currently the inline
version of exactly this and one caller is the only reason that has been fine.

**Batching is deliberately out of scope** (see Open).

## 14. The DAG, and where it is enforced

Enforcement is over the **reference graph**, not `deps` — `deps` is incomplete, ad hoc, and not
hashed (§11), so `topoOrder` checks the wrong edges and would not see a ref cycle at all.

**The cycle is over logical slots, not hashes.** "Aiko's portrait references Aiko's gala sheet" is a
cycle even though no hash repeats, because the sheet's prompt already references the portrait
(`planner.ts:108`) — and its failure mode is the nastiest one available: `doneOutput` returns
`undefined`, `missingRef` is set, the shot is skipped, and the plan-run-replan loop **starves in
silence** forever. So the check resolves candidate refs to the task identities they imply and looks
for the current asset's own slot in the transitive closure.

**Enforced at write time**, in `prompt.addRef`'s `stack.check`: refusing at plan time would mean the
project is already broken on disk and the author meets the refusal as a run failure instead of a
rejected gesture. The refusal **names the path** (`aiko portrait → aiko/gala front sheet → aiko
portrait`), because `topoOrder`'s existing `'task graph contains a cycle'` says nothing about where,
and that is not a message to copy.

A defensive check stays in the planner as an assertion — a corrupt or hand-edited project should
error loudly rather than starve, which is the one behaviour §11 shows the scheduler cannot currently
manage.

## 15. Custom uploads, and retiring `referenceImages`

A custom upload is a different animal from a linked asset: it has no binding, so it can never drift,
and it is the rare case. It needs the one thing the store has never had — an ingress for outside
bytes.

- **New `AssetKind: 'reference'`.** Not `concept`: a concept is defined as never consumed and never
  exported, and a reference is consumed by construction. Routed to the **base** root (`assets/`), with
  the authored art it sits beside, not into `vngen/build/`.
- **No new `AssetStore` API.** `asset.upload` reads the file and calls the existing `write(bytes, ext,
meta)`. `sourceTask` is required, and an upload has no task — so it is synthesized as
  `hashParts('upload', filename, bytesHash)`, exactly the shape a concept already uses ("its
  `sourceTask` is a hash of the request, not a node in the graph").
- **Acceptance does not apply.** The author chose the file; there is no generation to approve. The
  asset editor hides the Approve strip the way it already does for a concept.
- **Validation at ingest**: it must decode as an image, and it must not carry the
  `vn-mock-placeholder` `tEXt` chunk — the Gemini backend refuses such bytes as references
  (`gemini.ts:57-71`), and failing at upload with a clear sentence beats failing mid-run.
- **`Character.referenceImages` is deleted**: the field, its front-matter round-trip
  (`serialize.ts:68,259,293`), and the agent's ability to set it (`tools.ts:372`). A character-level
  chunk ref supersedes it and is strictly more expressive — any rung rather than characters only, and
  content-addressed rather than a path that can move. Since the field was never read by anything, the
  migration is a **diagnostic, not a converter**: a project that set it gets a warning naming the
  paths and pointing at `asset.upload`. Writing a converter would mean ingesting arbitrary paths at
  load time, which is a worse trade than one warning on a field nobody could have seen an effect from.

## 16. Part II commands

Extending the `prompt.*` namespace, plus two on `asset.*`:

| id                 | props                                                     | undoable | notes                                                     |
| ------------------ | --------------------------------------------------------- | -------- | --------------------------------------------------------- |
| `prompt.addRef`    | `hash`, `chunk`, `ref` (a hash or a binding address)       | yes      | `check` runs the cycle test and names the path on refusal |
| `prompt.dropRef`   | `hash`, `chunk`, `ref`                                     | yes      | —                                                          |
| `prompt.repin`     | `hash`, `chunk`, `ref`, `regenerate: boolean(default true)` | yes      | `false` is re-approve; goes through the §13 guard          |
| `asset.upload`     | `file`, `title`                                            | yes      | ingest; `confirm: true` — it writes bytes into the repo    |
| `asset.suspended`  | —                                                          | no       | the enumerable listing, in dependency order                |

`prompt.repin` carrying a `regenerate` flag rather than being two commands keeps "the pin moved" as
one act in the undo history; which of the two outcomes it produced is in the record's props.

---

## 17. Staging

| #   | Content                                                                                                                                                                                                                                                                     | Hash invariant                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 0   | `packages/pipeline/src/tests/prompthash.test.ts` — plan the existing fixture and assert the sorted task-hash list equals a checked-in literal. **Written and green against current `main`**, so every later stage is measured against a value that predates the feature.        | establishes the baseline                |
| 1   | `@vn/types`: `PromptChunk`, `ChunkOrigin`, `PromptOverride` + zod; entity fields. No behavior.                                                                                                                                                                                | frozen                                  |
| 2   | `chunks.ts`; refactor `prompts.ts` so each builder gains a `*Chunks` sibling and the string function becomes a one-line wrapper (**unchanged signatures — zero call-site churn** in `planner.ts:259,269,297,339`, `pipeline/src/prompts.ts`, `assetprompt.ts`)                | **frozen — stage 0 must pass untouched** |
| 3   | `model/entities.ts`, `model/serialize.ts`, `store/shots.ts`. Overrides parse and round-trip; nothing reads them.                                                                                                                                                              | frozen                                  |
| 4   | `resolve.ts`; builders accept the override; `planner.ts` + `assetprompt.ts` pass it                                                                                                                                                                                          | moves only where an override is authored |
| 5   | Pure desktop rules: `shared/promptops.ts`, `renderer/rules/promptview.ts`, `promptReorder`. Node suites, nothing wired.                                                                                                                                                       | frozen                                  |
| 6   | Session (`promptView`, `overridePlan`, six preview/act pairs) + `commands/prompt.ts`. **Driveable end-to-end from `vn-cdp.mjs` before a pixel exists** — the cheapest place to find storage bugs.                                                                             | frozen                                  |
| 7   | `coverage.ts`, `condense.ts`                                                                                                                                                                                                                                                | frozen (authoring-time only)            |
| 8   | The `project` editor + `project.setArtStyle` + `withArtStyle`                                                                                                                                                                                                                | frozen                                  |
| 9   | The pane: cards, mode strip, held banner, custom box, reorder gesture; `asset.css`                                                                                                                                                                                           | frozen                                  |
| 10  | `scripts/verify-prompt-chunks.mjs`; docs                                                                                                                                                                                                                                    | —                                       |

**Shipped: 0 through 17 — both parts are done.** The stage-0 baseline has stayed green and untouched
through each, and now has two more halves: authoring one override on a shot moves exactly one
`shot_image` hash, and an authored reference appends **after** the derived one rather than
displacing it.

Stage 4 was landed differently from the wording above, and the difference is worth keeping. Rather
than "builders accept the override; `planner.ts` + `assetprompt.ts` pass it", each builder **resolves
its own rung's override** from the entity it already receives — the portrait off `character`, the
sheet off the outfit entry, the plate off the variant entry, the frame off the shot — and takes an
optional trailing `override?` that _stands in for_ the stored one. So no call site changed at all
(`promote.ts`'s `buildLocationPrompt`, which computes a plate's task identity, is automatically
consistent with the planner's), it is structurally impossible for a caller to forget the override,
and §6's preview/act pairs still get their seam.

Stage 7 was taken **before** stage 6, because `PromptView.missing` is the `coverage()` answer and
stage 6 cannot project it otherwise. Stage 6 then registered `promptReorder`, which stage 5 had left
declared and node-tested but unregistered.

Stage 7 landed as two modules rather than one. `coverage.ts` is the heuristic — content words minus
a noise list, a majority of a chunk's own words having to survive — and it is separate from
`condense.ts` because it is what every _other_ surface asks too: a hand-written custom prompt gets
the same check, with no model involved. The noise list carries the builders' scaffolding vocabulary
(`Palette:`, `no text`, `frame`) as well as English function words, so a chunk that says nothing
distinctive is never reported lost. `ArtGenDeps` was deliberately **not** widened to carry a
`TextLLM`: condensing is authoring-time and never runs during planning, and an optional `text` there
would suggest otherwise. The fallback is the P1/P5 posture — any throw, malformed answer or empty
prompt returns `renderPrompt(chunks)`, the exact string chunks mode would have produced.

Stage 6 landed with four differences from §6's wording, three of them naming.

`AssetInfo` gained **`promptView?: PromptView` and nothing else**. §6 asks for `prompt?: PromptView`
plus `held: boolean`, but `AssetInfo.prompt` is already the prompt the _manifest_ recorded — the
historical one `stale` compares against — so the composition needs its own key, and `held` is
already inside `PromptView`. `assetInfo` populates it from the same `promptViewOf(project, hash)`
the `prompt.info` command uses, so the pane still makes one round trip.

The private plan is `promptPlan`, not `overridePlan`, and it splits in two: `promptChunksOf` answers
"which rung, which chunks, what is stored there" and is what both the plan _and_ `promptView` are
built on, so a preview and a projection cannot disagree about which rung owns a picture. The
pure rules moved to `apps/desktop/src/main/promptedit.ts` (`applyPromptEdit`), node-tested without a
project on disk — the same shape `lineops` has in `@vn/scriptedit`.

`wardrobeEntries`/`variantEntries` were exported from `@vn/model`, because `CharacterEdit.outfits`
and `LocationEdit.variants` **replace the whole collection**: a hand-rebuilt entry drops its
siblings' keys. `art.setNotes` was already doing exactly that and would have erased a
`prompt_override` sitting beside a note — a latent bug this stage fixed rather than reproduced.

Condensing under `--mock` uses a canned `textResponses` answer that is the **identity**
condensation, because the mock backend echoes its prompt and no schema accepts that: without it
every mock condensation would take `condensePrompt`'s deterministic fallback and the real
structured path would never be exercised. A genuine `source: 'fallback'` therefore means no model
answered, and the session refuses to write rather than storing a condensation nobody made.

Stage 8 landed with one addition §9 does not name: a `project.info` command. The pane needs the
config to draw, and every other editor reads through a non-mutating command (`asset.info`,
`doc.read`) rather than a bespoke IPC channel — a twelfth channel for the twelfth editor would have
been the first surface in the app reaching around the registry. It returns a `ProjectView`
carrying the title, the entry scene, the art style, the model ids, the image params, and the count
of image tasks. Deliberately **not** the `keys` block: those are env-var *names* and safe to print,
but a settings pane listing them is one screenshot away from looking like it lists their values.

Stage 9 landed one thing §8 does not name: `interaction.targets` gained an `asset` prop. A
`prompt.*` gesture is judged against one asset's composition, and the command had no way to say
which asset — so an agent asking what a reorder would do had to be given the same addressing the
pane uses. It routes to `session.promptView(asset)`, the same projection `prompt.info` answers with.

Stage 10's live script answered §18's "first thing to check" in the affirmative: the editors'
shadow roots are **open**, so no `window.__vnPrompt()` seam was shipped in app code. The probe is
installed by the verify script itself, which keeps a debug affordance out of the product. Two other
facts shaped it. `window.vn.exec` goes preload → main, so `onInvalidate` never fires for a command
driven from CDP and the script re-reads the pane by retoggling the subject — through a *different*
asset, since `applyView` ignores an empty one. And every read after a command polls with a deadline
rather than sleeping: the surface settles a beat behind the store.

Two of §18's ten steps assert something narrower than their wording, and deliberately. Under
`--mock` the canned condensation is the **identity** condensation, so step 6 cannot show the text
changing — it checks instead that a model answered (`agent.modelId` is recorded; the session
refuses to store a deterministic fallback) and that nothing is missing. Step 8's "the hand-written
sentence was discarded" is wrong about the shipped behaviour as well as unobservable under `--mock`:
`prompt.condense(force=true)` **keeps** the custom text while switching the mode to `agent`, which
is the reconciliation the flag is named for. The step asserts that. Both wordings need a real key to
verify further.

§18's `pipeline.test.ts` extension landed as one test rather than two: the mirror claim (no override
adds not one character) sits beside the art-notes one, and the positive case lives in
`prompthash.test.ts` instead, where a real fixture run makes "exactly these hashes moved" a
statement about a project rather than about four builder calls.

`withArtStyle` is not quite `withStartScene`. An art style is prose and may already be written as a
block scalar, so the entry it replaces is the header line **plus** the indented lines under it — and
a blank line only belongs to the entry if indented text follows it, otherwise it is the author's
spacing before the next key and swallowing it would reflow their file. Verified live: setting the
style through the pane left the flow-style `vision: [...]` list and the quoted `'16:9'` exactly as
the author wrote them, and undo restored the file byte-for-byte.

Two deliberate deviations, both in stage 1, both because §2's reasoned table contradicts §2's file
checklist: `prompt_override` was **not** added to `locationFrontMatter`, and `promptOverride?` was
**not** added to the `Location` interface. The table is right — every location prompt is per-variant,
so a location-level override would be read by nothing. A location's overrides live on its variants.

One rule stage 3 had to invent, since §2 does not state it: **`mode` alone is not an override.**
All three modes fall back to the derived chunks when the shape they name is empty, so
`promptOverrideIsEmpty` (in `@vn/types`) is what every writer clears the key by — otherwise a sheet
that was ever edited grows an inert `prompt_override:` and a shots file stops rewriting
byte-identically. It is also how an override is *cleared* through `applyCharacterEdit`, since
`undefined` already means "the edit does not name this field".

Notes from Part II as shipped. Stage 11 landed `ChunkRef` as **one** interface with an
optional `from`, not the two-member presence-discriminated union §12 sketches: every reader asks
"is this linked" exactly once, and a union buys a narrowing nobody used. Stage 14 turned up a
latent hazard rather than a deviation — the `location_ref` task identity was spelled in three
places (P2's plate loop, the shot loop's plate hash, `promoteConcept`) each with `refs: []`, which
was harmless until a plate could carry an authored reference and then would have stranded shots on
a hash nothing planned; it is now `locationTask` in `@vn/artgen`, and the three sites agree by
construction. Stage 15's `resolveBinding` needed a tie-break §12 does not state: `manifest.json`
is written **hash-sorted**, so "the newest candidate" cannot be read off list order. A single
`accepted` candidate wins; otherwise the slot answers only when exactly one asset serves it;
otherwise `undefined` — and `refDrift` reads `undefined` as *make no claim*, so an ambiguous slot
never flags every reference under it as drifted. Stage 16's re-approve needed one decision §13 leaves
open: what the newly-keyed task's `TaskInputs` are. It does **not** re-derive them — that would mean
a second copy of the planner on the desktop side — but takes the previous node's inputs and swaps the
old pin for the new one *in place*. A repin touches only the authored tail of `refs`, so the result
is provably the hash the planner will compute; and if the derived half moved as well, the adopted
node is merely an orphan and the picture re-renders, which is the fail-safe direction. The adoption
is also **decided before anything is written** (`adoptionOf`, then the override write, then
`adopt`), so a refusal leaves the pin where it was rather than a moved pin with no output.

Stage 17 landed the upload ingest in **`@vn/artgen`**, not `@vn/store` as §15 and §18 both name it
(`packages/artgen/src/upload.ts`, tested at `packages/artgen/src/tests/upload.test.ts`). The reason
is the layering rule: refusing mock-marked bytes means calling `isPlaceholderImage`, which lives in
`@vn/providers`, and `@vn/store` may not import `@vn/providers`. `@vn/artgen` may import both, and
already holds the other write that adopts bytes the planner never asked for (`generateConcept`), so
the ingest sits beside it. Nothing about the storage moved: it still writes the **base** root with a
synthesized `sourceTask`.

`prompt.addRef` needed an addressing §12 does not state. A reference is added by naming either an
asset hash (a prefix suffices, the way an author reads one off the screen) or a **slot** — and
`slotKey(binding)` doubles as the address an author types, `plate:cafe/night` or
`shot:s1/s1-shot-2`, with `parseSlot` its inverse and a round-trip test pinning the two together.
An address that parses but names an empty slot and one that parses as nothing at all are separate
refusals, the second naming the shapes it accepts.

The `reference` kind needed three refusals §15 leaves implicit, all of them the deliberate mirror of
the `concept` ones — a concept has no downstream, an upload has no upstream. `asset.accept` refuses
by name (nothing generated it, so there is no work to bless) and points at `prompt.addRef`;
`asset.regenerate` refuses because an upload's `sourceTask` is a hash of the request that brought
the bytes in and no node ever answered to it; and the pane draws an `uploaded` label where the
Approve/Regenerate strip would be. `assetLabel` grew a matching case: an upload's name is the one
its author typed, since it is bound to nothing by construction and a binding is never what names it.

§18's Part II unit list asks `prompthash.test.ts` to prove authored refs append after derived ones;
that landed in **stage 14**, where the ordering was introduced, rather than at the end.

**Part II** — each stage below is landable on top of a shipped Part I:

| #   | Content                                                                                                                                                                            | Hash invariant                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 11  | `@vn/types`: `ChunkRef`, `RefBinding`, `AssetKind: 'reference'`; `refs` on the override + zod. Delete `Character.referenceImages` and its serializer/tool sites; add the diagnostic. | frozen (nothing reads `refs` yet)         |
| 12  | `resolveBinding` in `@vn/artgen` + `refDrift`; unit-tested against a fixture project. Nothing calls it.                                                                             | frozen                                    |
| 13  | `refCycle(project, from, candidate)` — the binding-level closure and the named path. Pure, node-tested, still uncalled.                                                             | frozen                                    |
| 14  | Authored refs appended to `TaskInputs.refs` in `planner.ts` (derived-first ordering). **Stage-0 baseline must still pass**, and a fixture authoring one ref moves exactly its task.  | moves only where a ref is authored        |
| 15  | `suspendedOf` — the memoized transitive walk with the visited guard — plus the `AssetInfo` field, `asset.suspended`, and the `accept`/`approve` refusals.                            | frozen                                    |
| 16  | The standalone adopt guard; `promoteConcept` refactored onto it; `prompt.repin(regenerate=false)`.                                                                                  | frozen (adopts existing bytes)            |
| 17  | `asset.upload` (ingest + validation); `prompt.addRef`/`dropRef` with the cycle check in `stack.check`; the reference strip on the chunk card; docs.                                  | moves only where a ref is authored        |

---

## 18. Verification

**Unit (`pnpm test`), each in a `tests/` sibling:**

- `packages/pipeline/src/tests/prompthash.test.ts` — the stage-0 baseline, unchanged through stage 9.
- `packages/artgen/src/tests/prompts.test.ts` — the five golden strings copied verbatim from
  `pipeline.test.ts:34-60`, plus, per builder, `renderPrompt(buildXChunks(...)) === buildXPrompt(...)`
  with the legacy collapse spelled out literally in the test. Byte-identity proved in code, not prose.
  Includes the palette leading-space case specifically.
- `packages/artgen/src/tests/chunks.test.ts` — all four ops; `append` after `replace`; `order` with
  unknown, missing and newly-added keys (a new builder chunk must never vanish); `custom` beats
  `agent` beats derived; **the hold**: a fingerprint mismatch yields `text === agent.text` _and_
  `stale === true` — asserting the rendered text is unchanged is the hash-stability half.
  `chunkFingerprint` is order- and text-sensitive, and mute/unmute round-trips.
- `packages/artgen/src/tests/condense.test.ts` — stub `TextLLM`; a throw falls back to
  `renderPrompt` exactly; a model claiming full coverage while omitting a chunk is still reported.
- `packages/model/src/tests/serialize.test.ts` — a legacy string outfit and a bare-id variant survive
  byte-identically; an outfit carrying only `prompt_override` escalates to long form; a cleared
  override writes **no key**.
- `packages/store/src/tests/shots.test.ts` — round-trip, and a shots file with no override rewrites
  byte-identically (`writeShots` returns `false`, which makes this self-testing).
- `apps/desktop/src/shared/tests/promptops.test.ts` and
  `apps/desktop/renderer/rules/tests/promptview.test.ts`.
- `packages/pipeline/src/tests/pipeline.test.ts` — extend the art-notes block at lines 34-60 with the
  mirror claim (no override adds not one character), plus the positive case: authoring one override
  moves exactly the expected hashes and no others, diffed against the stage-0 list.

**Gates:** `pnpm check` (both passes, including `pnpm check:renderer`), `pnpm test`, `pnpm lint`.

**Live, over CDP** — `pnpm build:desktop && pnpm vndesktop --mock`, then a new read-only
`scripts/verify-prompt-chunks.mjs`. Extract `vn-cdp.mjs`'s `connect`/`pageTarget`/`evaluate` into
`scripts/cdp.mjs` and import from both rather than copying. Steps, each printing PASS/FAIL:

1. Open a mock project; `view.open(editor=asset subject=<a shot_image hash>)`.
2. Snapshot the chunk list — order matches `prompt.info`, every card has a tag and a voice class,
   scaffolding cards carry no `⇱`.
3. `prompt.setChunk(op=mute chunk=palette)` → card is `.muted` and the effective block no longer
   contains the palette sentence.
4. Replace a chunk, then synthesise Ctrl+S into the box → the palette did **not** open (the
   `stopPropagation` regression this pane will actually hit).
5. `Alt+↓` on a focused card → DOM order changed _and_ `prompt.info` agrees. Then a pointer drag →
   an insertion rule appears, the footer shows the verdict note, and **no card moved** before
   pointerup.
6. `prompt.condense` → `mode === 'agent'`, `missing` empty, effective block changed.
7. `art.setNotes` on a rung this asset reaches → `held === true`, the banner is on screen, and
   `asset.info.derived` is unchanged (nothing re-rendered).
8. `prompt.setCustom`, then `prompt.condense` without `force` → refusal naming `force=true`; with
   `force` → the custom text is still represented.
9. `⇱` on the style chunk → a pane with area `project` exists and is not the asset pane.
10. `--undo` back to clean; `prompt.info` returns to `mode: 'chunks'`.

Step 6 needs one enabling change: `buildProviders` calls `createMockProviders({refLoader})` with no
`textResponses` (`session.ts:350-361`), and the default mock echoes the prompt, which no schema
accepts — so condensing under `--mock` always takes the deterministic fallback. Seed a canned
condensation so the real path is exercised.

**First thing to check before writing the script:** whether `container.shadow` is an _open_ shadow
root. If open, the script reads `.as-chunk` nodes directly; if closed, the pane exposes a
`window.__vnPrompt()` plain-data projection guarded like `window.__vnDebug`. Either way it must be
plain data — `--raw` crosses the wire with `returnByValue` and live objects do not survive it.

### Part II

**Unit:**

- `packages/artgen/src/tests/refs.test.ts` — `resolveBinding` for each of the five binding kinds and
  for a slot with nothing in it; `refDrift` false for an upload (no `from`, so it cannot drift), true
  when the slot moved, false when it did not.
- `packages/artgen/src/tests/refcycle.test.ts` — the direct case (a portrait referencing its own
  sheet), a three-hop case, a diamond (shared upstream, **not** a cycle — the test that stops the
  check being over-eager), and the named path's exact wording.
- `packages/artgen/src/tests/suspend.test.ts` — transitivity across two hops; a cycle already on disk
  is _reported_ rather than hanging, which is what the visited guard is for; repinning clears it;
  muting the chunk that carried the ref clears it too.
- `packages/pipeline/src/tests/prompthash.test.ts` — still the stage-0 literal, now also proving that
  authored refs append **after** derived ones (author a ref on a shot whose plate ref already exists
  and assert the derived ref is still at index 0).
- `packages/artgen/src/tests/upload.test.ts` (see the note above — not `@vn/store`, which may not
  import `@vn/providers`) — ingest writes to the **base** root, `sourceTask` is the synthesized hash,
  re-uploading identical bytes is idempotent, and mock-marked bytes are refused.
- `packages/artgen/src/tests/adopt.test.ts` — the standalone guard returns a `done` record whose task
  identity is computed from the state just written, and a refusal when the asset is not actually the
  output of the slot it claims. `promoteConcept`'s existing tests must pass unchanged after the
  refactor — that is the proof the extraction was faithful.

**Live, over CDP** — extending `verify-prompt-chunks.mjs`:

11. `asset.upload` a small PNG → it appears in the store under `assets/`, and `asset.info` shows no
    Approve strip.
12. `prompt.addRef` that upload onto a chunk → the card shows the thumbnail; `prompt.info` lists it.
13. `prompt.addRef` a linked plate onto a shot's location chunk, then `art.setNotes` on that location
    and run → the plate's hash moves, and `asset.suspended` now names the shot with the reason.
14. `asset.accept` on it → refused, naming the suspension.
15. `prompt.repin(regenerate=false)` → suspension clears, `asset.info.hash` is **unchanged** (the
    bytes were adopted, not regenerated), and `vngen status` plans nothing.
16. `prompt.addRef` a reference that would close a cycle → `stack.check` refuses and the sentence
    contains the full path.
17. `--undo` back to clean.

---

## 19. Docs, and the invariant this changes

- This file, kept up to date as the work proceeds, and listed in [`docs/index.md`](../index.md).
- [`docs/pipeline-contracts.md`](../../pipeline-contracts.md),
  [`docs/command-system.md`](../archive/command-system.md), [`docs/desktop-app.md`](../../desktop-app.md) — the
  `prompt.*` namespace, the twelfth editor, and the override storage table.
- **CLAUDE.md's core-ideas list currently states, twice, that a prompt is derived on every planning
  pass "so there is nothing there to edit."** That invariant is what this plan revises, and the
  replacement bullet has to say the new one precisely: _the builders stay authoritative and their
  clauses are now addressable; an override is authored input at the rung that names the picture; a
  project authoring none produces byte-identical prompts; and an agent-condensed prompt is held
  rather than re-rendered when its chunks move, so nothing drifts silently._
- **A second CLAUDE.md core idea moves in Part II**: the asset-store bullet says provenance travels
  with the bytes, but nothing says the reference graph is a graph. The new bullet: _a reference pins a
  hash and remembers the slot it came from, so an upstream change suspends rather than silently
  re-renders; suspension is derived by walking that graph on read, never stored; and the graph is kept
  acyclic at write time over bindings, because a cycle in it starves the scheduler in silence._
- [`docs/asset-stores.md`](../../asset-stores.md) — the `reference` kind, its routing to the base root,
  and its synthesized `sourceTask`.
- `todos.md` — **"the asset editor should have an option to upload a custom asset"** is completed by
  §15 and gets its checkbox checked. The cross-reference-widget item is adjacent but not completed:
  that widget wants assets referencing a _wiki page_, which this plan does not build. The right-click
  items stay open.

## Open, and accepted knowingly

- **One override covers all four angles of a model sheet** (§2). Surfaced on the card rather than
  fixed, because fixing it means a per-task override home that breaks the one-rung rule for one kind.
- **Reordering invalidates an agent prompt** (§1). Correct — the agent chose that order — but it
  means one drag puts the prompt into "needs the agent" state, so the gesture warns before the drop.
- **`prompt.info(hash)` cannot address a rung with no asset yet.** Every entry point has an asset in
  hand, so the pane is fine; an agent wanting the prompt for a portrait that does not exist has no
  way to ask. Add an `owner` prop later if it matters, rather than two addressings now.

### Part II

- **Batched re-approve is deferred to its own plan**, at the user's direction: the right behaviour for
  clearing a whole suspended subtree at once needs more than one version to pin down. §13's standalone
  guard exists so that plan is a loop and a transaction boundary, not a second implementation of the
  don't-forge-work property.
- **`deps` and `refs` still disagree** (§11) and this plan does not reconcile them. It adds the
  correctness the ref graph was missing (the cycle check, the walk) without touching the scheduler's
  edge set, because deriving `deps` from `refs` would change what is ready when and is a separate
  risk. The defensive planner assertion is the seam where that would land.
- **Suspension is derived on every read**, memoized per project load. If the walk ever costs enough to
  notice, the fix is a reverse index built at load — not a stored flag, which is the thing §13 exists
  to avoid.
- **Migrating `Character.referenceImages` is a warning, not a converter** (§15). Since nothing ever
  read the field, no project can have observed an effect from it; ingesting arbitrary author paths at
  load time to preserve a value that never did anything is the worse trade.
- **An upload cannot drift and therefore cannot be improved in place.** Replacing one means a new
  upload and a repin. Correct — content-addressed bytes are never overwritten — but it is a papercut
  worth a "replace" button on the card that does both in one act, later.
