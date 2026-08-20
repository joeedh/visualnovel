# Right-click menus in the document tree, built from the command catalog

Status: **shipped**

## Context

`todos.md` has a section of three items:

> - right clicking on a location should pop up a menu including an option to create a new reference
>   shot asset. it should open the asset editor automatically.
> - right clicking on the top level wiki tree should include a menu item to create a new wiki page.
> - right clicking on an asset item should pop up a menu including 'regenerate' 'accept' 'reject'
>   etc. it should open the asset editor automatically for that asset.

(The original wiki item also asked for a `refresh` entry on every node's menu. The author has
dropped it — the documents pane already carries a `⟳` on its own bar, and a refresh repeated
inside twelve menus is noise that teaches nothing about the node it hangs off.)

**There is no context menu anywhere in the app today.** Not in the tree, not in the graph canvas,
not in the script column. So this is one piece of shell plumbing plus three tables, and the
plumbing is the part worth getting right — because the alternative, three bespoke `contextmenu`
handlers that call `exec` and hope, reintroduces exactly the thing the command system exists to
prevent: a surface that offers an action the command would refuse.

Every entry these menus want already exists as a command: `art.generate`, `doc.create`,
`asset.regenerate`, `asset.accept`, `gate.approve`, `art.promote`, `prompt.repin`. Each mutating
one already declares its refusal ahead of time through `stack.check`, and `check` already returns
the sentence the command itself would give. A menu built from the catalog and gated on `check` is
therefore not extra work — it is the direct-manipulation half of an invariant already in the
repo: **a mutating command declares its refusal before it runs.**

## Decisions this plan settles

- **One menu builder, three tables.** `apps/desktop/renderer/pathux/contextmenu.ts` wraps path.ux
  (`createMenu(ctx, title, templ)` + `startMenu(menu, x, y)`, both re-exported from `pathux`) and
  takes a list of entries. Which entries a node offers is a pure function in
  `pathux/doctree.ts`'s neighbourhood, testable in node without a DOM.
- **An entry is an invocation, not a callback.** `{ label: string; id: string; props: object;
  after?: 'openAsset' }`. The builder resolves it: `check(id, props)` first, then `exec(id, props)`
  on click. A menu entry that is not a command has no place here — if an action is worth a
  right-click it is worth being in the palette, the catalog and the provenance log.
- **A refused entry is shown, with its reason, not hidden.** path.ux's menu template has no
  per-item disabled state, so a refusal renders as `⃠ Regenerate` and its callback shows the
  command's own sentence in the shell's message line instead of executing. Hiding it would leave
  the author guessing why the option they remember is gone; the refusal sentence is the whole
  value of `check` and it should reach the surface that asked.
- **`undeclared` is not permission.** A command with no `check` renders enabled — the same
  three-state contract `stack.check` already defines — but the builder must not synthesize an
  `accept` for it. Absence of a check is absence of information.
- **Checks are awaited before the menu opens.** `startMenu` is synchronous, so the handler
  gathers `Promise.all(entries.map(check))` first and builds from the answers. Checks are
  read-only previews over state already in memory; if one ever becomes slow enough to notice, the
  fix is that check, not a menu that lies while it loads.
- **"Open the asset editor automatically" is the routing rule, not a hardcoded `view.open`.**
  Both `art.generate` and `asset.upload` already push `view.open … where: 'elsewhere'` from main
  via their `open` prop. Menu entries set that prop and let the command do it, so there is one
  answer to where an asset opens — see
  [`editor-routing-by-relevance.md`](editor-routing-by-relevance.md).
- **A right-click selects first.** The menu acts on the node under the cursor, so the click
  publishes that node's selection before opening — otherwise "Regenerate" and the asset pane
  showing at the time can disagree about which asset is meant.
- **Menus are declared for every node kind, including the ones with nothing to offer.** A kind
  with no entries opens no menu at all (rather than an empty box), and the table says so
  explicitly, so a new node kind is a visible hole rather than silent nothing.

## Stage 1 — the builder

New `apps/desktop/renderer/pathux/contextmenu.ts`:

```ts
export interface MenuEntry {
  label: string;
  /** A command id, or `'-'` for a separator. */
  id: string;
  props?: Record<string, unknown>;
}
export async function showContextMenu(
  ctx: unknown,          // the path.ux context the editor already holds
  x: number, y: number,
  title: string,
  entries: MenuEntry[],
): Promise<void>;
```

- Runs `check` for every non-separator entry through the existing renderer API wrapper
  (`pathux/api.ts`, which already fronts `window.vn.check`).
- Builds a `MenuTemplate` of `[label, callback]` pairs in the array form `header.ts` already uses.
- Accepted entries `exec` and let the effect bus do the rest; refused entries report the reason.
- Any `exec` failure is reported the same way an unhandled palette failure is today — one path,
  not a second error convention.

Tests: the entry-resolution half (`entriesWithVerdicts(entries, verdicts)` → labels and enabled
flags) is pure and lives in `pathux/tests/contextmenu.test.ts`. The `startMenu` call is verified
live over CDP, like every other surface.

## Stage 2 — the tables

In `pathux/doctree.ts` (pure, already has tests):

```ts
export function menuFor(node: DocNode, ctx: { assetKind?: AssetKind }): MenuEntry[];
```

| node kind | entries |
| --- | --- |
| `location` | **New reference shot…** → `art.generate(subject='location:<id>' open=true)`; **Open sheet** → `doc.read`-backed open via the routing rule; **Art notes…** → `art.setNotes(target='location:<id>')` |
| `character` | **New concept image…** → `art.generate(subject='character:<id>' open=true)`; **Open sheet**; **Art notes…** |
| `wikidir` (the top-level wiki node) | **New wiki page…** → `doc.create(kind='note')`; **New character sheet…** / **New location sheet…** → `doc.create(kind='character'|'location')` |
| `asset` | **Regenerate** → `asset.regenerate(hash)`; **Accept** → `asset.accept(hash)`; **Approve…** → `gate.approve(hash)`; **Promote to plate…** → `art.promote(hash)`; separator; **Open in Asset editor** |
| `scene` | **Assign line ids** → `story.assignLineIds`; **Export screenplay** → `story.screenplay` |
| `shot` | **Set coverage…**, **Set outfit…** (both open the palette pre-filled — they need arguments a menu cannot supply) |
| `branch`, `assetkind`, `dir`, `file`, `more` | none |

Three notes on the asset row, because they are where the todo's wording and the code disagree:

- **There is no 'reject'.** The gate has `gate.approve` and `gate.candidates`; the manifest has
  `asset.accept`. Rejecting a candidate is expressed today by approving a different one, and
  inventing a `reject` command as part of a menu plan would be designing the gate through a menu.
  The entry is left out and named here so the omission is deliberate.
- **Accept, approve and promote are all offered and each refuses itself.** `asset.accept` refuses
  a portrait ("that is `gate.approve`") and a concept ("that is `art.promote`"); `art.promote`
  refuses anything that is not a location-bound concept; `gate.approve` refuses the rest. The menu
  shows all three with their refusals rather than trying to guess which one applies — the commands
  already know, and their sentences are better than a menu's guess.
- **An entry needing an argument opens the palette pre-filled** rather than prompting inside the
  menu. `art.promote` needs a variant id, `art.setNotes` needs prose; the palette is where a
  command's arguments are typed and it already renders prop specs.

## Stage 3 — wire it up

`editors/documents.ts`: a `contextmenu` listener on the row surface that

1. `preventDefault()`s (Electron's default menu is already gone —
   [`desktop-shell-fit-and-finish.md`](desktop-shell-fit-and-finish.md)),
2. publishes the row's selection,
3. calls `showContextMenu(ctx, ev.clientX, ev.clientY, row.node.label, menuFor(row.node, …))`.

The listener goes on the surface inside the shadow root, where the rows are, not on the light-DOM
container.

## Stage 4 — the second surface

Same builder, from the asset editor's own header: the pane showing one asset offers the same asset
entries. It is three lines once the table exists, and it is the check that `menuFor` really is
node-shaped rather than tree-shaped.

## Stage 5 — documentation

- `docs/command-system.md`: a short section — the context menu is a third view of the catalog,
  beside the palette and CDP, and it is gated by `check` like the interaction layer is.
- `docs/document-tree.md`: the menus, in the "deliberately absent" section that currently says
  click actions are absent.
- `CLAUDE.md`: one clause on the commands bullet — the palette, the menus, the agent, CDP **and
  the tree's context menus** all reach the same registry.

## Acceptance

- `pnpm check`, `pnpm test`, `pnpm lint` green.
- Right-clicking a location offers **New reference shot…**; accepting it draws a concept bound to
  that location and opens the asset editor in a pane that is not the tree.
- Right-clicking the wiki root offers **New wiki page…**; the created note appears in the tree and
  opens.
- Right-clicking a portrait shows **Accept** struck through with the sentence "approving one also
  writes character.md and approved.png, which is `gate.approve`", and **Approve…** enabled.
- Right-clicking a `branch` grouping opens no menu.
- No menu entry exists that is not a command in the catalog — verifiable by
  `node scripts/vn-cdp.mjs --catalog` and the table above.

## Shipped deviations

- **The builder is two modules, not one.** `pathux` is a vite alias with no jest
  `moduleNameMapper`, so anything importing it cannot be loaded in the node test project. The
  rules — `needsCheck`, `entriesWithVerdicts`, `MenuEntry`, `MENU_SEP` — live in
  `pathux/contextmenu.ts` with no `pathux` import and a `tests/` sibling; `showContextMenu` lives
  in `pathux/showmenu.ts`, which is the only half that touches path.ux. Same split as
  `route.ts`/`open.ts` and `structfields.ts`.
- **`menuFor(node)` takes no second argument.** The plan's `ctx: { assetKind? }` turned out to be
  unnecessary: the asset row offers all four acts and each command refuses itself, so the table
  never needs to know the kind.
- **The wiki entries hang off `branch:wiki`, not only `wikidir`.** The "top level wiki tree" the
  todo names is the branch heading; `wikidir:` nodes are the folders inside it, which a project
  with a flat `wiki/` never has at all. It is the one branch that is a place, so `case 'branch'`
  answers for `wiki` and returns nothing for the other four.
- **`confirm: true` entries open the palette, they do not fire.** `MenuEntry.form` covers both the
  entries needing an argument a menu cannot supply and every confirming command, because the
  palette is where a command says what it is about to do. Such an entry is not checked at all: its
  props are incomplete by design.
- **A right-click selects but does not route.** The plan's step 2 ("publishes the row's selection")
  is what shipped; opening a pane stays the left click's job, so the menu never rearranges the
  screen before the author has chosen anything.
- **`after: 'openAsset'` was not needed.** `art.generate` already carries `open`, and the asset
  row's routing is a plain `view.open` entry, so no post-exec hook exists.

Verified live over CDP against a real project (`examples/mySampleRepo`): the location, scene and
wiki-branch menus draw at the cursor; a concept's menu draws `⃠ Accept` carrying
`asset.accept`'s own sentence and does not execute when clicked; **Open sheet elsewhere** records
`view.open(editor='wiki' where='elsewhere' subject='locations/classroom.md')`; **New wiki page…**
opens the palette on `doc.create` with `kind` pre-filled to `note`; and the asset editor's `⋯`
raises the same five entries from the same table.
