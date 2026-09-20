# Custom widgets in the Wiki pane (rich editor, stage 2)

Status: planned. Stage 1 —
[`archive/pathux-rich-editor.md`](archive/pathux-rich-editor.md) — put the Wiki pane on
path.ux's rich text editor, with a sheet's front matter as path.ux's generic form. This
stage replaces the generic boxes for the fields that are not text, puts art beside the
wardrobe it was drawn for, and lets prose refer to pictures and other documents.

## Goal

- A character sheet's `outfits` and a location sheet's `variants` are edited as a list of
  named entries, each with the art already drawn for it beside it, rather than as one JSON
  box. An entry's own art notes, seed and image model are edited in its row.
- `palette` is edited as swatches.
- A `prompt_override` says what it is in a sentence above its JSON, with a button to the
  Asset editor, where clauses are edited; the sheet does not grow a second prompt editor.
- A picture from the project can be put into the prose, and prose can link to another
  document, with completion when the author types `[[`.
- Answers typed into a form that was disposed under the author come back into the form
  that replaces it, when the document's values still match (stage 1 could only report them
  and offer Discard).
- Every rule the pane has after stage 1 stays: one session per path shared across panes,
  the codec that keeps YAML comments and unknown keys, autosave, the Raw view, `seenHash`,
  and the `act()` anchors on every control. Every write this stage adds goes through the
  form and the codec, for that reason.

## Where the design skill applied

The `frontend-design` skill was loaded before any control below was designed, and its
implementer loads it again before deciding a control's look (task 2 says where). What it
changed here:

- **The brief pins the visual direction.** The app already has a palette
  (`renderer/styles/tokens.css`: `--ink` and its raised and sunken steps, `--paper`,
  `--mist`, warm `--sodium` for what an author wrote and cool `--signal` for what the
  pipeline made) and a type system (`--sans` Archivo for chrome, `--prose` Newsreader for
  authored text, `--mono` for paths and hashes). Every control below uses those tokens and
  nothing else; no control introduces a colour, a face, a radius or a shadow of its own.
  The skill's calibration list (cream-and-terracotta, acid accents, card kits, tracked
  caps eyebrows, middle-dot meta strings) was checked against the design and none of it is
  used.
- **One element carries the weight.** The wardrobe: an outfit's description in the
  author's own prose face with the art drawn for it in a row beside it, at prose width.
  Everything else — palette, variants, the prompt sentence, the link popup — is quiet and
  reads as part of the document.
- **Structure encodes information.** An outfit row is a row because outfits are a list;
  the default outfit is marked because the pipeline draws it when a shot names none, not
  as decoration. There is no numbering (outfits are not a sequence), no eyebrow labels, no
  dividers that do not separate two different things.
- **Words are controls.** Every button says what happens: **Add an outfit**, **Insert a
  picture**, **Edit the prompt in the Asset editor**. A refusal says why and what to do,
  in the codec's own sentence. Empty states direct: "No outfits yet. The pipeline draws
  `default` until one is added."
- **No motion that nobody asked for.** The only motion is the completion popup appearing
  under the caret, which answers a keystroke.
- **Quality floor.** Keyboard: every control is reachable by Tab from the prose (path.ux's
  widget host already does the outer stops), swatches and rows have visible focus, and the
  popup closes on Escape. Reduced motion has nothing to reduce.

The wardrobe, at prose width, in a character sheet whose default outfit has art and whose
second outfit has none:

```
Wardrobe                                                        Add an outfit
┌──────────────────────────────────────────────────────────────────────────┐
│ uniform   ● default                                                      │
│ Navy blazer over a white shirt, red ribbon, pleated grey skirt.          │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐                                              │
│ │port│ │frnt│ │side│ │back│                                              │
│ └────┘ └────┘ └────┘ └────┘                                              │
│ Art notes [                                       ] Seed [    ] Model [▾]│
├──────────────────────────────────────────────────────────────────────────┤
│ gala      ○ make default                                          Remove │
│ Floor-length emerald gown, hair up.                                      │
│ Nothing drawn yet.                                                       │
│ Art notes [                                       ] Seed [    ] Model [▾]│
└──────────────────────────────────────────────────────────────────────────┘
```

Left-aligned throughout, the id in `--sans`, the description in `--prose`, thumbnails at
the strip's cell size, the model as the same `<select>` over `modelCatalog()` the Asset
editor's rung row uses (`editors/asset/framing.ts`), with that row's CSS (`.as-rung-seed`,
`.as-rung-model` in `styles/asset.css`) extracted and shared the way `ASSETSTRIP_CSS` is.
The rule between rows is the only rule; it separates two outfits.

## What exists to build on

- path.ux `FormControl` (`vendor/path.ux/scripts/widgets/richtext/form_control.ts`)
  renders every field as a `textbox-x`, keyed by name, and owns the draft: `edits` is a
  map of field name to encoded text, `prepare()` decodes each through `decodeFormField`
  and validates, `commit()` writes through the `FormBinding`. `FormPresentation.fields`
  allows only `label`, `help`, `group` and `control: "text" | "json"`; `group` prefixes
  the label and there is no collapsed section. The layout is inline `cssText`.
  `nativeFormWidgets` constructs `FormControl` itself and exposes no seam for another
  view; `nativeFormBinding` is exported. `refresh()` runs on every session change and,
  while nothing is pending, writes every box (guarded by `box.text !== text`).
- `FormControl` draws a row for every key of the schema root; the presentation can order,
  label and group them, not hide one. Its `values()` spreads the base snapshot and
  overlays `edits`, so a key with no edit reaches the codec unchanged.
- The app's forms (`renderer/pathux/doctree/docforms.ts`) are built once at module load,
  because `nativeFormBinding` compares the selected form to the one it was built with by
  identity, and the module is DOM-free so its coverage test runs under node. Stage 1's
  form already edits `art_notes`, `seed`, `image_model` and `prompt_override` as boxes
  through the codec.
- `recoverDraft(id)` on a detached form draft returns `{ base, edits }`; nothing takes it
  back (stage 1's task 6 note). A draft becomes detached when its widget's `dispose` runs
  with edits pending (`richtext/context.ts`).
- `frontmatterCodec.patch` (`packages/parse/src/frontmatterCodec.ts`) is scalar-range
  patching: a map with the same keys in the same order, or a sequence of the same length,
  recurses; a scalar is replaced in its own range with the author's quoting kept; a
  top-level key is appended after the last line or its line removed. Anything else falls
  to the scalar path: a collection whose shape changed (an outfit added, a swatch removed)
  is rewritten in place as inline JSON, and a collection with a comment inside it or a
  block scalar (`description: |`) is refused. `templates/basic/locations/` writes
  `variants` as a flow sequence. Stage 1 never hit any of this because its boxes edit one
  key's value; a control that adds and removes entries hits it on every use.
- The art commands are lossy where the codec is not. `art.setNotes`, `art.setSeed`,
  `art.setModel` and the `prompt.*` commands write an entity rung through `@vn/model`'s
  `apply*Edit` and `docToMarkdown` (`packages/artgen/src/setnotes.ts`), which
  re-serialises the whole front matter with `stringifyFrontMatter`
  (`packages/parse/src/frontmatter.ts`): comments gone, quoting normalised, `\n` fences.
  That is the path `vnauthor`'s `set_art_notes` and the Asset editor share
  (`docs/reference/pipeline-contracts.md`, "Art direction is authored and appended"). The
  form, through the codec, is the only path that keeps the author's text.
- The markdown provider renders an image atom (`![alt](src)`) through
  `MarkdownRenderOptions.renderMedia` (`providers/markdown_render.ts`): an `HTMLElement`
  back is wrapped as a plain widget with no resize or move gestures; a `WidgetDescriptor`
  back is used as the atom's widget. The default is `md-image-x`, whose `setAtom` runs
  `safeUrl(src, true)` (`providers/markdown_html.ts`), which keeps a relative path, a
  fragment, `http`, `https`, `mailto`, `tel` and `data:image/`, and drops every other
  scheme — `vnasset://` included.
- path.ux already has wikilinks. The parser lifts `[[target|text]]` outside code into a
  link mark with `kind: "wiki"` (`providers/markdown_parse.ts`), serialisation writes the
  brackets back, `MarkdownProviderOptions.onWikilinkStart` fires as the second `[` is
  typed (with the block, the offset and the `KeyboardEvent`, no editor), and
  `markdownOps.insertWikilink(block, from, to, target, text)` replaces the typed `[[…`
  with a wiki-kind mark. `markdownOps.setLink(block, from, to, {kind, target})` marks a
  range as a link of any kind. `RichTextEditor.linkClicked(link, event)` is the click
  hook, with `LinkInfo { kind, target, text, range }`; in edit mode the default is the
  retarget/remove popup (`link_popup.ts`), and nothing in the renderer opens an external
  link today (`openExternal` is reachable only from main, behind allow-listed commands).
- The toolbar is built only by `session.provider.buildToolbar` (`editor.ts`), once per
  session set; `WidgetOptions` has one member, `resolveNativeBlock`. A host adds a button
  by subclassing `MarkdownProvider` and calling `addToolButton`
  (`vendor/path.ux/documentation/richtext.md`). The provider's `styles()` is the CSS in
  the editor's shadow root; the theme reaches it as `--richtext-*` variables
  (`editor_style.ts`), and the app's own `--ink`, `--sodium` and the rest reach it too,
  because a CSS custom property inherits through a shadow boundary; the pane's stylesheet
  rules do not.
- The provider is per session, and a session is shared. `DocBufferOptions.rich` is one
  `DocumentProvider` per pane, `openSession` keeps the first pane's provider for the
  session (`doctree/docsession.ts`, `docbuffer.ts`), and a second pane on the same
  document renders through it. A provider option that closes over a pane's state therefore
  answers for the wrong pane.
- The app's asset picker (`docs/reference/asset-picker.md`): `pickAssetPopup` over
  `asset.list`, thumbnails through `vnasset://<hash>.<ext>`, `galleryItem` and
  `loadAssetThumb` in `renderer/pathux/assets/assetthumb.ts`. Base art lives at
  `assets/objects/<hash>.<ext>`, shot frames at `vngen/build/assets/<hash>.<ext>`
  (`docs/reference/asset-stores.md`, which also says `assets/` may be a repo of its own).
- `workspace:doctree` gives the Wiki pane `backlinks[pathIndex[docPath]]`: an
  `EntityLinks` (`src/shared/ipc.ts`) whose `assets[]` carry `hash`, `ext`, `kind`,
  `label`, `accepted`, `base` and, for a scene, `shotId` — and no slot. `scenes: string[]`
  is there. A model-sheet's angle lives in the task graph, which `main/doctree.ts` does
  not read (its own comment says so); `asset.list` gets its slot from
  `slotOf(asset, labels.angleOf?.(asset.sourceTask))` in `main/session/asset.ts`. The slot
  grammar (`sheet:<id>/<outfit>/<angle>`, `plate:<loc>/<variant>`, `portrait:<id>`) is
  `@vn/artgen`'s `slotaddr.ts`. `usedOutfits(model, shots)` in `@vn/model`'s `used.ts` is
  the planner's answer to which outfits reachable scenes wear, counting shot-subject
  overrides; `allLocationVariants` is its counterpart.
- `hexColor` in `@vn/types` accepts `#rgb` as well as `#rrggbb`.
  `templates/basic/characters/haruki/character.md` has `default_outfit` and no `outfits`
  key.
- The wiki has no link convention of its own
  (`docs/research/navigating-the-story-bible.md`, "Precompute backlinks"): `[[…]]` is the
  screenplay's branch-marker syntax, which the Wiki pane never edits because `doc.write`
  refuses `scenes/**`.
- Rules modules: `renderer/rules/wiki.ts` (`WikiState`, `controls`), `rules/assetstrip.ts`
  (`cellAction`), `rules/assetview.ts`, `rules/promptview.ts`; situations under
  `rules/situations/`; the derived model `ux-model.json` and the swept `anchors.json`
  (`docs/reference/guided-tours.md`). Stage 1 anchored the editor host, outside its shadow
  root, with `doc.write`; `walkWidgets` in `tour/anchors.ts` descends a `UIBase`'s shadow
  root, and `rich-text-x` is one. The effect vocabulary is closed
  (`src/shared/effects.ts`) and names nothing like "edit a form draft"; a drag needs an
  entry in `INTERACTION_IDS` (`src/shared/interactions.ts`).

## Decisions

### D1. Custom controls are per field, inside path.ux's `FormControl`

- `FormPresentation.fields[name].control` gains two forms. `"none"` draws no row for the
  key, so the value passes through the draft untouched and another control owns it. The
  other is a `FieldControlFactory`, called with the node, the field's meta and a
  `FieldHost` (the `ProviderContext` plus whatever the presentation's owner attached; see
  D8 for what the app attaches). A factory returns a `FieldControl`:
  `{ element, read(): string | undefined, write(text: string | undefined): void, setReadOnly(on: boolean): void, focus(): void, dispose(): void }`
  plus an `oninput` the control calls when the author changes it. `read` and `write` speak
  the same encoded text `FormControl` already keeps in `edits` (JSON for a non-string
  node), so `prepare`, `commit`, `discard`, `Omit`, `Validate` and the draft registration
  stay exactly as they are and a custom control is one more source of encoded text.
  `FormControl` falls back to the text box when the factory throws, and reports the reason
  through the status line.
- `write` is a no-op when the text equals what the control last read or wrote. `refresh()`
  calls it on every session change, so a control that rebuilt its rows on every call would
  rebuild on every prose keystroke.
- A `FieldControl` may declare `also: string[]`, further keys it encodes; `FormControl`
  routes `read`/`write` for those keys through it and gives them no row of their own. The
  wardrobe uses it for `default_outfit`.
- Not a replacement view. The alternative — `NativeFormOptions.view` letting the app
  construct its own form over `nativeFormBinding` — was considered and rejected for the
  controls: it would copy the draft machinery (`pending`, `version`, the conflict check
  against `latest`, `Omit`) into the app for the sake of three fields. The seam is per
  field because that is the unit that differs.
- `NativeFormOptions.view` is still added, for one reason: recovery (D7) needs the
  instance, and a factory the host supplies is the cleanest way to get it. Its default is
  `new FormControl(...)`, which is what the app's factory also calls.
- `FormControl`'s layout moves from inline `cssText` to classes (`schema-form`,
  `schema-form-row`, `schema-form-label`, `schema-form-status`, `schema-form-actions`)
  with a `formStyles()` stylesheet the markdown provider's `styles()` includes, written
  over the `--richtext-*` variables so path.ux's own demo looks as it does today. No theme
  block: the app styles the classes by appending its own rules in its provider subclass's
  `styles()` (D6), where its tokens are already in scope.

### D2. The codec learns to add, remove and rename entries

- `frontmatterCodec.patch` gains structural edits inside a block collection: a key added
  to a block map is appended as a new line at the map's indent; a key removed from one has
  its lines removed (the same `removalOf` rule, at depth); a key whose value is unchanged
  but whose name changed at the same position is renamed in the key scalar's own range, so
  the entry keeps its place and its lines; an item added to a block sequence is appended
  and one removed has its lines removed; a flow sequence of plain scalars whose length
  changed is rewritten as a flow sequence (`[day, night, dusk]`), not JSON; a changed
  block scalar is rewritten as a block scalar at its own indent. The comment rule holds:
  the codec refuses to remove or rename an entry that carries a comment ("Removing this
  field requires raw source editing"), and a flow map (`outfits: {…}` on one line) is
  still rewritten inline. The rest of the contract is unchanged: quoting, key order, line
  endings, and every value the edit did not touch; `patch` still re-reads its own output
  and throws if the values do not round-trip.
- Order is the map's written order and the controls never reorder. A rename is detected as
  "same position, different key, same value"; anything else that changes the key list is
  removals and additions, and an addition lands at the end.
- The Raw view is the fallback the refusal names, as it is in stage 1, and the control's
  status line shows the codec's sentence verbatim.
- Tests in `packages/parse/src/tests/`: an outfit appended after a commented one, an
  outfit removed from the middle, a renamed key keeping its lines byte for byte, a swatch
  appended and removed from a block sequence and from a flow sequence, a block-scalar
  description rewritten, a Windows line ending, and each refusal.

### D3. The controls, and what each writes

- All three controls write front matter through the form, so the codec's patch keeps
  comments, quoting and unknown keys (stage 1 D3, D2 here), and every change is one
  undoable edit applied by **Apply answers** — the same gesture as a text field. The
  root-level `art_notes`, `seed`, `image_model` boxes stay as stage 1 drew them.
- **Palette** (`palette: string[]` of hex colours). A row of swatches; a click on a swatch
  opens path.ux's colour picker on it, a click on the empty slot at the end adds one, and
  the swatch's own ✕ removes one. No reorder. Encoded value: the JSON array; a swatch the
  author did not touch keeps its original string (`#fff` stays `#fff`), a changed one is
  written as `#rrggbb`.
- **Wardrobe** (`outfits: Record<string, string | OutfitEntry>`). One row per entry in the
  order written: the id (a text box; the row says "Scenes wear this outfit by its old
  name" when `EntityLinks.usedOutfits` names the id being renamed), the description in the
  prose face, the art (D4), and under it the entry's own `art_notes`, `seed` and
  `image_model` — the model as the Asset editor's `<select>` over `modelCatalog()`. A
  string entry is shown with those three empty and stays a string until one of them is
  typed, when it becomes the long form with `description` carrying the string. **Add an
  outfit** appends a row with an empty id and focuses it; **Remove** takes a row out. An
  absent `outfits` key shows the empty state and the first addition creates the key. The
  default outfit (`default_outfit`) is marked in its row and the mark is the control that
  changes it; `default_outfit` is one of the wardrobe's `also` keys (D1), and a
  `default_outfit` naming no entry (`haruki` in `templates/basic`) shows as a row of its
  own with the description empty and the sentence "Synthesized: no entry describes it".
  Encoded value: the JSON of the map.
- **Variants** (`variants: (string | VariantEntry)[]`). The same row, over a list rather
  than a map, with plates for art and `EntityLinks.usedVariants` for the rename sentence.
  A bare-string variant stays a bare string until an art-direction box is typed.
- **Prompt override.** A custom control for `prompt_override` that draws a sentence, a
  button and then the same JSON box stage 1 draws. The sentence is "Prompt: derived" /
  "Prompt: 3 clauses replaced, 1 muted" / "Prompt: custom text" / "Prompt: written by the
  agent", from `promptOverrideFrom` and `promptOverrideIsEmpty` in `@vn/types`. The
  button, **Edit the prompt in the Asset editor**, runs
  `view.open(editor='asset' subject=<hash>)` on the portrait slot's current asset, and
  says "Nothing has been drawn for this character yet, so there is no prompt to edit" when
  there is none. It is refused while the session is dirty, with "Save the sheet first; the
  Asset editor writes the prompt into it", because the Asset editor's write would land on
  disk under a dirty session and stage 1's `wrote()` rule then refuses the next save as
  changed-underneath. An entry's `prompt_override` is not drawn; it rides through the
  wardrobe's map unchanged.

### D4. Art beside the entry it was drawn for

- `EntityLinks.assets[]` gains `slot?: string`, and `EntityLinks` gains
  `usedOutfits?: string[]` (a character) and `usedVariants?: string[]` (a location), all
  set in `main/doctree.ts`. The slot needs the angle, so `DocTreeInput` gains the
  `angleOf` lookup `session/docs.ts` already has for `asset.list`, and `slotOf` is called
  the way `session/asset.ts` calls it. `usedOutfits(model, shots)` and
  `allLocationVariants` run in main, where the storyboards are. The Wiki pane already
  fetches the tree on `onInvalidate`, so the wardrobe reads its art from the same fetch
  the strip does and there is no second round trip.
- A wardrobe row shows the sheet angles whose slot is `sheet:<id>/<outfit>/<angle>`, the
  default outfit's row also shows `portrait:<id>`; a variant row shows
  `plate:<loc>/<variant>`. A thumbnail is the strip's cell: `cellAction(asset, visible)`
  from `rules/assetstrip.ts`, wrapped with an `on` of `wardrobe/<outfit>/` so its key is
  distinct from the strip's `link/asset/<hash>` in the same editor; a click selects the
  asset and opens the Asset editor where the route says. Accepted art is drawn as is; a
  candidate is drawn with the strip's candidate treatment.
- A row with no art says so in its art column: "Nothing drawn yet" for an outfit in
  `usedOutfits`, and "No scene wears this outfit, so nothing is planned for it" for one
  that is not. The strip under the document stays, because it also shows what the wardrobe
  cannot place (a concept, a reference).
- The form gets its thumbnails the way the strip does, from `vnasset://` through a
  `ThumbnailCache` the pane owns, reached through the `FieldHost` (D1, D8).

### D5. Art direction stays in the form

- The art keys are ordinary front matter, and stage 1 already edits the root ones through
  the form. The first draft of this plan routed the boxes through `art.setNotes` and its
  siblings to keep "one write path"; that path re-serialises the whole sheet and loses the
  author's comments (What exists), which is the one thing this stage promised to keep. So
  the form writes them, entry level included, and the `art.*` commands, the agent's
  `set_art_notes` and the Asset editor stay what they are: a second writer of the same
  keys that the model reads back identically. `pipeline-contracts.md` gains a sentence
  saying the form is that second writer and why.
- A blank art-direction box removes the key, as Omit does, so a project that authors no
  notes still produces byte-identical prompts (`pipeline-contracts.md`'s test of that
  stays green).

### D6. Pictures and links in the prose

- **The pane's provider is a subclass.** `WikiProvider extends MarkdownProvider`
  (`renderer/pathux/editors/wikiprovider.ts`) overrides `buildToolbar` (super, then
  `addToolButton` for **Insert a picture**), `styles()` (super, then the app's form and
  wardrobe rules), and is constructed with `renderMedia` and `onWikilinkStart`. One is
  built per session, not per pane: `DocBufferOptions.rich` becomes
  `(path: string) => DocumentProvider<MdDoc>`, `openSession` calls it once, and the
  provider closes over the session's own document path and nothing of the pane's. What
  needs the pane — the popup's anchor, the doc tree — is found from the event: a
  `KeyboardEvent`'s `composedPath()` reaches the `rich-text-x` host, and the pane is the
  host's `parentWidget`'s editor; `ProviderContext.editor` gives the same for a render.
  The toolbar button's `act()` runs after `bind()` sets the session, because that is when
  the toolbar is rebuilt.
- **Insert a picture** opens `pickAssetPopup` at the button, and confirming inserts an
  image atom whose `src` is the document-relative path to the asset's file
  (`../../assets/objects/<hash>.<ext>` from `characters/aiko/character.md`;
  `vngen/build/assets/…` for a frame) and whose `alt` is the asset's label. A relative
  path has no scheme, so `safeUrl` keeps it, and the file is real, so a markdown viewer
  over the same checkout renders the same picture (GitHub does when `assets/` is in the
  same repo; when it is its own repo the path still resolves on disk and not on the web).
  The picture pins the bytes it showed: a re-render makes a new hash and a new file, and
  the prose keeps pointing at the old one, which is what quoting a picture means; the
  slot's current art is the wardrobe's question, not the prose's.
- **Rendering.** `renderMedia` returns a `WidgetDescriptor` whose `create` constructs
  `md-image-x` and calls `setAtom` with the image as written, so the resize and move
  gestures stay; path.ux gains
  `MarkdownRenderOptions.resolveSrc?: (src: string) => string | undefined`, which
  `MdImageWidget.setAtom` applies after `safeUrl` — the authored text is what is checked,
  and the host's answer is what is loaded. The app's `resolveSrc` maps a path under either
  asset root to `vnasset://<hash>.<ext>`, and leaves anything else alone. A `src` that
  resolves nowhere draws the widget's broken image with the path as its title.
- **A link to a document is a markdown link.** `[Aiko](../aiko/character.md)`: portable,
  and not the `[[…]]` the screenplay uses for markers. path.ux's wikilink syntax is not
  used for documents, so a note quoting `[[outfit: aiko=uniform]]` still renders as
  path.ux renders a wiki-kind link, and clicking it (D6, clicks) does nothing, since
  `outfit: aiko=uniform` resolves to no document.
- **Completion.** `onWikilinkStart` opens a popup under the caret listing the documents in
  the tree (sheets by name, notes by title, scenes by name; `workspace:doctree`), filtered
  as the author types; Enter replaces the typed `[[…` with the link; Escape leaves the two
  brackets as typed. The replacement is `markdownOps.insertWikilink` with a new `kind`
  argument (path.ux change, default `"wiki"`): with `kind: "url"` the op writes a url-kind
  mark instead, so the edit is one op and one undo entry.
- **Clicks.** `linkClicked` in edit mode keeps path.ux's retarget/remove popup for a plain
  click, so a link can still be edited; Ctrl+click (Cmd on macOS), and a plain click when
  the editor is read-only, follows the link when it resolves inside the workspace:
  `view.open(editor='wiki' subject=<path>)` for a document, `cellAction`'s route for an
  asset path. An `http(s)` link is not followed by this stage; the popup shows its target
  and nothing in the renderer may open a browser (What exists).
- The bible keeps indexing plain text; a link is a mention like any other. Backlinks
  between notes are not built here (that is the research doc's "a feature, not a retrieval
  fix"), and the plan records it as out of scope rather than half-doing it.

### D7. Recovering a detached form draft

- `FormControl.restore(draft: { base: FormSnapshot; edits: Iterable<[string, string | undefined]> })`
  takes what `recoverDraft` returns and plays it into a mounted control: each entry is
  written into its field control and into `edits`, the version is bumped, and the status
  line says "Recovered answers from a form that closed". `base.values` is compared first:
  a recovered draft typed over different values is refused (`restore` returns `false`),
  because the answers may no longer mean what they meant.
- What that covers, stated plainly: a raw commit replaces every block
  (`markdownSourceCommand`), so any raw commit in another pane disposes the form. When the
  raw edit changed only prose, the values match and the answers come back; when it changed
  a front-matter value, they do not, and stage 1's footer sentence and **Discard pending
  edits** apply as before. That is the useful half: the prose case is the one where the
  author did not mean to touch the form.
- Order of `dispose` and `create` is not relied on. The pane's `view` factory records the
  mounted `FormControl`; the pane attempts recovery from `paintFoot`, which runs on every
  session change, whenever the session reports a detached `frontmatter:` draft and a
  control is mounted: `recoverDraft(id)`, `restore`, and `discardDraft(id)` on success.

### D8. Every control is anchored and modelled

- The form's controls edit a draft; none runs a command or an effect, and the vocabulary
  of effects is closed. They record what stage 1 recorded for the editor: the `doc.write`
  the answers end in, as a `textBox`, with a distinct `on` per control (`palette`,
  `wardrobe/add`, `wardrobe/<id>/remove`, `wardrobe/<id>/default`,
  `wardrobe/<id>/description`, and so on) so the sweep tells them apart. The prompt button
  is a `view.open` offer with the dirty refusal; a thumbnail is `cellAction` (D4);
  **Insert a picture** records `pickAssetPopup`'s own offer the way the Asset editor's
  Attach… does; the completion popup's rows record the `view.open` a pick does not run, so
  the sweep sees what Enter would write to. No drag anywhere, so `INTERACTION_IDS` is
  untouched.
- The offers live in `rules/sheetform.ts`; situations under
  `rules/situations/sheetform.ts`; `pnpm gen:uxmodel` in every task that adds one.
- The form draws on its own anchor pass: the `FieldHost` (D1) carries an
  `anchor: (el, offer, run) => void` the pane binds to `redrawing('wiki', 'form')`, and a
  control that rebuilt its rows calls the host's `repaint()` so the pane opens a fresh
  pass, because `present` refuses a node whose offer changes inside one pass. The toolbar
  button is on the `bind()` pass (D6).
- A control inside the editor's shadow root is still a DOM node, so `applyOffer` writes
  `title` on it; a path.ux widget inside the form (the colour button) takes `description`.
  The anchor sweep walks the editor's shadow root because `walkWidgets` descends a
  `UIBase`'s.
- Per-pane state reaches a factory without breaking `nativeFormBinding`'s identity check:
  `docforms.ts` stays DOM-free and keeps the schemas and labels; a new
  `doctree/sheetform.ts` builds, once per pane, the pane's own `DocForm` pair whose
  presentations carry the factories bound to that pane's `FieldHost`, and the pane's
  `select` returns those. Identity holds because the pane's `select` and the pane's forms
  are the same objects for the life of the pane.

### D9. Testing

- path.ux: vitest for `FormControl` with a fake field control (read/write round trip, the
  no-op `write`, `"none"`, `also`, Omit, Validate, `restore` accepting and refusing),
  `insertWikilink` with `kind: "url"`, `resolveSrc`; Playwright `forms.spec` for Tab order
  through a custom control. `pnpm run typecheck`, `pnpm run test`, `pnpm run lint:check`
  green in the submodule; each change on the `pathux-rich-editor-widgets` branch, gitlink
  bumped in the superproject commit.
- App: jest over the rules module and situations; the codec tests of D2; a jest test for
  the wardrobe's encoded value (a string entry stays a string, a long-form entry keeps its
  keys, a rename keeps position, an absent map, a default naming no entry) and for the
  link and picture path builders (document-relative paths for a sheet, a note under
  `wiki/`, a location, a Windows-separated tree); a test in `src/main/tests/` for `slot`,
  `usedOutfits` and `usedVariants` on `EntityLinks`. Live behaviour over CDP against a
  git-initialised copy of `templates/basic` with a mock run so the wardrobe has art: each
  control applies as one revision; undo takes it back; the YAML keeps its comment and
  unknown key after an outfit is added and one is renamed; a picture inserted round-trips
  through Raw and back; `[[` completes to a markdown link and Ctrl+click opens the
  document; the prompt button is refused while dirty and opens the Asset editor when
  clean; a raw prose edit in one pane over a typed form in another recovers the answers,
  and a raw front-matter edit leaves them detached with Discard.

## Tasks

Each task is one commit, green under `pnpm check`, `pnpm test`, `pnpm lint` and
`pnpm build`, and appends to As shipped. A `"none"` or a factory enters `docforms.ts` or
`sheetform.ts` only in the task that ships the control replacing the box, so no commit
loses a field the form could edit before it.

1. **path.ux: the field control seam, `"none"`, `also`, `restore`, `view`, and the
   classes** (D1, D7). `form_schema.ts` (`FieldControlFactory`, `FieldControl`,
   `FieldHost`, `control: "none"`), `form_control.ts` (factory dispatch, fallback, the
   no-op `write`, `also` routing, `restore`, classes and `formStyles()`), `form_native.ts`
   (`NativeFormOptions.view`), the markdown provider's `styles()` including
   `formStyles()`, tests, `documentation/richtext.md`. Done; see As shipped.
2. **The app's per-pane forms and provider.** `doctree/sheetform.ts` (per-pane `DocForm`s,
   the `FieldHost`, the `view` factory with recovery), `editors/wikiprovider.ts`
   (`WikiProvider` with `styles()` only, for now), `DocBufferOptions.rich` as a factory
   per session. The implementer loads `frontend-design` here, before the form rules and
   each control's look, and records in As shipped what it changed. Done; see As shipped.
3. **The codec's structural edits** (D2). `packages/parse/src/frontmatterCodec.ts` and its
   tests; `docs/reference/desktop-app-editors-misc.md`'s codec sentence. Done; see As
   shipped.
4. **Palette control** (D3). The smallest control, to prove the seam end to end: swatches,
   picker, add, remove; `rules/sheetform.ts` begins; a situation; `pnpm gen:uxmodel`; CDP
   check. Done; see As shipped.
5. **`EntityLinks.assets[].slot`, `usedOutfits`, `usedVariants`** (D4). Main's
   `doctree.ts` and `DocTreeInput`; a test in `src/main/tests/`; the strip ignores them.
   Done; see As shipped.
6. **Wardrobe control** (D3, D4, D5). Rows, default mark, add, remove, the entry's
   art-direction boxes with the shared rung CSS, art from the tree, the empty-art and
   rename sentences; `default_outfit` becomes `"none"` here. Done; see As shipped.
7. **Variants control** (D3, D4). The same row over a list, plates for art. Done; see As
   shipped.
8. **Prompt override control** (D3). The sentence, the button with the dirty refusal, the
   JSON box. Done; see As shipped.
9. **Insert a picture** (D6). path.ux `resolveSrc`; `WikiProvider.buildToolbar`;
   `pickAssetPopup`; the path builder; the click route; a jest test for the paths. Done;
   see As shipped.
10. **Links and completion** (D6). path.ux `insertWikilink` `kind`; `onWikilinkStart` and
    the popup over the doc tree; the link builder; `linkClicked` routing; a jest test for
    the paths. Done; see As shipped.
11. **Sweep and the CDP cases** (D8, D9): `pnpm gen:uxmodel` is already run per task; the
    anchor sweep re-runs here.
12. **Docs**: `desktop-app-editors-misc.md` (the Wiki section's form and prose bullets),
    `asset-picker.md` (a third opener), `pipeline-contracts.md` (D5's sentence),
    `guided-tours.md` if a new home appears, this plan's As shipped; `pnpm markdown-toc`
    then `pnpm exec prettier --write "docs/**/*.md"`, `pnpm check:doclinks`; move this
    plan to `archive/` and flip its row in `docs/plans/index.md`.

## Risks

- `FormControl`'s conflict rule compares the whole snapshot; a wardrobe edit and a palette
  edit typed in the same form are one draft and commit together, which is what a form is.
  Two panes with forms on the same sheet are the stage 1 case and unchanged.
- D2's structural edits are the part most likely to grow: YAML indentation under a
  sequence of maps, a trailing comment on the last line of a block, a key whose value is
  on the next line. Each refusal is a sentence the author sees with Raw as the way out, so
  a case the codec does not handle costs a raw edit rather than a corrupted file, and
  `patch` re-reads its own output and throws if the values do not round-trip.
- The Asset editor's `prompt.*` and `art.*` commands still rewrite the sheet without its
  comments (D5). The prompt button leads there knowingly; fixing that path means moving
  `@vn/model`'s serializer onto the codec, which is a plan of its own.
- D6 writes paths into authored prose that outlive this plan: `../../assets/objects/…` and
  `../aiko/character.md`. Changing the convention later means migrating every note, so the
  choice is the portable one (plain markdown, real files) rather than the clever one. A
  hand-moved document breaks its own relative links, as it does in any markdown tree;
  `doc.rename` never moves a file (`docs/reference/document-tree.md`).
- The `[[` popup's list is the doc tree, which is capped on a large project
  (`desktop-app-editors-misc.md`, Skills: "The file tree is capped"); a document outside
  the cap is not offered and the link can still be typed by hand.
- `renderMedia` resolving paths per render is cheap (string work), but the thumbnail
  decode is not; the pane's cache bounds it as it does for the strip.

## Out of scope

- Wiki-to-wiki backlinks in the tree or the bible.
- Following an `http(s)` link from a note (needs a renderer-reachable `openExternal`
  behind a command; not this plan's).
- Reordering outfits, variants or swatches (D2 fixes order as written).
- `addFrontmatter` for a sheet with no fence (stage 1 D2's hand-broken file).
- Tables and task lists; the provider already has them.

## Pressure-test findings

A fresh-context reviewer read the first draft against the code on 2026-09-19. Eighteen
findings; what changed for each:

- **The art commands lose the author's comments, so routing the boxes through them
  destroyed what stage 1 kept.** Confirmed in `setnotes.ts` → `docToMarkdown` →
  `stringifyFrontMatter`. D5 reversed: the form writes the four keys, as stage 1 already
  does for the root ones, and the plan says the `art.*` path is the lossy second writer.
  The dirty refusal on those boxes went with it; it survives only on the prompt button.
- **`main/doctree.ts` has no angle, so it cannot build a sheet slot; `usedOutfits` is not
  "the markers from the doc tree".** D4 now threads `angleOf` into `DocTreeInput` and
  computes `usedOutfits`/`usedVariants` in main onto `EntityLinks`.
- **`md-image-x` drops a `vnasset://` src in `safeUrl`.** D6 adds `resolveSrc` to path.ux,
  applied after the safety check, and keeps `md-image-x` so the gestures stay.
- **path.ux already owns `[[`: parser, `onWikilinkStart`, `insertWikilink`, `wiki`-kind
  marks.** D6 rewritten: the popup is `onWikilinkStart`, the pick is `insertWikilink` with
  a new `kind: "url"`, and a quoted `[[outfit: …]]` renders as a wiki link that resolves
  to nothing.
- **The provider is per session and shared by panes; a closure over the pane's path
  answers wrongly in the second pane.** D6: `DocBufferOptions.rich` becomes a factory per
  session; the pane is found from the event or the `ProviderContext`.
- **`widgetOptions` cannot add a toolbar button.** Decided: `WikiProvider` subclass with
  `buildToolbar`; the button's anchor pass runs on `bind()`.
- **Recovery refuses whenever the raw edit touched a front-matter value, and the
  `dispose`/`create` order was assumed.** D7 states the covered case (prose-only raw
  edits) and recovers from `paintFoot` instead of the factory.
- **No disclosure exists, and "none of the four keys is in the draft" contradicted the
  JSON box.** Gone with the D5 reversal; `prompt_override` is a custom control with the
  JSON box beneath its sentence.
- **A rename through removal-plus-addition moves the entry to the end; flow sequences were
  untested.** D2 gains a key-rename primitive and flow-sequence rewriting, and the order
  sentence.
- **`docforms.ts` is DOM-free and identity-compared, so it cannot hold factories.** D8:
  per-pane `DocForm`s in `sheetform.ts`, with the identity argument spelled out.
- **Task 2's `"none"` keys would have shipped four commits that cannot edit them.** The
  tasks now say a `"none"` enters with its replacement.
- **Draft-editing controls have no command or effect to record; drag needs an interaction
  id; `cellAction` keys would collide.** D8: they record `doc.write` as stage 1's editor
  does, with distinct `on`s; no drag anywhere; thumbnails carry a `wardrobe/` prefix; the
  pass is the host's `repaint()`.
- **The dirty refusal greyed the row's boxes until save, and the command's write dropped
  the pane's undo history.** Moot after the reversal; recorded here because it was the
  reason the reversal was cheap to accept.
- **No external link opens a browser today.** D6 keeps path.ux's popup on plain click,
  follows a workspace link on Ctrl+click, and puts `http(s)` out of scope.
- **The `schemaform` theme block had no plumbing.** Dropped; D1 uses `formStyles()` over
  `--richtext-*` variables and the app's `styles()` override, since custom properties
  inherit into the shadow root.
- **The Asset editor's model control is a `<select>`, with pane-local CSS.** The wireframe
  and D3 now say so, with the CSS shared like `ASSETSTRIP_CSS`.
- **`write()` must be a no-op on equal text.** In D1.
- **Smaller corrections** — `slotaddr.ts` not `refcycle.ts`; `document-tree.md` not
  `desktop-app.md` for `doc.rename`; the contracts doc's actual wording; `hexColor`
  accepting `#rgb` (an untouched swatch keeps its text); an absent `outfits` map and a
  default naming no entry; `assets/` as its own repo; the sweep's shadow-root evidence —
  all fixed in place.

## As shipped

### Task 1

- path.ux `23105b89` on its `pathux-rich-editor-widgets` branch. `FieldMeta.control` takes
  `"none"` or a `FieldControlFactory`; a `FieldControl` reads and writes encoded text by
  key, carries `also`, and gets its `oninput` from `FormControl`. The default text box is
  the same seam (`TextFieldControl`), so `refresh`, Omit, `focus` and `dispose` walk one
  list of controls. `FormControl.restore` and `RecoveredForm`; `NativeFormOptions.view`
  with `NativeFormParts` and the exported `formView`. `form_native.ts` re-exports
  `FormControl` and `RecoveredForm`, since that is the module the app's
  `pathux-richtext-forms` alias reaches.
- Two departures from D1. The stylesheet rides inside the form element as a `<style>`
  rather than joining the markdown provider's `styles()`, because `FormControl` also
  mounts standalone (the example's third section, `form_external.ts`); every selector is
  wrapped in `:where()` so a host rule wins on specificity. And the text box's width stays
  a widget property (`box.width = 220`), because `textbox-x` copies its inline width onto
  its inner input and a stylesheet rule never reaches it.
- Tests: `tests/richtext/formControl.test.ts` (a fake wardrobe control with `also`, the
  no-op `write`, `"none"`, Omit through a control, factory fallback with the reason in the
  status line, read-only reaching the control, `restore` accepted and each refusal, a host
  `view` receiving the parts); the example gained `paletteControl` over the character
  palette and `forms.spec.ts` a test that edits through it, applies, and tabs from the
  previous row's Omit through swatch, remove, add, to Omit palette — passing in Chromium
  and Firefox.
- path.ux's `lint:prose` cannot run on this machine: its `.commentlintrc.jsonc` disables
  rule `P15`, which neither the submodule's nor the root's installed `comment-lint` knows
  (a config committed in `cbf4e70e` ahead of the tool). The changed files were checked
  with the same settings minus that rule: 0 findings. `pnpm run format` also rewrites line
  endings under `scripts/path-controller`; those were restored before committing.

### Task 2

- `doctree/sheetform.ts`: `SheetForms`, built once per pane. It merges a pane's
  `SheetControls` over `docforms.ts`'s field metadata, answers `select` with the pane's
  own `DocForm`s (so `nativeFormBinding`'s identity comparison holds), mounts the default
  form through `view` while remembering it, and `recover(session)` plays a detached
  `frontmatter:` draft back through `FormControl.restore`, discarding the draft on
  success. `docforms.ts` gained `formKind` so the pane and `selectForm` share the conflict
  check. The FieldHost of D1 is path.ux's; the pane passes nothing more until task 4's
  control needs it.
- `editors/wikiprovider.ts`: `WikiProvider extends MarkdownProvider` with a `path` and a
  `styles()` that appends `styles/sheetform.css`. `DocBufferOptions.rich` is a factory
  `(path) => DocumentProvider`, called once per `openSession`, so every session's provider
  carries its own path (checked over CDP: the mounted form's `session.provider.path` is
  the pane's document).
- `wiki.ts`: `paintFoot` runs `forms.recover` whenever a session is shown in rich mode,
  before counting detached drafts for the footer, so the order path.ux disposes and
  recreates the form in does not matter.
- The `frontend-design` pass, over the form's rules (`styles/sheetform.css`, reaching the
  editor's shadow root through the provider; the tokens reach it on their own because a
  custom property inherits across the boundary). It changed: the form is a raised panel
  (`--ink-raised` on `--ink-line`, `--r-soft`) in chrome type (`--sans`, 13px) above the
  prose, rather than an unstyled block of the prose face; labels are a fixed 120px column
  in `--mist` at 12px, so the answers are what read; Omit is quiet text beside the box
  that only underlines on hover and focus, since it is a per-row escape and not the row's
  purpose; the actions are bordered `--r-chrome` buttons, the status line is `--mono` in
  `--sodium` (it is a sentence the codec or the form wrote) and disappears when empty. No
  new colour, face, radius or shadow; the prose below keeps its own rules.
- The screenshot pass found two overflows at a narrow pane, both fixed in path.ux
  (`6960bb56`): the text box's fixed 220px, which reverses task 1's departure — the box is
  now `width: 100%` with `min-width: 0` on the inner input, and the row's stylesheet gives
  it `flex: 1 1 120px; min-width: 0`, so the widget follows the row and the input follows
  the widget; and the Omit button's visible text is now the one word, with the field's
  name kept in `aria-label` (the row's label already names it; the Playwright `getByRole`
  names and the vitest lookup still resolve). Two more in the app's rules: the form is
  `border-box` with no minimum width, and the action buttons wrap.
- Tests: `docsession.test.ts` passes the provider as a factory. `sheetform.ts` and
  `wikiprovider.ts` import `pathux-richtext-forms` and `-markdown`, which jest does not
  map, so their coverage is the app's typecheck plus the CDP check; the merge and the
  recovery walk are exercised by task 4's control and D9's CDP cases.

### Task 3

- `frontmatterCodec.patch` now gathers edits through three walkers. `patchMap` over a
  block map: a key at the same position with a new name and an equal value is renamed in
  the key scalar's own range (the author's quoting kept through `scalarText`), a kept key
  recurses, a dropped key loses its lines, and an added key is written after the last
  entry at the column of the last key, as YAML from `yaml`'s `stringify` rather than the
  JSON-quoted `"seed": 7` the top level used to append (that test changed). `patchSeq`
  over a block sequence: a longest-common-subsequence alignment by value, then a dropped
  item next to an added one is patched in place, a dropped item alone loses its lines, and
  an added item is written before the next kept item or after the last, as `- ` block YAML
  (a map item lands as `- id: noon` with its keys under it). `patchBlockScalar`: a changed
  block scalar is rewritten as a literal block at the content's own indent, and as a
  quoted line when the new text has no line break. A flow sequence whose items are all
  scalars is rewritten as a flow sequence, plain where the text can be.
- Refusals, each in a sentence the form's status line shows: "Removing this field requires
  raw source editing" and "…this item…" when the entry or its value carries a comment or
  shares its line with anything but indentation (the first key of a `- id: x` sequence
  item, for one); "Renaming this field requires raw source editing"; "This collection
  requires raw source editing" for a commented collection the codec would have to rewrite
  inline; "This block scalar requires raw source editing" for one with a comment, or one
  replaced by a non-string. A collection emptied outright is rewritten inline as `[]` or
  `{}`.
- Two things the plan did not say. Values compare by a key-sorted canonical JSON, so the
  round-trip check and the rename test do not depend on the order a form wrote keys in,
  which the written order never follows anyway. Two insertions at one offset (a key
  appended inside the last entry, and one appended after it) keep the order they were
  gathered in.
- Tests: the fixed block, the CRLF block and the template sheets as before, plus a sheet
  with a commented outfit, a block palette, a flow tag list, a literal bio and mixed
  variants: append after the commented entry, a nested entry as block YAML, removal from
  the middle (refused with the comment, done without it), a rename byte for byte, a
  refused rename, a rename with a changed value read as removal plus addition, sequence
  append and removal, insertion before a kept item and replacement in place, a map item
  appended and an existing one edited entry by entry, flow rewrite with a quoted item, the
  block scalar both ways, CRLF through a structural edit, and the emptied collection with
  the commented refusal. `docs/reference/desktop-app-editors-misc.md`'s Wiki bullet names
  the new behaviour and the refusal.

### Task 4

- `doctree/palettecontrol.ts`: `paletteControl(field, host)`, a `FieldControl` over the
  encoded JSON of `palette`. Each swatch is a path.ux `color-picker-button-x` at 22px with
  no label, so a click opens the colour picker the rest of the app uses; its `on_change`
  writes `#rrggbb` into that index only, so an untouched swatch keeps its written string.
  A `×` beside each swatch removes it and the dashed slot after the last adds one, mid
  grey. Text that is not a JSON list of strings is shown as a sentence ("Not a list of
  colours; edit it in the Raw view") and handed back unchanged. Read-only greys all three.
- The pane reaches the control through `SheetHost` in `doctree/sheetform.ts` (`path()`,
  `anchors(part)`), which `sheetControls(host)` binds into the `FieldMeta` factories
  `SheetForms` merges; `wiki.ts` passes `() => this.buf.path` and
  `(part) => redrawing('wiki', 'form/' + part)`. That is D8's `FieldHost.anchor` and
  `repaint()` in one: a control that rebuilds its rows opens a fresh pass for its own part
  (`wiki/form/palette`), so no node presents two offers in one pass and another control's
  records are untouched; `dispose` opens an empty pass so the sweep stops seeing swatches
  that are gone.
- `rules/sheetform.ts`: `swatchOffer`, `swatchRemove`, `swatchAdd` and `controls`, each
  the `doc.write` the text box records with `on` of `palette/<i>`, `palette/<i>/remove`
  and `palette/add`, refused with nothing open or a read-only session; the colour button
  is recorded (`record`) because the picker is the widget's own click, the two buttons are
  acted. Situations `palette`, `palette-empty`, `read-only`; `ux-model.json` regenerated;
  `rules/tests/sheetform.test.ts`.
- Over CDP on the fixture: four swatches with the offers' sentences as tooltips and nine
  anchors; the slot adds a fifth and Apply answers makes one revision that appends
  `- "#808080"` under the block palette with the comment and the unknown key kept; the
  editor's undo takes it back; the picker opened from a swatch writes `#336699` into the
  first line and closes on Escape. Autosave applied that draft and wrote the file, as
  stage 1 has it apply every pending form answer.
- The look: the swatches sit in a row where the JSON box was and wrap in a narrow pane; a
  1px `--ink-line` outline on each, `--r-chrome` corners, the `×` and the slot in
  `--mist-dim` rising to `--paper` on hover and focus. Labels now shrink to 72px in a
  narrow pane rather than holding 120px. path.ux `3add5bea` drops the `console.warn` the
  colour button logged on every press.

### Task 5

- `EntityLinks.assets[]` carries `slot`, the address from `@vn/artgen`'s `slotOf` and
  `slotKey` (`portrait:aiko`, `sheet:aiko/gala/side`, `plate:cafe/night`,
  `shot:arrival/arrival-s1`), absent for a concept or an upload. `DocTreeInput.angleOf` is
  `labelContext`'s lookup, passed by `session/docs.ts` beside `assetLabels`, so a sheet's
  address names the angle its task carried rather than the front.
- `EntityLinks.usedOutfits` on a character and `usedVariants` on a location, from
  `@vn/model`'s `usedOutfits(model, shots)` and `allLocationVariants(model)`, computed
  once per build (`plannedFor`) over the same `shots` map the story branch walks, with a
  storyboard that would not parse counted as no shots. A scene's links carry neither.
- `main/tests/doctree.test.ts`: the two existing backlink shapes gained their `slot` and
  `usedOutfits`; new cases for the angle reaching a sheet's address, a concept with no
  address, a gala outfit worn by one shot listed after the default, a location's `day`
  variant, the fields' absence on the other subjects, and a broken storyboard.
- The strip (`renderer/pathux/assets/assetstrip.ts`) and the backlink panel read `assets`
  as before and ignore the new fields, so nothing on screen changes in this task.

### Task 6

- `doctree/wardrobecontrol.ts`: `wardrobeControl(field, host)`, a `FieldControl` over the
  encoded JSON of `outfits` that `also` edits `default_outfit`, so the form's draft,
  Apply, Discard and Omit treat the pair as fields and `default_outfit`'s own row is
  `"none"`. It keeps rows (`id`, `loadedId`, `entry`), the default by row identity with
  the bare id as the fallback, and encodes on every change unless an id is empty or
  repeated, in which case the row says so ("Give this outfit an id", "Another outfit
  already has this id") and the last encoding stands until it is fixed. A renamed row
  stays in its position, as the codec renames in place; when a scene still wears the old
  name the row says "Scenes wear this outfit by its old name, `<id>`". The default follows
  a rename because it is the row, not the id. Removing the default keeps `default_outfit`
  naming it, and the row comes back synthesized at the top ("Synthesized: no entry
  describes it"), with no remove, no direction boxes and a description box whose
  placeholder offers to create the entry; typing there makes it real. An emptied wardrobe
  omits the `outfits` key rather than writing `{}`, and the empty state says "No outfits
  yet. The pipeline draws `<default>` until one is added." Text that is not a map of
  strings or objects is shown as "Not a wardrobe; edit it in the Raw view" and handed back
  unchanged.
- `doctree/entryrows.ts`: the rows themselves, shared with task 7's variants through
  `EntryRowsHost` (`planned`, `art`, `used`, an optional `mark`, `empty`, `changed`,
  `add`, `remove`). A row is its id box, the default mark (`● default`, refused as already
  worn, or `○ make default`), Remove, a note line, the description in the prose face
  growing with its text, the art drawn for the entry as the strip's own cells
  (`assetCell`, exported from `assetstrip.ts`) or a sentence ("Nothing drawn yet" when the
  pipeline plans it, "No scene wears this outfit, so nothing is planned for it"
  otherwise), and the entry's own art direction: notes, seed and model, the seed and model
  in the Asset editor's rung classes. Typing into a direction box turns a bare string into
  the long form; clearing one drops the key. The button after the rows takes its label
  from the offer, so "Add an outfit" and "Add a variant" are written once.
- `SheetHost` gains `links()`, `onLinks(listener)`, `visible()` and `openAsset(hash)`;
  `wiki.ts` answers them from the tree the strip reads (`pathIndex` then `backlinks`),
  notifies the listeners at the end of `loadTree`, and routes a thumbnail's click as the
  strip does. An outfit's art is the `sheet:<id>/<outfit>/<angle>` assets, plus the
  `portrait:` ones on the default row.
- `styles/rung.css` holds the seed box and model select that `asset.css` held, adopted by
  the Asset editor beside its own sheet and appended, with the strip's sheet, in
  `WikiProvider.styles()`, because the rows draw inside the editor's shadow root. A row
  whose control is the wardrobe wraps under its label with Omit on the label's line, since
  a tall control beside a label is two columns of nothing.
- `rules/sheetform.ts`: `EntryKind`, `EntryRows`, `entryAdd`, `entryField` (`id`,
  `description`, `notes`, `seed`, `model`), `entryRemove`, `defaultMark`, `entryArt` (the
  strip's `cellAction` keyed `wardrobe/<id>/asset/<hash>`), and `controls` listing each
  row in written order; a row with no id yet is keyed by its index as `#<n>`. Situations
  `wardrobe`, `wardrobe-empty`, and `read-only` now with a row; `ux-model.json`
  regenerated; `rules/tests/sheetform.test.ts` covers the offers and the listing.
- Over CDP on the fixture: two rows with the offers' sentences as tooltips; Add an outfit
  appends a row with the id focused and the empty-id note; a duplicate id is refused in
  the note; renaming `track` to `sport` keeps its line; making the new row the default and
  Apply answers makes one revision writing `default_outfit: gala` beside the comment, the
  rename in place and `gala:` as block YAML with `description` and `seed: 7`, the unknown
  key kept; removing `gala` brings it back synthesized; typing there creates
  `gala: silver gown` as a bare string, appended after the kept keys, so the row moves to
  the end after Apply because the rows follow the document's order; the editor's undo
  takes each revision back and the rows follow.
- The look: each row is set off by a 2px rule down its left edge rather than a frame,
  dashed for a synthesized row; the id and notes boxes and the default mark are chrome
  type, the description is `--prose` at 13px, the notes under the art in `--mono` at
  `--mist-dim`, and the id-problem and synthesized sentences in `--sodium`. Remove and
  make default are quiet words rising to `--paper` on hover and focus.

### Task 7

- `doctree/variantscontrol.ts`: `variantsControl(field, host)`, a `FieldControl` over the
  encoded JSON of `variants`, drawing task 6's rows with no default mark. A bare string in
  the list is a row with an empty description; an entry is a row whose `id` is lifted out
  and whose other keys, `prompt_override` included, ride through untouched. On the way
  back a row with an empty description and no direction of its own is written as the bare
  id again, and any other row as an entry with `id` first — so a `{ id, description: "" }`
  entry that was written by hand comes back as the bare id, which the schema reads the
  same. Ids are checked as the wardrobe's are; an emptied list omits the key, and the
  empty state says "No variants yet. Plates are drawn for `day` until one is added." since
  `day` is what the schema supplies. Text that is not a list of strings or entries is
  shown as "Not a list of variants; edit it in the Raw view" and handed back unchanged.
  Art is the `plate:<location>/<variant>` assets; "No plate is planned for this variant"
  when `usedVariants` does not name the row.
- `sheetControls` binds it for a location; `rules/situations/sheetform.ts` gains
  `variants` (two rows, one accepted plate, Wiki and Asset visible); `ux-model.json`
  regenerated; `rules/tests/sheetform.test.ts` lists a variant row without the mark.
- Over CDP on the fixture: the classroom's flow sequence `[day, afternoon, evening]`
  becomes `[day, dusk, {"id":"evening","description":"lamps on, windows dark"}]` after a
  rename and a description, which is the codec's inline rewrite of a flow collection that
  gained a map; the rooftop's block sequence gains `- id: night` with its `description`
  under it and `- dawn` as a bare item. Both panes on the same sheet show the same rows.
- The id box grows from 96px to at most 220px rather than shrinking from 140px, because a
  wrapping row wraps before it shrinks anything, and the narrow pane was putting Remove on
  a second line.

### Task 8

- `doctree/promptcontrol.ts`: `promptControl(field, host)`, a `FieldControl` over
  `prompt_override` that draws the sentence, the button, and then the same `textbox-x`
  stage 1 drew, built the way path.ux's own text field builds it. The box is the field;
  the sentence and the button read it, so the form sees one text field and Omit, Apply and
  Discard work as before. `promptSentence(text)` says "Prompt: derived" for an absent or
  empty override, "Prompt: custom text", "Prompt: written by the agent", or the chunk
  edits counted ("Prompt: 2 clauses replaced, 1 muted", with "appended", "reordered" and
  "N references" as they apply), through `promptOverrideSchema`, `promptOverrideFrom` and
  `promptOverrideIsEmpty`; text that is not JSON or not an override says so in the same
  place. The sentence follows typing in the box before Apply.
- The button is `promptEdit` in `rules/sheetform.ts`: the strip's publish-then-open over
  the portrait the sheet's prompt draws (`portrait:` slot; the accepted one, else the last
  drawn), keyed `prompt/edit`, refused with "Nothing has been drawn for this character
  yet, so there is no prompt to edit" when there is none, and with `SAVE_FIRST` ("Save the
  sheet first; the Asset editor writes the prompt into it") while the buffer is dirty. The
  buffer counts a pending form draft as dirty, so the refusal appears as soon as the
  author types anywhere in the form, which is right: the Asset editor's write would
  overtake that draft too. Only a character sheet has the field; a location's override
  lives on its variant entries, which ride through the variants control.
- `SheetHost` gains `dirty()` and `onPaint(listener)`; `wiki.ts` answers from
  `DocBuffer.dirty` and notifies at the end of `paint()`, which is when a save or an
  external write changes the answer. The control re-presents its button on that and on
  `onLinks`, on a fresh `wiki/form/prompt` pass each time; the box is left alone so a
  repaint never takes the caret.
- Situations `prompt`, `prompt-dirty`, `prompt-undrawn`; `ux-model.json` regenerated;
  `rules/tests/sheetform.test.ts` covers the open's shape and the three refusals.
- Over CDP on the fixture: "Prompt: derived" and the undrawn refusal as the button's
  tooltip; typing a chunks override into the box turns the sentence into "Prompt: 2
  clauses replaced, 1 muted" and Apply answers writes it as block YAML under
  `prompt_override:`; with a portrait faked into the pane's links the button enables after
  a save, and a press publishes the hash and opens the Asset editor.
- The look: the sentence in chrome type at `--paper`, the button in the form's own action
  style, the box stretched under both.

### Task 9

- path.ux (branch `pathux-rich-editor-widgets`, two commits):
  `markdownOps.insertImage(block, offset, image)` is a new custom op that splices an image
  atom into an editable block, shifting the marks and atoms after it, with the caret
  landing after the atom; it refuses an opaque block, a fence, and an empty `src`.
  `MarkdownRenderOptions.resolveSrc?: (src) => string | undefined` runs after `safeUrl` in
  `MdImageWidget.setAtom`, so what is checked is the authored text and what is loaded is
  the host's answer, and the atom keeps the path as written. The markdown entry re-exports
  `addToolButton`, `addSeparator` and `ToolButton` so a `MarkdownProvider` subclass can
  extend the toolbar it inherits without a deep import. `richtext.md` documents all three;
  the vitest covers the op, the shift and the refusals.
- `AssetListing` gains `file`: where the bytes are, workspace-relative, from whichever
  root holds the hash (`project.store.pathOf`), so a legacy project whose base art still
  lives under `vngen/build/assets/` gets a path to a file that exists. The plan's "kind
  decides the root" is main's rule, applied once, in main; the renderer never restates it.
- `renderer/pathux/assets/picturepath.ts` is the path builder: `pictureSrc(docPath, file)`
  is the document-relative path (`../../assets/objects/<hash>.png` from
  `characters/aiko/character.md`, `../vngen/build/assets/<hash>.webp` from `wiki/lore.md`,
  no prefix from a root-level file), and `pictureAsset(docPath, src)` reads one back to
  `{hash, ext}`, answering `undefined` for a url, an absolute path, a path climbing out of
  the workspace, a file under neither root, or a nested or extensionless name.
  `assets/tests/picturepath.test.ts` round-trips both roots from four documents.
- `WikiProvider` now constructs its base with `resolveSrc` closed over the session's
  document path (`pictureAsset` then `assetThumbUrl`, which is the `vnasset://` url), and
  overrides `buildToolbar`: the inherited row, a separator, then **Insert a picture**
  (`&#9635;`, tooltip `PICTURE_TIP`). The button reads the selection from
  `ctx.editor.selection()` when pressed and the document from the sync it wraps, the way
  the Link button does, so the closure holds the only per-editor state and one provider
  serves two panes. A press with no caret, or a caret in a fence or an opaque block, says
  "Place the cursor in a paragraph where the picture should go first." rather than doing
  nothing. Otherwise it reads `asset.list` once, opens `pickAssetPopup` at the button's
  corner with the provider's own `ThumbnailCache` (kept with the session, so a reopened
  popup redraws from decoded thumbnails), and a confirmed pick dispatches `insertImage`
  with `src: pictureSrc(path, asset.file)` and `alt: asset.label`. Cancel inserts nothing.
- The button is anchored by the pane, not the provider: `paint()` finds it after `bind()`
  through the editor's `[data-richtext-toolbar]` row (the buttons live in the row's shadow
  root, not the editor's) and `record`s it with `pictureOffer(path, readOnly)` on the
  `wiki/bar` pass. Recorded rather than acted, because the provider wires the press.
  `pictureOffer` in `rules/wiki.ts` is the `doc.write` the pick lands in, under
  `on: 'picture'` with `supplies: ['text', 'seenHash']`, refused "No document is open."
  then "This document cannot be written"; `WikiState.readOnly` carries the second, and
  `controls()` lists the button in the rich view only, since the raw view has no toolbar.
  Situation `open-read-only`; `ux-model.json` regenerated; `rules/tests/wiki.test.ts`
  covers the shape, the refusals, and the raw view leaving it out.
- Over CDP on a copy of `examples/mySampleRepo` (inputs and `assets/` only): the button's
  tooltip is the offer's; a press with the caret at offset 5 of the first paragraph opens
  the gallery under the button; OK with nothing selected closes it and inserts nothing;
  picking "Aiko — uniform" inserts an atom
  `{src: '../assets/objects/246322f6….png', alt: 'Aiko — uniform (246322f6)'}` at offset
  5, the widget's `img` loads `vnasset://246322f6….png` at its full 1536 width, the raw
  view shows `![Aiko — uniform (246322f6)](../assets/objects/246322f6….png)`, and Ctrl+Z
  takes the whole insert out as one entry. A press before the editor was ever focused
  shows the sentence above.
- Two things the plan said differently. It named `renderMedia` for the render; the
  widget's own `setAtom` with `resolveSrc` is enough, so the app registers no
  `renderMedia` and the resize and move gestures are untouched. It said the button
  "records `pickAssetPopup`'s own offer the way the Asset editor's Attach… does"; Attach
  records the command its pick completes (`prompt.addRef` with `supplies: ['ref']`), and
  the picture's counterpart is the write its pick lands in, so the offer is a `doc.write`
  with a `supplies` of its own, as the form's controls record theirs (D8).

### Task 10

- path.ux (one commit on `pathux-rich-editor-widgets`): `markdownOps.insertWikilink` takes
  a sixth argument, `kind`, `"wiki"` by default; `"url"` writes an ordinary
  `[text](target)` link mark, so a completion lands as one op and one undo entry either
  way. The `linkclick` event's detail is now `LinkClick`, the `LinkInfo` plus the
  `MouseEvent` itself, because a consumer that follows a link only under a modifier needs
  the click and the event carried only the link. `richtext.md` and the tests cover both.
- `doctree/docpath.ts` is the link builder: `relativePath(docPath, file)` and
  `resolvePath(docPath, href)`, the two directions between the document-relative form
  prose is written in and the workspace-relative paths the app names documents by.
  `assets/picturepath.ts` now calls them rather than carrying its own copy.
  `doctree/doclinks.ts` reads the tree: `linkTargets(roots)` is every node with a markdown
  file behind it, once per path and in tree order; `filterTargets(targets, query)` matches
  the name before the path and keeps `COMPLETION_ROWS` (8); `linkHref(docPath, target)` is
  what a pick writes; `linkedNode(docPath, href, roots)` is what a click resolves, a
  stored picture as an asset node, a document as its tree node, and nothing for a url, a
  path outside the workspace, or a file the tree does not show.
  `doctree/tests/docpath.test.ts` covers the round trips, the refusals, the ordering and
  the cap.
- `editors/wikilinks.ts` is the completion, `LinkCompletion`, owned by the pane and opened
  by the session's provider through `onWikilinkStart`; the provider serves every pane on
  the session, so the pane is found from the key's `composedPath()`, which crosses the
  editor's shadow root up to the pane's host (`paneOf` in `wiki.ts`). The popup is
  `screen.popup` at the caret's own rect (the shadow root's `getSelection()`, else the
  block), in `click` mode with `window` as the close source, and never takes focus: typing
  goes on in the editor, and after each `change` the query is re-read as the text between
  the `[[` and the caret; a caret elsewhere, a deleted bracket or a typed `]` closes it.
  ArrowUp and ArrowDown move the marked row, Enter picks it, Escape closes and leaves the
  `[[` as typed; the keys are heard on the editor's host in the capture phase, ahead of
  the pane's own key handler, which stops every keydown from reaching the window the
  popup's Escape listener sits on. A pick dispatches
  `insertWikilink(block, offset − 2, caret, linkHref(path, target), target.label, 'url')`
  through the bridge. A press on a row `preventDefault`s so the caret stays; the popup's
  own `onRemove` (which unregisters it from the screen) is chained rather than replaced.
- Rows record, they do not run: `linkRow(target, visible)` in `rules/wiki.ts` is the
  `view.open` the target's route gives (`openOf(routeFor(...))`), or the selection alone
  for a document nothing claims, keyed `link/doc/<path>`, drawn on a fresh `wiki/complete`
  pass per rebuild through `act()`, whose click is the pick. `WikiState.completion` lists
  them in `controls()`; situation `open-completing`; `ux-model.json` regenerated;
  `rules/tests/wiki.test.ts` checks the shape and the keys.
- Clicks: the pane listens for `linkclick`. A `url`-kind link is followed under Ctrl or
  Cmd, or on a plain click when the session cannot be written, when `linkedNode` resolves
  it: `openNode` with the node, which is the route a tree click takes, so a document opens
  in the Wiki pane (`here` when one is visible, as a browser would, the document left
  behind kept as its session) and a picture opens the Asset editor elsewhere. Everything
  else is left to path.ux, whose edit-mode default is the popup that edits the link; a
  `[[marker]]` and a url therefore lead nowhere, as D6 says.
- Over CDP on the sample copy, with Playwright's keyboard: typing `[[` at offset 5 of the
  first paragraph opens the popup under the caret with the first eight documents (the
  scenes, in tree order), the first marked; `ai` narrows it to Aiko; Enter writes
  `[Aiko](../characters/aiko/character.md)` over the `[[ai`, the mark
  `{from: 5, to: 9, kind: 'url'}`, and the caret lands after it; autosave then wrote
  exactly that markdown to disk. `[[` then Escape leaves `[[` in the text and typing on
  does not reopen it. A plain click on the link opens path.ux's link popup; Ctrl+click
  opens Aiko's sheet in the pane; Ctrl+click on a `[pic](../assets/objects/<hash>.png)`
  link opens the Asset editor on that hash elsewhere and leaves the note where it was.
- Look: the popup's rows are the wardrobe's entry vocabulary, a name in the prose face
  over the path in the chrome face, the marked row carrying the `--sodium` left rule;
  `styles/linkcomplete.css`, put into the popup's shadow root since the popup floats
  outside the pane's sheets.
