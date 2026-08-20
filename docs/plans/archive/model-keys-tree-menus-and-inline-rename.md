# Model keys, tree root menus, and inline rename

The current `todos.md` batch, taken together. Seven items, four of which are the document
tree's right-click surface growing up, one a new `keys/` writer, one an inline editor in the
tree, and one a file a fresh repository should have had all along.

<!-- toc -->

- [1. Provide a model key](#1-provide-a-model-key)
- [2. Root items get the menu their branch is about](#2-root-items-get-the-menu-their-branch-is-about)
- [3. A right-click must not move the tree](#3-a-right-click-must-not-move-the-tree)
- [4. `Write the screenplay` becomes `Export Fountain`](#4-write-the-screenplay-becomes-export-fountain)
- [5. Rename a document in place](#5-rename-a-document-in-place)
- [6. A new repository gets a `.gitignore`](#6-a-new-repository-gets-a-gitignore)
- [Order of work](#order-of-work)

<!-- tocstop -->

## 1. Provide a model key

> Add 'provide model key' to the file menu, it should pop up a dialog to provide the model key
> with a dropdown box for the model provider.

A key is the one value in this codebase that must never be logged and never be committed
(`CLAUDE.md` § Conventions), and the app currently has no way to supply one at all — the author
has to know that `resolveKeys` reads `keys/gemini.txt` and `keys/claude.txt`. So this is a
command that writes one of those two files.

**A new prop kind, `secret`.** `directory` is already "a string everywhere that matters, its own
kind so a form knows the OS can fill it in". A key needs the same trick for the opposite reason:
a form should know not to show it, and `CommandRecord.props` — which is appended verbatim to
`vngen/state/commands.jsonl` — must not carry it. `digest` is the nearest existing mechanism and
is the wrong one: it records `<sha256:…+len>`, which is a fingerprint of a live credential and
its exact length. `secret` records the literal `<secret>` and nothing else.

- `packages/commands/src/props.ts` — `'secret'` in `PropKind`, `prop.secret(description)`,
  coerced exactly as a string.
- `packages/commands/src/digest.ts` — a secret prop is replaced by `<secret>` before the record
  is built. Same seam, same call site in `stack.ts`, so there is one projection at record time
  and `run` still receives the real value.
- `packages/commands/src/catalog.ts` — falls through to `{ type: 'string' }`, as `directory`
  does. Nothing to add.
- `apps/desktop/renderer/pathux/commandform.ts` — a secret field draws with its characters
  masked. path.ux's `TextBox` has no password mode, so the form uses a raw `<input type=
  "password">`… **it does not**: see the decision below.

**Decision — the field is not masked.** path.ux has no password widget and the form is built out
of path.ux widgets; a raw DOM input smuggled into one row of an otherwise path.ux form would be
the only such thing in the app, and it would not take the theme. The value is typed once, into a
dialog the author opened deliberately, and is gone the moment it runs. What matters — that it is
never written to the history and never committed — is handled where it can be handled honestly.
The prop's description says so.

**`project.setKey`** in `apps/desktop/src/main/commands/project.ts`:

| | |
| --- | --- |
| props | `provider: oneOf('gemini' \| 'anthropic')`, `key: secret` |
| mutating | yes |
| undoable | **no** — an undo point is a git snapshot, and a snapshot of a key is the thing this is trying to avoid |
| check | says which file it would write and whether one is already there |

It writes `<project>/keys/<gemini.txt \| claude.txt>` — the first filename `resolveKeys` looks
for in each vendor's list, so what is written is what is read. Before writing it **ensures the
project's `.gitignore` ignores `keys/`**, appending the line if it is missing: commit-on-save
runs `git commit -A` after every mutating command, so a key dropped into a directory git can see
is committed within the second. That check is the reason the write is safe, not a courtesy.

The File menu entry opens `openCommandDialog('project.setKey')` — an argument no menu can supply,
which is the established rule for a dialog rather than a straight `exec`.

## 2. Root items get the menu their branch is about

> Right-clicking on the characters tree root item thingy in the document tree should popup the
> context menu with 'create character sheet' etc. Same with locations tree.
> The story context menu should also pop up when right clicking its root item […]
> The Story context menu should include a 'new scene' command.

`menuFor` in `renderer/pathux/doctree.ts` answers `branch` with `wikiCreate()` for `wiki` and an
empty list for the other four. Three of those four are places an author creates things in, and
each already has the command:

| node | entries |
| --- | --- |
| `branch:story` | New scene… · Export Fountain |
| `branch:characters` | New character sheet… |
| `branch:locations` | New location sheet… |
| `branch:wiki` | unchanged — New wiki page… · New character sheet… · New location sheet… |
| `branch:assets` | still none. An asset is rendered, not authored; there is no command that makes one from a heading. |

`scene` keeps `Assign line ids` and gains the two story-level entries below a separator, so the
menu an author reaches from a scene is a superset of the one they reach from the branch — the
same two commands, in the same words, wherever the pointer was.

`New scene…` is `story.newScene` with `form: true`: it needs a scene id and a Fountain heading,
neither of which a menu can supply. `New character sheet…` / `New location sheet…` are the
`doc.create` invocations `wikiCreate()` already writes, hoisted into a shared helper so the
sheet-creating entries have one spelling.

## 3. A right-click must not move the tree

> […] also right clicking items with context menus shouldn't collapse or expand the trees.

Reproduced over CDP against the running app. A right-click itself is innocent: Chromium fires
`pointerdown` → `mousedown` → `pointerup` → `mouseup` → `auxclick` → `contextmenu` for button 2
and **no `click` at all**, so `pick` never runs and the tree does not move.

The click that _dismisses_ the menu is the culprit. path.ux's menu wrangler closes on mouse-up,
and the `click` that follows lands on whatever row the pointer was over — which selects it and,
on a grouping row, toggles it. Right-clicking `Characters`, then clicking away over `Story`,
collapses `Story`. From the author's seat that is a right-click rearranging the tree.

The fix is in `apps/desktop/renderer/pathux/`:

- `showmenu.ts` exports `menuIsOpen()` — `menuWrangler.menu !== undefined`, the one place that
  knows path.ux's menu state, beside the one place that opens one.
- `editors/documents.ts` adds a **capture-phase `pointerdown`** listener on its surface. A menu
  is still up at pointer-down and already gone by click, so pointer-down is the only moment the
  question can be asked. When one was open, the flag is set and the row's `click` handler
  consumes it and returns.

Self-clearing in every case: dismissed with Escape, no flag is ever set; taken from the menu, the
pointer-down landed in the popup and not on the surface; used to dismiss, the very next click
clears it.

## 4. `Write the screenplay` becomes `Export Fountain`

> 'Write the screenplay' in the story context menu should renamed to 'Export Fountain'.

The command's own `title` changes with the menu entry, not just the label. A right-click entry
defaults to the registry's text for its tooltip (`CLAUDE.md` § Tooltips), and two names for one
act is how a palette and a menu start disagreeing. `story.export` next to it is already
`Export playable`, so the pair reads as one family.

`docs/document-tree.md` and `docs/cli.md` carry the old words; both are updated.

## 5. Rename a document in place

> Double clicking on renamable documents in the document tree should let you edit the name
> inline, applying the rename on enter (and aborting on escape). This operation should be
> undoable, which presumably could be done with git?

**What a rename changes is the name that is drawn.** The tree labels a character with
`Character.name`, a location with `Location.name`, and a wiki page with the title the bible
indexed. It labels a scene with its **id** — which is its filename, its `start:`, and every
`[[goto:]]` pointing at it — so a scene is deliberately not renamable here: that is a `story.*`
refactor with its own refusals, not a textbox in a sidebar. Assets, shots, branches, directories
and bare files have no name of their own to change.

| node | what is written |
| --- | --- |
| `character` | `applyCharacterEdit(doc, { name })` |
| `location` | `applyLocationEdit(doc, { name })` |
| `wiki` | wherever the title was read from — see below |
| everything else | refused by name |

A wiki page's title is "front-matter `title:`, else the first H1, else the filename stem"
(`@vn/bible`'s indexer). A rename writes **where the title is read from**, following exactly that
precedence: patch front-matter `title:` when there is one, else the first H1, else add a
front-matter `title:`. Writing anywhere else would leave the tree showing the old name and look
like the rename failed.

Note what a rename does **not** do: it never moves a file. The id is derived from the name only
at creation (`doc.create`); afterwards the id is what shots, cast lists and `satisfies` entries
point at, and renaming the file would break every one of them silently.

**`renameInText(path, text, name)`** in `apps/desktop/src/main/rename.ts` is the whole rule, as
text in and text out — pure, and tested as such. The kind is `conventionalKind(path)` with a
`type:` tag as the fallback, the same way round `checkDocWrite` asks it; a sheet round-trips
through `@vn/model`'s `apply*Edit`, and a page is **spliced**, because `docToMarkdown` always
emits a front-matter block and a plain `# Note` has none to emit.

**`doc.rename`** in `apps/desktop/src/main/commands/doc.ts` — `path` + `name`, `mutating`,
`undoable: true`. Undo is the git-shadow-snapshot journal the stack already runs for
`doc.write`; the author's guess in the todo is right, and it costs nothing new.
`WorkspaceSession.previewRename` / `renameDoc` are one `planRename` over `readDoc`, so the check
and the run ask the same question of the same bytes; the write is the ordinary `saveDoc`, which
brings the `scenes/**` refusal with it rather than restating it.

**The inline editor** is `apps/desktop/renderer/pathux/editors/documents.ts`, with the rule in
the pure module beside it:

- `doctree.ts` gains `renameOf(node): { path, name } | undefined` — a pure table, tested in node
  like `menuFor` and `selectionForNode`. It answers for a `character`, `location` or `wiki` node
  **that carries a path**: an entity with no sheet of its own has nowhere to write the name.
- **The double click is counted, not listened for.** The first click selects, which rebuilds the
  rows — so by the time a `dblclick` would be dispatched, the element both clicks landed on no
  longer exists. Two clicks on the same **node id** within 500 ms is the gesture, and the row is
  found again by `data-id` rather than held onto.
- The label span is swapped for an `<input>` carrying the current name; Enter runs `doc.rename`,
  Escape and blur abort, and a name that did not change commits nothing. The input stops its own
  keydown, because the screen keymap is a bubble-phase window listener and a `/` typed into a
  name would otherwise open the palette.
- The row's `.title` and the box's own say what they do, per the tooltip rule.

`docs/document-tree.md`'s "Deliberately absent → Editing through the tree" paragraph is now half
wrong; it is rewritten to say what is true: a rename is a registered command with its own
refusals, reached from the tree; move and delete still are not.

## 6. A new repository gets a `.gitignore`

> When initializing a new project git repo a default .gitignore should be created.

`initRepoAt` in `apps/desktop/src/main/workspace.ts` — "the deliberate opposite of `ensureRepo`"
— writes one before its first commit, and only when the directory has none. `ensureRepo` reaches
the same code, so a plain folder brought under version control by opening it gets the same file.

```
keys
node_modules
.DS_Store
```

`vngen/` is **not** in it, and that is the point of writing the file here rather than leaving it
to a template: the generated tree is committed on purpose (`docs/cli.md`), and the first thing
somebody hand-writing a `.gitignore` for a project full of generated art does is ignore it.
`keys` is the load-bearing line — it is what keeps a key out of the undo snapshots and out of
commit-on-save, and it is the same line item 1 checks for.

## Order of work

1. `.gitignore` on init (6) — item 1 depends on `keys` being ignored.
2. `prop.secret` + `project.setKey` + the File menu entry (1).
3. `menuFor` roots, the shared sheet-creating entries, and `Export Fountain` (2, 4).
4. The pointer-down latch (3).
5. `doc.rename`, `renameOf`, and the inline editor (5).
6. Docs: `document-tree.md`, `command-system.md`, `cli.md`, `CLAUDE.md`, `docs/index.md`.

## Verified live

The jest desktop project is node-only, so the four surfaces were checked over CDP against a
running app (`pnpm vndesktop --mock`):

- Right-clicking `branch:characters` / `branch:locations` / `branch:story` opens **New character
  sheet…** / **New location sheet…** / **New scene… · Export Fountain**, and the twisty does not
  move. A scene's own menu is the superset (`Assign line ids` first).
- With a menu open, a click on another row's twisty is swallowed and the tree does not toggle;
  with none open the same click toggles, so the latch is not over-eager.
- Double-clicking a character row swaps the label for a box holding the current name; Enter files
  `doc.rename`, the label becomes the new name and the node id — hence the filename — is unchanged.
- `project.setKey` records `key: "<secret>"` in both `props` and the formatted invocation, reports
  the file it wrote **by name only**, and lists `.gitignore` as the one written path.
