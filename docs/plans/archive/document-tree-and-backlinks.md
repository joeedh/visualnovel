# Document tree and backlinks

Status: **shipped** (deviations in [As shipped](#as-shipped)); the page is
[`../document-tree.md`](../../document-tree.md). Item 9 of
[`refactorTaskList.md`](../refactorTaskList.md), from §8 of the
[migration report](../../research/codebase-migration-for-new-requirements.md#8-backlink-and-document-tree-index).
Last in the sequence by construction: it reads what items 2, 3, 5, 6 and 7 produce and writes
nothing.

<!-- toc -->

<!-- tocstop -->

## What the requirement asks for

> There is a sidebar with a logical document tree; it will have a mode for a full file tree to
> view every file, but the default local document tree shows the story bible file tree, assets,
> and the script tree (which remember is broken down into scenes which further divide into shots,
> note that shots are not broken into separate files at least not yet). In addition there is a
> tree for characters, clicking on it shows a panel with links to the character's story bible
> file, base assets, and which scenes and shots it appears in.

Two artifacts, then: a **tree** (five branches, plus a full-file-tree mode) and a **backlink
panel** for one entity.

## Where the code already is

**Every edge already exists.** This item introduces no state, no file, and no format — it is a
join over things other items already put on disk:

| Edge | Where it comes from |
| ---- | ------------------- |
| character → its sheet | `EntityDoc.file` off `loadInputs`, wherever the `type:` tag was found (item 2) |
| character → scenes | `Scene.characters` on the built model |
| character → shots | `ShotSubject.characterId` in `work/shots/<sceneId>.json` |
| character → base art | `Asset.satisfies` + `bindsTo(asset, { characterId })` (item 5) |
| location → variants, refs | `Location.variants`, `bindsTo(asset, { locationId })` |
| scene → shots, in order | `readShots(paths, sceneId, lineIds)` (item 7 fixed the order) |
| wiki tree | `Bible.files()` — path, title, tags, headings, bytes |
| assets, split by root | `AssetStore.manifest()` + the `AssetKind` routing rule |

`WorkspaceIndex` (`packages/authoring/src/workspace.ts`) already assembles the first half of that
list and is served over `workspace:index`. What is missing is the shot half, the asset half, and a
shape to put them in.

## The shape of the thing

**A tree of identity, not of content.** A node says what it is, what to call it, and where it
lives. No prose, no excerpt, no image bytes. The five default branches:

```
Story          scene:<id>                 → shot:<sceneId>/<shotId>
Characters     character:<id>
Locations      location:<id>
Wiki           wikidir:<rel>              → wiki:<rel>
Assets         assetkind:<kind>           → asset:<hash>
```

**Backlinks are the same walk, projected per entity.** Clicking `character:aiko` needs its sheet,
its base art, its scenes and its shots — every one of which the tree walk already computed. So the
walk produces both and the shell never round-trips for the panel.

## Decisions

**1. Its own channel, not a wider `WorkspaceIndex`.** `workspace:index` is fetched constantly, is
the agent's `list_workspace`, and is deliberately cheap. The tree costs one `readShots` per scene
and a manifest parse; putting it in the hot index would make every agent turn pay for a sidebar.
`workspace:doctree` is fetched when the sidebar opens and after a write, like `story:graph` is.

**2. It lives in the desktop's main process** — `apps/desktop/src/main/doctree.ts`, pure functions
over an explicit input bag, with a `tests/` sibling per the renderer rule. The migration report
guessed it would sit "wherever `WorkspaceIndex` is assembled today", which is `@vn/authoring`; that
was written before it was clear the walk needs `AssetStore` and the persisted storyboards, neither
of which `Workspace` opens. `session.ts`'s `loadProject` already assembles model + inputs + store +
paths in one call, and exactly one surface wants the result. If the agent ever needs backlinks (see
[Out of scope](#out-of-scope)) the pure half moves to `@vn/authoring` unchanged.

**3. A node carries identity, not a click action.** It would be tidy for each node to ship the
command invocation a click runs, the way an interaction target does. There is no command to ship:
`view.*` switches rooms and modes, and nothing selects a scene or a shot. Inventing a selection
vocabulary here would bind this item to a shell that item 1 is about to replace, so the tree states
`kind`, `key` and `path`, and what a click does stays the shell's business.

**4. Node ids are stable and are the join key.** `kind:key` — `scene:greet`,
`shot:greet/s1`, `character:aiko`, `wiki:history/the-war.md`, `asset:<hash>`. The backlink map is
keyed by the same string, so a panel is a lookup rather than a second convention. Expansion state
persists against these ids, which is why `character:aiko` must not become `characters/aiko` when
the sheet moves.

**5. Paths are workspace-relative with `/` separators** — same rule the generated project map
settled on (item 8), and for the same two reasons: they are shown to a human, and an absolute path
in a serialized shape is unportable.

**6. "Which wiki notes mention Aiko" is a search, not a backlink.** The panel links the
character's *own* sheet when that sheet lives under `wiki/`, because that is a fact the tag index
already knows. Finding every other note that says her name is what `bible.search` does, ranked and
budgeted; precomputing it would be a second, unbudgeted index over the one tree that was
deliberately given a budget. See [`../story-bible.md`](../../story-bible.md).

**7. Assets group by kind, and the tree says which root holds them.** `AssetStore.manifest()`
merges both roots, and the `AssetKind` routing rule is what decides where bytes live, so the
grouping is by kind and each group is labelled base or project. A legacy project whose base art is
still indexed in the project manifest therefore still groups correctly — the label describes what
the asset *is*, which is what a sidebar shows.

**8. Caps, stated.** Big branches (assets, and the file tree) cap their children and end with a
counted node rather than truncating silently — the same rule the generated map follows. A cap is a
number in the shape, not a magic constant in the renderer.

**9. The full file tree is a second, separate walk.** It answers a different question (what is on
disk) and shares nothing with the document tree but its node type. `workspace:filetree`, walked on
demand, `.git` and `node_modules` excluded, capped per decision 8. It does not consult git: a
project that is not a repo still has files, and `.gitignore` semantics are not what "view every
file" asks for.

## Shapes

Sketch, to be pinned in `apps/desktop/src/shared/ipc.ts`:

```ts
type DocNodeKind =
  | 'branch' | 'scene' | 'shot' | 'character' | 'location'
  | 'wikidir' | 'wiki' | 'assetkind' | 'asset' | 'dir' | 'file' | 'more';

interface DocNode {
  id: string;                 // `${kind}:${key}` — stable across reloads (decision 4)
  kind: DocNodeKind;
  label: string;
  path?: string;              // workspace-relative, `/` separators; absent for a pure grouping
  badge?: string;             // 'unreachable', 'draft', 'drifted', 'base' — one word, never a sentence
  children?: DocNode[];
}

interface EntityLinks {
  sheet?: string;             // where the entity was discovered
  wiki?: string;              // that sheet, when it lives under wiki/ (decision 6)
  assets: { hash: string; ext: string; kind: AssetKind; accepted: boolean; base: boolean }[];
  scenes: string[];
  shots: { scene: string; shot: string }[];
}

interface DocTree {
  roots: DocNode[];
  /** Keyed by node id (`character:aiko`), so a panel is a lookup. */
  backlinks: Record<string, EntityLinks>;
}
```

## Steps

### 1. The projection

`apps/desktop/src/main/doctree.ts`: `buildDocTree(input) → DocTree`, pure, taking
`{ root, model, inputs, manifest, shots, bible }` — everything already loaded, nothing read here.
Plus `fileTree(entries) → DocNode[]` over a flat path list, likewise pure, so the walk and the
shaping are testable apart.

### 2. The reads

`session.docTree()`: one `loadProject`, one `openBible().files()`, one `readShots` per scene, then
`buildDocTree`. `session.fileTree()`: the bounded walk from decision 9, then `fileTree`.

### 3. The surfaces

- Channels `workspace:doctree` and `workspace:filetree` in `ipc.ts` + `main/index.ts`.
- Commands `workspace.doctree` and `workspace.filetree` (non-mutating, no props), beside
  `workspace.index` — so the palette and `vn-cdp.mjs` can read the tree the sidebar reads, which
  is how the shape gets debugged before any sidebar exists.

### 4. Tests

- `tests/doctree.test.ts` over literal inputs: node ids are stable and unique; a scene with no
  storyboard has no shot children (not an empty branch); an unreachable scene is badged; a mined
  location appears with no `path`; assets group by kind and the base/project label follows the
  routing rule; a branch over its cap ends in one `more` node whose label counts the remainder.
- Backlinks: a character in two scenes and one shot resolves both, an entity with no art gets an
  empty list rather than a missing key, and a character sheet filed under `wiki/` reports the same
  path as `sheet` and `wiki`.
- A `makeProject` test through `session.docTree()` on a real fully-run fixture: the story branch
  matches the model's scenes, and every `asset:` node's hash is in the manifest.
- `commands.test.ts`: both new ids in the non-mutating list; regenerate `commands.json`.

### 5. Docs

- New `docs/document-tree.md` — the branches, the node-id contract, what is deliberately absent
  (click actions, wiki mention-search), and the caps. Listed in [`../index.md`](../index.md).
- [`../command-system.md`](../archive/command-system.md) — two rows and the counts.
- [`../story-bible.md`](../../story-bible.md) — `files()` gains a third reader; still metadata.
- `CLAUDE.md` — a line under the desktop section pointing at the new page.
- `refactorTaskList.md` / [`index.md`](../index.md) — status.

## As shipped

Five things the code decided that the plan above did not, each recorded rather than quietly
folded into the prose:

1. **A scene whose storyboard will not parse is badged `unreadable`.** `readShots` throws on a
   malformed file — deliberately, so a hand-edit is never silently re-decomposed — and the plan
   never said what the tree does with that. It catches per scene and badges that one node, because
   one broken file must not take the whole sidebar down with it. `unreadable` outranks
   `unreachable`: one is a fact about the story, the other about the disk, and only the disk one
   has somebody to go fix it.
2. **The file tree lists directories before files at every level.** The paths arrive sorted, so
   within each group the order is already alphabetical; interleaving them by raw path put
   `project.yaml` in the middle of the directories, which is not what a file tree looks like.
3. **The walk is bounded twice** — the per-level cap from decision 8, plus a 5000-file ceiling over
   the whole walk. A project holding a copied asset library should slow the sidebar down, not the
   main process.
4. **`LoadedProject` carries the whole `LoadedInputs`**, not just `characterDocs`. The tree needs
   location and scene doc paths off the same load; keeping a second field per doc kind would have
   made `loadProject` re-decide what `loadInputs` already answered.
5. **`commands.test.ts` needed no new list entry.** Step 4 asked for the two ids "in the
   non-mutating list"; there is no such list — the tests pin the `mutating`, `undoable` and `check`
   sets, all of which are exhaustive of mutators, so two non-mutating commands are covered by
   omission. `commands.json` was regenerated (42 → 44).

`isBaseKind` was exported from `@vn/store` rather than restated in the desktop, so the base/project
label and the write routing cannot disagree.

## Out of scope

- **The sidebar itself.** This item ships the shape and the channels; the pane that draws them is
  [`wiki-and-document-tree-editors.md`](wiki-and-document-tree-editors.md), item 12, which has since
  shipped as the `documents` editor. It was
  originally deferred to item 1, which deferred it back here — so it got a row of its own.
- **An agent backlink tool.** `vnauthor` authors *inputs* and stops at them; shots and assets are
  pipeline output, and a tool that reports them would invite the agent to reason about art it
  cannot make. If that changes, decision 2 says what moves.
- **Watching the filesystem.** Both trees are reads, refetched after a write like `story:graph`.
  Live invalidation is the same question commit-on-save already parks.
- **Editing through the tree.** Rename, move and delete are `story.*`/entity commands with their
  own refusals; a drag in a sidebar would dispatch those, not a new write path.
