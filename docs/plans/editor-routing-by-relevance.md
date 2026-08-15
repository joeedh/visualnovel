# Clicking a document opens the editor that answers for it

Status: **planned**

## Context

`todos.md`:

> create a system for clicking on document tree items to automatically show the associated editor.
> give each editor class a static method to test if a document reference is valid for it, it should
> return a relevence score (e.g. for wiki pages the wiki editor gives the highest score). all
> instantiated editor tabs should be searched, and the (valid) one with the higher relevence score
> selected. note that visible editors always have higher relevence then inactive ones. if no editor
> is found the largest screen area that's not where the user clicked on should be selected and the
> editor with the highest relevence score created.

Today the routing exists, hardcoded, in one method
(`apps/desktop/renderer/pathux/editors/documents.ts`):

```ts
private pick(row: DocRow): void {
  this.picked = row.node.kind === 'location' ? row.node.id : '';
  const current = this.selection();
  const next = selectionForNode(row.node, current);
  if (next === current) { … toggle or rebuild … return; }
  this.publish(next);
  if (row.node.kind === 'asset') this.openAsset(next.assetHash);
}
```

So an asset opens the `asset` editor `where: 'elsewhere'`, a backlink row opens `wiki` in `here`
or `right` depending on `isShowing(screen, 'wiki')`, and **every other kind changes the selection
and nothing else**. Clicking a scene in the tree updates whatever Script pane happens to be open
— and if none is, the click appears to do nothing at all. That is the complaint.

Two parts of the ask need translating before they can be built.

**"A static method on each editor class" is the wrong home.** Editor classes live in
`apps/desktop/renderer/`; `view.open` is executed in main; and the desktop jest project is
node-only (no jsdom), so a static on a `VnEditor` subclass can be neither read by main nor
unit-tested. The rule splits cleanly in two, and both halves land somewhere that already exists:
the **claim** is declarative data and belongs beside the editor names in
`apps/desktop/src/shared/editors.ts`, the one place the twelve editors are listed; the
**ranking** is a pure function of claims plus pane state and belongs in
`apps/desktop/renderer/pathux/route.ts`, beside `panes.ts` and `doctree.ts`, which are already
pure with tests in `pathux/tests/`.

**"A relevance score" invites drift.** Numeric scores accumulate ad-hoc tie-breakers until nobody
can say why a click landed where it did. Use two named tiers — `primary` and `secondary` — and
one ordering rule, so the answer to "why did this open in Coverage" is a table lookup.

## Decisions already taken (with the user)

- **Clicking a document-tree item shows the editor associated with it.** Selection alone is not
  enough feedback.
- **A visible editor always outranks a hidden one.** The author is looking at the panes that are
  open; a click should land where they are looking.
- **When nothing suitable is open, create one in the largest area that is not the pane that was
  clicked.** Never replace the tree the click came from.

## Decisions this plan settles

- **The claim is declared beside the editor names, as data.** `EDITORS` in
  `apps/desktop/src/shared/editors.ts` is already the single list that main's `view.*` props and
  the renderer's registry are both built from, and the shell already warns at boot when the two
  disagree. A thirteenth editor that forgets to declare a claim is then visibly claim-less in the
  same file that names it, rather than silently unreachable from the tree.
- **A claim is a predicate over the node, not a map from `DocNodeKind`.** `SUBJECT_OF` in
  `view.ts` already carries the warning: pointing `docPath` at a `.png` would have the wiki editor
  `doc.read` a binary. A `file` node is claimed by `wiki` only when its path looks like text, and
  that judgement needs the node, not its kind.
- **Ranking is `(visible, tier)` in that order, taken literally.** Sort the claimants by
  visibility first and tier second. The consequence is real and worth stating: a visible
  *secondary* claimant beats a hidden *primary* one — clicking a scene with Coverage open and
  Script closed lands in Coverage. That is what "visible editors always have higher relevance"
  says, and it is the behaviour that respects where the author is looking. It is one constant
  (`VISIBILITY_FIRST`) and one sort comparator, so reversing it later is a two-line change with a
  test that already enumerates both orders.
- **Selection is published before the view opens, always.** A shot needs two selection fields
  (`sceneId` + `shotId`), so it cannot travel as `view.open`'s single string `subject`.
  `selectionForNode` already computes the whole selection; publishing first and opening second
  works for every kind and keeps `view.open`'s props exactly as they are.
- **The fallback is `where: 'elsewhere'`, which already means what the todo asks for.**
  `paneElsewhere` in `panes.ts` picks the largest-area pane that is not the asking one, and
  `applyView` already falls back to `SPLIT.right` when there is no such pane. Nothing new is
  needed for the "largest screen area that's not where the user clicked" half; the plan must
  simply not reinvent it.
- **A node that claims nothing keeps today's behaviour.** Groupings (`branch`, `assetkind`,
  `wikidir`, `dir`) and `more` toggle expansion. `selectionForNode` already returns `current`
  identically for those, and that identity check stays the branch that decides toggle-vs-route.
- **Routing stays in the renderer; `view.open` is untouched.** Only the mesh knows which panes
  exist. Main already answers `view.*` optimistically and takes a correction back from
  `applyView`; adding a second, main-side notion of pane visibility would give two answers to one
  question.

## Stage 1 — declare the claims

`apps/desktop/src/shared/editors.ts`. Add to each `EDITORS` entry an optional `claims`, and export
the tier type:

```ts
export type ClaimTier = 'primary' | 'secondary';
/** What an editor will show for a clicked document-tree node, and how well. */
export type EditorClaim = (node: { kind: DocNodeKind; path?: string }) => ClaimTier | undefined;
```

The table, stated once:

| node kind | primary | secondary |
| --- | --- | --- |
| `scene` | `script` | `timeline`, `branches` |
| `shot` | `timeline` | `inspector` |
| `character` | `wiki` (its sheet) | `inspector` |
| `location` | `wiki` (its sheet) | `inspector` |
| `wiki` | `wiki` | — |
| `file` | `wiki`, when the path is text (`.md`, `.txt`, `.fountain`, `.yaml`, `.json`) | — |
| `asset` | `asset` | `inspector` |
| `branch`, `assetkind`, `wikidir`, `dir`, `more` | — | — |

`character` and `location` claim `wiki` rather than a bespoke sheet editor because that is where a
sheet is edited today, and entity discovery means a character's sheet may itself live under
`wiki/**`. The `inspector` secondaries are what make the literal visibility rule useful: an author
with the Inspector open gets the click there instead of nowhere.

`DocNodeKind` is imported from `src/shared/ipc.ts`, which `editors.ts` may reach — both are shared
and node-free.

## Stage 2 — the pure rule

New `apps/desktop/renderer/pathux/route.ts`:

```ts
export interface RouteRequest {
  node: DocNode;
  /** The pane the click came from, so the fallback never lands back in it. */
  from: EditorId;
  panes: readonly Pane[];
}
export type Route =
  | { action: 'toggle' }
  | { action: 'select' }                                   // selection only; nothing claims it
  | { action: 'open'; editor: EditorId; where: OpenWhere; subject: string };

export function routeFor(req: RouteRequest): Route;
```

- gather `(editor, tier)` for every editor whose claim answers;
- mark each visible if `paneShowing(panes, editor) !== NO_PANE`;
- sort by `(visible desc, tier desc, EDITORS order)` — the last key is what makes it total and
  therefore testable;
- winner visible → `where: 'here'`, which `applyView` already treats as a focus for an editor
  that is open; winner hidden → `where: 'elsewhere'`;
- `subject` from the same `SUBJECT_OF` mapping `view.ts` uses (`docPath` / `assetHash` / `''`),
  so an editor whose subject is not expressible in one string opens on the published selection.

Tests in `apps/desktop/renderer/pathux/tests/route.test.ts`, a golden table over the twelve
editors × the eleven node kinds × three pane configurations (nothing open, the claimant open, a
secondary open). The two rows that matter most are the ones that pin today's behaviour: an `asset`
node with no asset pane open routes to `asset`/`elsewhere`, and a `wiki` node routes to
`wiki`/`here` when a wiki pane is showing.

## Stage 3 — use it

`editors/documents.ts`:

- `pick(row)` becomes: compute `next = selectionForNode(...)`; if identical, toggle or rebuild as
  now; otherwise `publish(next)`, then `routeFor({node, from: 'documents', panes})` and act on the
  verdict. `openAsset` and the kind test in `pick` are deleted.
- `openDoc(path)` keeps its own entry point (the backlink rows and the New… row call it directly
  with a path rather than a node) but is reimplemented over `routeFor` with a synthetic
  `{kind: 'wiki', path}` node, so there is exactly one place that decides where a document opens.
- The pane list comes from the screen the editor already holds (`this.ctx?.screen`); `panes.ts`'s
  existing collector is the source — `route.ts` must not read the DOM.

## Stage 4 — the second consumer

Nothing else routes today, but the reason to have the function is that the next surface will:
`asset.upload`, `art.generate` and `art.redraw` all push `view.open … where: 'elsewhere'` from
**main**, which cannot see the panes and so always opens a new one even when an Asset pane is
already showing. Leave those as they are in this plan — main's optimistic answer plus `applyView`'s
correction is the existing contract — but note the follow-up: `applyView` could consult `routeFor`
for a `where: 'elsewhere'` effect whose editor is already open, and turn it into a focus. One line,
once the rule exists, and it removes the "why did that open a third Asset pane" complaint.

## Stage 5 — documentation

- `docs/desktop-app.md`: a paragraph under the document tree / shell section stating the rule and
  the claim table, replacing the current description of the two hardcoded cases.
- `docs/document-tree.md`: its "what is deliberately absent" list says click actions are absent.
  That stops being true — rewrite the entry to name `routeFor` and the claim table.
- `CLAUDE.md`: the editors bullet ("A pane shows an editor, and the twelve editors are named in
  one place") gains a clause — that list also says what each editor will show for a clicked
  document, and the routing rule is pure and lives beside the pane arithmetic.

## Acceptance

- `pnpm check`, `pnpm test`, `pnpm lint` green.
- The two behaviours that exist today are unchanged, pinned by the golden table.
- Clicking a scene with no Script pane open opens one in the largest pane that is not the
  documents pane; clicking it again with Script open focuses that pane instead of splitting again.
- Clicking a `wikidir` still only expands it.
- Clicking a `.png` in file-tree mode does not open the wiki editor on binary bytes.
