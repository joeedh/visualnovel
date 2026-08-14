# Entity discovery by meta tag

Status: **shipped** — see [As shipped](#as-shipped). Item 2 of
[`refactorTaskList.md`](refactorTaskList.md); the foundation
move of the [migration report](../research/codebase-migration-for-new-requirements.md#1-entity-discovery-by-meta-tag).
The wiki/bible plan, the backlink index and the outfit diagnostics all sit on the shapes this
plan introduces.

<!-- toc -->

<!-- tocstop -->

## Why

[`../designRequirementsEtc.md`](../designRequirementsEtc.md) says character and set-location
files are **story bible files identified via a meta tag** — discovery by content, not by
location. Today discovery is path convention and nothing else: an author who writes a
character sheet anywhere but `characters/<id>/character.md` has written a file nothing reads.

The file *format* already fits: characters and locations are markdown with zod-validated
YAML front-matter, and the round-trip serializers (`characterToDoc`/`applyCharacterEdit` and
the location pair, `packages/model/src/serialize.ts`) survive unchanged. What changes is how
the reader finds the files — and, structurally, that the rest of the system stops being
allowed to *guess* where an entity lives.

## What is wrong today

**Discovery is hard-coded paths.** `ProjectPaths.characterFile(id)` is
`characters/<id>/character.md` (`packages/store/src/paths.ts:18`); `loadInputs` walks
`charactersDir` by subdirectory name and `locationsDir` by `.md` listing
(`packages/store/src/worktree.ts:47-54`).

**Loaded docs carry no source path.** `LoadedInputs.characterDocs` and `.locationDocs` are
bare `FrontMatterDoc[]` (`packages/parse/src/inputs.ts:29-30`) — only scenes get the
`SceneChunkDoc` shape (`id` + absolute `file` + `doc` + `text`). Every consumer that needs
the path therefore re-derives it from the id:

- `packages/authoring/src/workspace.ts:103,109` — the index's `file` entries are recomputed,
  not read from the load.
- `packages/authoring/src/workspace.ts:148,155` — `characterDoc`/`locationDoc` re-derive the
  path they read.
- `packages/authoring/src/tools.ts:343,376,393,411` — the create/edit tools re-derive their
  write targets.
- `packages/store/src/worktree.ts:133` — `setCharacterApproval` re-derives the file it
  patches.

Under path convention that re-derivation is merely fragile; under tag discovery it is wrong —
the path is whatever file carried the tag.

**Identity is already two-sourced, and the mismatch is silent.** `loadInputs` finds a
character by its *directory name* but `characterFromDoc` takes the id from *front-matter*
(`characterFrontMatter.id`, `packages/types/src/schemas.ts:12`), and nothing compares them.
`characters/ada/character.md` containing `id: ren` builds character `ren` — while every path
helper above then points at `characters/ren/character.md`, which does not exist. The
workspace index reports a file that isn't there and an edit would create a second copy. This
latent bug is fixed structurally by carrying the real path, and made visible by a diagnostic.

## The design

**The tag.** A front-matter key `type:` with values `character` | `location`, the key and
values named once in `@vn/types` (a `const` beside the schemas, imported everywhere — never a
string literal at a call site). Files in the conventional directories carry the tag
implicitly from their location; an explicit tag there must agree (mismatch is an error
diagnostic). The scene chunk schema is untouched — scenes stay `scene: <id>`, `.strict()`,
identity-only.

**The discovery surface.** Three places and no more: `characters/` (as today), `locations/`
(as today), and a walk of `wiki/**/*.md` reading front-matter and keeping only files whose
`type:` is an entity tag. Untagged wiki files are *not inputs* — they are the bible plan's
business, and `loadInputs` ignores them. No whole-project scan: discovery everywhere would
make every stray markdown file a potential entity, and the cost of the walk would land on
every load.

**Identity.** `id:` in front-matter remains the authority it already is — with the agreement
rule scenes already have, extended: the id must match the *filename stem* for a tagged wiki
file (`wiki/cast/ada.md` ⇒ `id: ada`) and the *parent directory name* for a conventional
character (`characters/ada/character.md` ⇒ `id: ada`); locations keep filename stem.
Mismatch is an error diagnostic naming both, and the entity is not built from it — reporting
rather than picking, exactly as `@vn/model` treats a scene front-matter mismatch.

**Duplicates.** Two files claiming the same `(type, id)`: the conventional location wins over
wiki deterministically, and a warning diagnostic names both files. Two wiki files tied:
lexicographically-first path wins, same warning. Never silent, never a guess.

**The doc shape.** A new `EntityDoc` in `@vn/parse` mirroring `SceneChunkDoc`: absolute
`file`, parsed `doc`, raw `text` (so a future front-matter patcher can splice byte-exactly,
as the prose patchers do). `LoadedInputs.characterDocs`/`.locationDocs` become `EntityDoc[]`.
This is the breaking shape change, and it is the point: after it, *no consumer can re-derive
a path*, because the path it must use is in hand.

## Steps

### 1. `@vn/types`: the tag

Add the `type` key to `characterFrontMatter` and `locationFrontMatter` (optional; values
constrained to the owning tag), export the key/value constants, and extend the schema tests.
No behavior change anywhere yet.

### 2. `@vn/parse`: `EntityDoc`

Introduce `EntityDoc`, switch `LoadedInputs` to it, and follow the compiler: `buildModel`
reads `doc.doc` where it read `doc` (`packages/model/src/build.ts:183,201`), testkit's
factories adjust, everything else that merely forwarded the arrays is mechanical. While
there, add the id-agreement diagnostic for conventional files — this is where the latent
mismatch bug becomes visible.

### 3. `@vn/store`: the wiki walk and the merged discovery

`loadInputs` gains the `wiki/**` walk (front-matter only, tag filter, `EntityDoc` out),
merges the three sources with the duplicate rule above, and emits the new diagnostics
(`entity_id_mismatch`, `duplicate_entity`, `entity_tag_conflict` — final codes at
implementation). `ProjectPaths.characterFile` stays, but its doc comment is rewritten to say
what it now is: the *conventional creation target*, never a lookup for an existing entity.

### 4. Retarget every re-derivation site

- `workspace.ts` index entries: `file` comes from the loaded `EntityDoc`, joined against the
  model like `chunkFiles` already does for scenes.
- `workspace.ts` `characterDoc`/`locationDoc`: look up the loaded doc (one `load()`, same
  contract as `sceneEditInput` — decide and patch against one read).
- `tools.ts` edit tools: write to the doc's carried `file`. Create tools keep the
  conventional target — creating *into the wiki* is the bible/template plan's work, not this
  one's.
- `setCharacterApproval`: takes the resolved file (or the loaded inputs) from its callers
  (`vngen approve`, testkit's `approveAll`) instead of re-deriving. Signature change,
  both callers in-repo.

### 5. `@vn/testkit` + tests

A `makeProject` option (or script fixture) placing one character in `wiki/` by tag; tests
assert: the model is identical to the conventional layout, the index reports the wiki path,
`edit_character` patches the wiki file, approval writes to it, and each new diagnostic fires
on a project constructed to deserve it. The mismatch fixture (`characters/ada/` with
`id: ren`) pins the formerly-silent bug.

### 6. Docs

`CLAUDE.md`'s `@vn/store` row (discovery is tagged, three-surface), `docs/vnauthor.md` if
tool descriptions change, this plan's As-shipped section, the row in [`index.md`](index.md),
and the item-2 row in [`refactorTaskList.md`](refactorTaskList.md).

## Decisions settled here (refining the report's leanings)

The report leaned "id from filename, same rule as scenes." Refined on contact with the code:
**`id:` stays in front-matter** — it is already the authority (`characterFromDoc` reads it
today) and a wiki file has no directory to carry the id — **and the filename must agree**,
enforced by diagnostic. That keeps one identity rule (the file's name and its stated identity
may not disagree) without a schema break.

Not in scope, deliberately: bible retrieval (`@vn/bible`), entity templates, creating
entities into `wiki/`, removing the conventional directories, and any UX. Existing projects
load byte-identically save for new diagnostics they may have earned.

## Acceptance

`pnpm check`, `pnpm test`, `pnpm lint` green; the testkit parity fixture passes; a
conventional-only project (every example in-repo) produces an unchanged model and no new
diagnostics.

## As shipped

Built as planned, in the six steps above. What the code says that the plan left open:

- **Diagnostic codes**, all carried in `LoadedInputs.diagnostics` / `model.diagnostics`, never
  thrown: `entity_id_mismatch` (error, from `buildModel`), `duplicate_entity` (warning, names
  both files and which one is used), `entity_tag_conflict` (error, a conventional sheet
  declaring the other kind), and one the plan did not anticipate, `entity_file` (unparseable
  front-matter).
- **`entity_file` has two severities**, keyed on the surface: **error** under `characters/` or
  `locations/`, where the file is definitely meant to be an entity, and **warning** under
  `wiki/`, where a file with no readable front-matter was never known to be one. The wiki walk
  is what forced the rule to exist at all â€” before it, `loadInputs` simply threw.
- **The id-agreement check lives in `buildModel`, not in `characterFromDoc`.** The pure
  `*FromDoc` converters take a `FrontMatterDoc` and are re-used by `@vn/model`'s round-trip
  serializers, which have no file in hand; `build.ts`'s `idAgrees` runs where the `EntityDoc`
  is.
- **`entityFile(docs, id)`** (exported from `@vn/store`) is the sanctioned way to answer "where
  does this entity live". `vngen approve`, the desktop session, and testkit's `approveAll` all
  go through it into the new `setCharacterApproval(file, hash)`.
- **`CharacterEntry.file` / `LocationEntry.file` are optional** in the `vnauthor` index, mirroring
  `SceneEntry.file`. A location mined from a heading has no sheet at all; falling back to the
  conventional path would have reported a file that does not exist â€” the very bug this plan
  removes.
- **Fixtures place a sheet by tag** with `makeProject({ characters: [{ id, wiki: 'cast/aiko' }] })`,
  which writes `wiki/cast/aiko.md` carrying `type: character`. A conventional fixture sheet is
  left untagged on purpose, so the tag is never the thing being tested twice.

`pnpm check`, `pnpm test` (79 suites, 1018 tests) and `pnpm lint` are green; the whole existing
suite passing unchanged is the evidence for "a conventional-only project produces an unchanged
model and no new diagnostics".
