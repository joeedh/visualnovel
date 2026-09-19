# The Wiki pane on path.ux's rich text editor

Status: planned. Stage 1 is specified here; stage 2 (custom widgets) is a separate plan
that stage 1's last task writes.

## Goal

- Replace the `<textarea>` in the Wiki pane
  (`apps/desktop/renderer/pathux/editors/wiki.ts`) with path.ux's `RichTextEditor` over
  its `MarkdownProvider`.
- Edit a character or location sheet's YAML front matter through path.ux's native
  front-matter form (`nativeFormWidgets`), with the app's existing Zod schemas.
- Keep every rule the pane has today: `doc.read` / `doc.write`, `seenHash` refusal, drafts
  that outlive the pane, the quit guard, `wrote()` re-reads, the asset strip, the footer
  diagnostic, the Save / Reload / pin bar, and the `act()` anchors.
- Add a raw-source toggle: the same document as text, sharing one session and one undo
  history with the rich view.

This reverses a recorded product decision. `docs/reference/desktop-app-editors-misc.md`
says the Wiki pane "is not a form over `Character`: the author edits the markdown, so the
front-matter sits in the same box as the prose". That was written when the alternative was
a form _instead of_ the markdown. Here the form sits inside the same document view, in the
place the YAML block occupies, over the same session and undo history, and the raw toggle
keeps the whole file editable as text. Task 10 rewrites that paragraph to say so.

## What path.ux ships (as of `vendor/path.ux` master `53d4fd61`)

The gitlink bump to that commit is the first commit of this branch. path.ux's own
documentation is the reference; this plan only names what the app calls.

- `RichTextEditor` (`rich-text-x`), `RichTextArea`, `DocumentSession` (`prepareSave`,
  `registerDraft`, `pendingDrafts`, `discardDraft`, `recoverDraft`, `onChange`,
  `invalidateWidgets`), widgets: `vendor/path.ux/documentation/richtext.md`.
- `MarkdownProvider`, `markdownDocFromText`, `markdownText`, `markdownOps`, the toolbar:
  `richtext.md` §Markdown, `markdown_syntax.md`. Imported from
  `scripts/widgets/richtext/markdown.ts`, never the barrel, because it bundles the mdast
  chain.
- Source retention: `markdownSourceDoc(source)` opens a document so a metadata-only edit
  writes the body back byte-for-byte and a body edit keeps the YAML prefix;
  `markdownSourceCommand(doc, expected, source)` replaces the whole document under a
  whole-source precondition (`providers/markdown_source.ts`). Both are re-exported from
  `form_native.ts`.
- Forms: `FormControl`, `FormSchema`, `zodFormSchema` (Zod 3; path.ux pins `3.25.76`, the
  app's `^3.24.1` resolves to the same),
  `nativeFormWidgets({ codec, select, onDiagnostic })`, `nativeFormBinding`,
  `addFrontmatter`, `switchFormBinding` (`form_*.ts`). The design and its visualnovel
  section: `documentation/plans/rich-text-widget-forms.md`; the migration tasks V1–V4:
  `documentation/plans/rich-text-widget-tasks.md`.
- The host owns YAML.
  `FrontmatterCodec = { read(source): JsonValue; patch(source, values): string }`. path.ux
  imports no YAML runtime. Its example codec (`example/editors/properties/form_yaml.ts`,
  on the `yaml` package) is the model for ours.
- No raw-source toggle ships. `example/editors/properties/forms_demo.ts` shows the
  pattern: a textarea registered as a draft on the session, committed through
  `markdownSourceCommand`. The app writes its own toggle on those primitives.
- `select` signals a refusal with a reason by **throwing**; `nativeFormWidgets` catches it
  and hands the message to `onDiagnostic(block, message)` (`form_native.ts`). Returning
  `undefined` produces path.ux's fixed "No form schema selected" message instead.
- `FormControl` labels a field `presentation.fields[name].label ?? name` and tooltips it
  `help ?? node.description` (`form_control.ts`); `zodFormSchema` reads `description` only
  from `.describe()`. The TS doc comments on the app's schemas do not exist at runtime.
- `FormControl`'s own buttons (Apply answers, Discard answers, Validate, Omit) carry no
  tooltip today. That is a path.ux change (D8).

## Decisions

### D1. One classification rule, resolved in main, re-read in the renderer

- The rule today is spelled three ways: `taggedKind(doc.data) ?? conventionalKind(path)`
  (`apps/desktop/src/main/session/core.ts`),
  `conventionalKind(path) ?? taggedKind(doc.data)`
  (`apps/desktop/src/main/doctree/rename.ts`), and conflict-is-an-error in the private
  `tagConflict` (`packages/store/src/entities.ts`). The order does not matter when a
  conflict is an error, but three spellings invite a fourth.
- One exported resolver, with the path logic left where it is:

    ```ts
    type DocKind =
        { kind: EntityTag } | { kind: "note" } | { kind: "conflict"; reason: string };
    export function docKind(
        implied: EntityTag | undefined,
        data: Record<string, unknown>,
    ): DocKind;
    ```

    `tagConflict`, `core.ts` and `rename.ts` are rewritten over it (task 2), so the
    conflict sentence has exactly one home. `conventionalKind` stays in `@vn/store`, the
    path convention with it. `taggedKind` is the one-line tag check `docKind` needs, so it
    moves with `docKind` and `@vn/store` re-exports both.

- `doc.read` returns the implied kind: `DocFile` gains `implied: EntityTag | undefined`
  (`conventionalKind(path)`, computed in main, where the path convention lives). The
  renderer never needs `@vn/store`.
- `docKind` must run renderer-side too, because a raw edit can change `type:` between
  reads. `docKind` is pure over `ENTITY_TAGS`, so it lives in `@vn/types` beside
  `ENTITY_TAGS` in `schemas.ts` (no new file; `packages/types/src/entities.ts` already
  exists and holds the domain interfaces), and `@vn/store` re-exports it. The path
  convention does not move; only the two-input resolver does.
- The renderer's `select`, built per document in `open()`:

    ```ts
    select: (values) => {
        const kind = docKind(file.implied, formObject(values) ? values : {});
        if (kind.kind === "conflict") throw new Error(kind.reason);
        return kind.kind === "note" ? undefined : FORMS[kind.kind];
    };
    ```

- `FORMS` is a module-level record built once, because `nativeFormBinding` compares the
  selected object by identity.
- `onDiagnostic` messages reach the footer only when the document is a sheet or a
  conflict; a note's fixed "No form schema selected" is not news and is dropped. The pane
  knows the kind because it computed it.

### D2. Wiki notes have no front-matter schema, and this plan adds none

- Verified: nothing in `@vn/types`, `@vn/model` or `@vn/bible` defines a note schema. The
  bible indexer reads `title` / `name` loosely and treats unparseable front matter as
  "index the text as it is" (`packages/bible/src/indexer.ts`). `doc.create` scaffolds a
  note as a heading and nothing else.
- So for a note `select` declines, the front-matter block (if any) is path.ux's inert raw
  view, and the raw toggle is how an author edits it. No form, no defaults written, no
  keys dropped.
- A sheet with no front-matter fence gets no form either; the footer says "no front
  matter", and the raw view is the way to add one. `addFrontmatter` is not wired in stage
  1: `doc.create` always scaffolds a fence, so the case is a hand-broken file.

### D3. The codec lives in `@vn/parse`, on the app's fence grammar

- `packages/parse/src/frontmatterCodec.ts`, exported as `frontmatterCodec`, beside
  `splitFrontMatter`. `@vn/parse` is browser-safe (no `node:` imports; its runtime dep is
  `yaml`) and is already resolvable from the renderer the way `@vn/model` is
  (`moduleResolution: bundler`, `apps/desktop/package.json` dependency); no `tsconfig`
  path is needed.
- Fence grammar is `@vn/parse`'s `FENCE` (`---` at offset 0 after an optional BOM), not
  path.ux's looser one (leading blank lines). path.ux may recognise a front-matter block
  that `doc.write`, `entityDiagnostic` and the model would read as body, and the block
  source it hands the codec never shows it: `markdownSourceDoc` moves the BOM and any
  leading blank lines into `retainedSource.prefix` and gives the block the fence alone. So
  the codec accepts every block path.ux hands it, and the pane's `select` (task 4) is what
  refuses a document whose retained prefix holds a line ending, with the reason in the
  footer. The two readers of the same bytes therefore never disagree about whether a form
  applies.
- YAML policy is the example codec's: ≤ 64 KiB, `core` schema, strict, unique keys, no
  anchors / aliases / tags, ≤ 10 000 nodes and depth ≤ 32, root must be a mapping. The
  node and depth limits are the codec's own; path.ux applies `widgetJson` again at its
  boundary, and that duplication is accepted because `@vn/parse` cannot import path.ux.
- `patch` replaces scalar source ranges in place and recurses into equal-shape maps and
  sequences; anything else (a comment-bearing collection replaced wholesale, a block
  scalar, a flow-map key added or removed) throws, and path.ux keeps the draft for the raw
  path. `patch` preserves comments, quoting, key order, CRLF and untouched keys.
- The `FrontmatterCodec` type is path.ux's; `@vn/parse` declares a structurally identical
  local interface and tsgo checks the shape at the call site.
- Tests in `packages/parse/src/tests/frontmatterCodec.test.ts`: round-trip on the sheets
  in `templates/basic` (the only committed fixtures; `examples/` is gitignored and seeded
  at launch); a scalar patch keeps a comment on the next line; CRLF in, CRLF out; a block
  with a blank line before `---` is refused; each YAML refusal by name.
- `parseFrontMatter` / `stringifyFrontMatter` stay for `doc.write`, `doc.create` and the
  model's serializers; nothing routes a form edit through them.

### D4. One session per document, held beside the drafts map

- path.ux's migration note asks for "one document session per open document, retained
  independently of panes", and the app's own rule is that two panes on one document share
  one draft. So sessions are keyed by path at module level, like `drafts` is today:

    ```ts
    const sessions = new Map<string, DocSession>(); // path → { session, stack, seenHash, loaded }
    ```

    `DocBuffer` keeps its contract (open / reload / save / wrote, `note`, `saveOffer`, the
    quit guard) and gains `session` when constructed with `{ rich: true }`. The Skills
    pane keeps the text form; it takes only the autosave option (D10).

- `open(path)` finds or creates the entry: `markdownSourceDoc(file.text)` on a toolstack
  of its own (one per document; undo never crosses documents or reaches the app's stack).
  Two panes on one path bind the same `DocumentSession`, so they see each other's edits
  live and undo is shared. A pane leaving does not dispose the session; `reload()` and a
  successful `save()` with no dirt left do.
- `dirty` is `session revision !== loaded revision || session.pendingDrafts.length > 0`.
  The badge, `saveOffer` and the quit guard all read that. The quit guard counts text
  drafts plus dirty sessions.
- `text` is read-only with a session (`markdownText(session.doc)`), computed on demand
  (save, raw switch), never per keystroke. The setter throws under `rich`; the raw view
  commits through D5.
- `save()`: `await session.prepareSave()` **before** the offer check. `refused` (a
  detached draft) or `conflict` lands in `note` with the reason and returns `false`;
  `ready` serializes and writes. Only a successful write advances `seenHash` and `loaded`;
  if the revision moved during the write the buffer stays dirty.
- Form drafts survive a pane switch because the session does: a `FormControl` disposed
  with typed-but-unapplied answers leaves a detached draft on the session, and the pane
  that next mounts the same session calls `recoverDraft` for each detached draft whose
  widget re-resolved, so the answers come back into the new control. A draft that cannot
  be recovered (the schema no longer selects) is reported in the footer with a **Discard
  pending edits** control that runs `discardDraft`. Nothing is dropped silently.
- `wrote()` on a clean buffer re-reads as today, but keeps the session when the hash that
  comes back is the one the buffer last saved — the buffer's own write is the commonest
  `onWrote` it hears, and replacing the session on it would throw away undo history after
  every save and every autosave. A hash that differs disposes the entry and re-opens; the
  pane saves the editor's `viewState` before and restores it after, so an agent write or
  `gate.approve` on an open sheet does not reset the caret. On a dirty buffer it does
  nothing, and the next save gets the changed-underneath refusal.

### D5. The raw toggle is the pane's, on path.ux's draft primitives

- A `Raw` toggle in the header bar, recorded as the `pane.view(what='mode')` effect (the
  existing closed set; it changes what the pane shows, and the commit it triggers is the
  session's, not the effect's). Tooltip: "Show this document as Markdown source; edits
  here and in the rich view share one undo history".
- State is per pane and in memory only, default off on every open. `saveUIData` is not
  used (it persists into the layout STRUCT, which is the opposite of ephemeral).
- Raw view: a `<textarea>` registered on the session as a draft, as in `forms_demo.ts`:
  `pending` while typed-into, `prepare` returns
  `markdownSourceCommand(session.doc, base, value)` or `conflict` when the document moved
  under it, `committed` / `discard` reset the base.
- Rich → raw runs `prepareSave()` first, so a pending form draft is applied (or the switch
  is refused with the reason) before the rich editor unmounts. The two views are never
  mounted together in one pane, so a form draft and a raw draft are never pending at once
  in one pane. Across two panes they can be; `prepareSave` commits in registration order,
  and a raw draft whose whole-source precondition then fails reports `conflict` in that
  pane's footer with its text intact, which is the right outcome for the later editor.
- Raw → rich commits the draft through `prepareSave()`; a refusal keeps the raw view up
  and says why. Save from either view is `DocBuffer.save()`.
- The raw textarea keeps the pane's keydown handling (stop propagation, Ctrl+S saves).

### D6. What the pane draws

- Header bar: Save, Reload, Raw, pin.
- Body: the path.ux markdown toolbar, then the `RichTextEditor`; or the raw textarea.
- Under it, unchanged: the asset strip and the footer (path, unsaved badge, note).
- The front-matter form, when `select` accepts, is what path.ux mounts in place of the
  front-matter block. `presentation` is hand-written in `docforms.ts`: field order, a
  label and a help sentence per field, taken from the schemas' doc comments by the
  implementer. `outfits`, `variants`, `prompt_override` and `refs` render as JSON text
  boxes in stage 1 (their nodes are record / array / union, which `FormControl` shows as
  JSON regardless of `control`); stage 2 replaces them.
- `onDiagnostic` writes into the footer `note`, filtered per D1.
- Wikilink completion (`onWikilinkStart`) is wired to nothing in stage 1.

### D7. Bundling and typing

- Entry points the app imports, each needing a vite alias, a renderer `tsconfig` path, a
  row in `apps/desktop/pathux-types.tsconfig.json`'s `files` (the declarations build only
  reaches what `pathux.ts` reaches, and the barrel reaches none of these), and, where a
  jest test imports it, a `moduleNameMapper` row:
    - `pathux-richtext-markdown` → `scripts/widgets/richtext/markdown.ts`
    - `pathux-richtext-forms` → `scripts/widgets/richtext/form_native.ts`
    - `pathux-richtext-zod` → `scripts/widgets/richtext/form_zod.ts`
    - `pathux-richtext-schema` → `scripts/widgets/richtext/form_schema.ts`
    - `pathux-richtext-headless` → `scripts/widgets/richtext/headless.ts`: the document
      without the editor (`DocumentSession`, `ToolStack`, the `MdDoc` model,
      `markdownDocFromText`, `markdownText`, `markdownSourceDoc`,
      `markdownSourceCommand`). Added to path.ux by task 1, because `markdown.ts` reaches
      `RichTextArea` and `form_native.ts` reaches `FormControl`, both of which reach
      `ui_base` and the DOM; `docsession.ts` imports only this entry, so its test loads
      under node. The barrel's `DocumentSession` and this entry's are the same module
      file, so a session made here is what `RichTextEditor` takes.
- The mdast packages resolve from `vendor/path.ux/node_modules` because the importing file
  lives there; `pnpm check:setup` already fails when that install is owed.
- `form_zod.ts` types against path.ux's own `zod` declarations, the app's schemas against
  the workspace's. Both are 3.25.76 and the import is type-only, so runtime is fine; task
  1 proves `zodFormSchema(characterFrontMatter)` type-checks under tsgo, and if the two
  `ZodType` trees are not structurally compatible the cast is a single documented `as`.
- `yaml` reaches the renderer bundle through `@vn/parse`; it is pure JS.

### D8. The editor is a text box with a toolbar; the app owns the commit points

- A `<textarea>` has an undo stack of its own that the app's `history.move` never sees,
  and nothing records its keystrokes; the anchor layer records the box once, as the
  `textBox` offer for `doc.write`. The rich editor is the same thing: its toolstack is the
  box's own history, the toolbar and a mounted form are ways of typing into it, and none
  of that is a command or an effect. So the rich editor — toolbar, root and any form
  inside it — is **one control** to the anchor layer, recorded as today's `textBox` offer
  (`supplies: text, seenHash`; the pane reads `text` from the session).
  `docs/reference/guided-tours.md` states that a rich editor records like a text box (task
  10).
- What the app decides is when session content becomes a document. The commit points, and
  nothing else writes:
    - **Into the session** (undoable with Ctrl+Z inside the box, invisible to the app):
      every keystroke and toolbar op; a form's **Apply**; a raw → rich switch (the raw
      draft through `markdownSourceCommand`); a rich → raw switch (`prepareSave` applies
      pending form answers first).
    - **To disk** (`doc.write`, provenance, per-repo commit-on-save, the app's own undo
      snapshot): **Save** — the button or Ctrl+S — and the **autosave** tick (D10), both
      after `prepareSave`. No session edit reaches disk or the repo any other way.
    - Between the two there is exactly one state, "dirty", which is what the badge, the
      quit guard and `saveOffer` read (D4).
- Every one of those inner buttons still carries a tooltip, per CLAUDE.md. The markdown
  toolbar has them (path.ux `e9ed0913`). `FormControl`'s buttons and its per-field Omit do
  not, so task 6 starts with a path.ux commit adding `title`s to them (submodule first,
  gitlink bumped, per the usual rule), which is the one path.ux change stage 1 makes.
- `pnpm lint` does not enforce the package boundary between the renderer and `@vn/store`
  (lintrix has no boundaries rule; the eslint config that had one is no longer run). The
  renderer must not import `@vn/store` because it reaches `node:fs`, and the failure is
  the bundle's, not lint's.

### D9. Testing

- The desktop jest project is node-only and the `pathux` barrel is deliberately unmapped.
  What can be tested where:
    - `@vn/parse` codec: ordinary jest.
    - `docKind`: ordinary jest in `@vn/types` and `@vn/store`.
    - `FORMS` schema coverage (`zodFormSchema(...).diagnostics` empty for both sheets):
      jest, with `pathux-richtext-zod` and `-schema` mapped; `form_zod.ts` and
      `form_schema.ts` import no DOM. `docforms.ts` therefore imports only those two;
      `nativeFormWidgets(...)` is assembled in the pane, which is not unit-tested.
    - `DocBuffer` with a session: the session logic goes in `docsession.ts` behind the
      same `io` seam, importing path.ux only through `pathux-richtext-headless` (D7), and
      the provider a session needs comes in through the seam too: the Wiki pane passes
      `MarkdownProvider`, the test a replace-only provider (`replaceBlocks` is the one op
      `markdownSourceCommand` issues). The mdast chain is ESM under
      `vendor/path.ux/node_modules`, which jest's default `transformIgnorePatterns` skips;
      task 1 replaces the default with one that ignores every `node_modules` except
      path.ux's own, by directory rather than by package name, because jest resolves
      pnpm's symlinks to their `.pnpm` targets. Proven in task 1: `markdownSourceDoc`,
      `DocumentSession` and `ToolStack` load and run under jest and the process exits
      cleanly. The editor entries also load under node once path.ux's worker shim is
      fixed, but leave module-scope intervals (`ui_lasttool.ts`) ticking, so a single-file
      run never exits; they stay unmapped, like the barrel.
    - The pane itself (rich ↔ raw, anchors): no editor has a jest test and there is no
      jsdom project. Task 7's cases run through the CDP sweep (`scripts/vn-cdp.mjs`)
      against the built app, scripted, not as jest.

### D10. Autosave

- A dirty rich buffer saves itself on a timer. `DocBuffer` takes `{ autosave: ms }`
  (`AUTOSAVE_MS = 60_000` for the Wiki pane); a tick with a dirty buffer runs the same
  `save()` as the button, so every rule — `prepareSave`, `seenHash`, the
  changed-underneath refusal, the diagnostic in the footer — is the one rule. A tick with
  a clean buffer does nothing. Nothing is pending-draft-aware beyond what `save()` already
  is: half-typed form answers are applied by `prepareSave` the same way half-typed prose
  is saved, and a draft that refuses (a value the codec cannot patch) makes the tick skip
  with the reason in the footer, where it stays until the author resolves it.
- The timer is the session's, not the pane's (it lives in the `sessions` entry of D4), so
  a document left dirty in a pane the author switched away from still autosaves, and two
  panes on one document do not race two timers. It stops when the entry is disposed.
- The commit says so. `doc.write` gains `auto: prop.boolean` (default `false`); with it
  the message is `Autosaved <path> (<bytes> bytes).` instead of `Saved …`, which is what
  commit-on-save takes as the subject (`docs/reference/repos-and-commits.md` §Message
  shape), and `Vn-Invocation` carries `auto=true` as well. The check, the write and the
  undo snapshot are otherwise identical, so an autosave is undoable in the app the same
  way a save is. The command stays a single command rather than a `doc.autosave` twin: the
  palette should not offer a second way to save.
- The manual Save button and Ctrl+S remain, for the author who wants the commit now, and
  the unsaved badge still means "not yet on disk". The quit guard is unchanged: quitting
  with a dirty buffer still asks, because the next tick may be 59 seconds away.
- The Skills pane's text buffer takes the same option, at the same interval. For a text
  buffer the timer is the buffer's own (there is no session entry), so it runs while the
  pane is open and stops with it; a draft left in the module-level `drafts` map by a pane
  the author left is not autosaved, which is the one asymmetry with the rich buffer, and
  is accepted because the quit guard still covers it. Skills write through `doc.write`
  too, so the `Autosaved` subject is the same.

## Out of scope for stage 1

- Custom widgets: media views for portraits and plates, an asset picker inside the prose,
  a wardrobe / variants editor, wikilink completion to bible pages. Stage 2.
- Scene documents (`scenes/**`): `doc.write` refuses them and this plan does not reroute.
- The Skills pane on the rich editor: it stays on the text `DocBuffer`, gaining only
  autosave.
- Renaming or moving a document while it is open; `addFrontmatter`.
- `pathux.form` plugin records (a form embedded in the prose).
- Editing path.ux beyond D8's tooltip commit.

## Tasks

1. **Bump the gitlink** to `53d4fd61` (path-controller `6de53ad`), add the five aliases /
   paths / `files` rows (D7), the jest mapper rows and the `transformIgnorePatterns`
   exception (D9), and prove three things with throwaway code that does not ship: the
   markdown module bundles (record the renderer bundle's size delta in the As-shipped
   section), `zodFormSchema(characterFrontMatter)` type-checks (D7), and
   `markdownSourceDoc` runs under jest (D9). No UI change. `pnpm check`, `pnpm test`,
   `pnpm lint`, `pnpm build` green. Done; see As shipped.
2. **`docKind`** in `@vn/types`, re-exported by `@vn/store`; `tagConflict`, `core.ts` and
   `rename.ts` rewritten over it; `DocFile.implied` from `doc.read`. Tests for the three
   outcomes. No behaviour change.
3. **`@vn/parse` codec** (D3) with its tests. Done; see As shipped.
4. **`FORMS`, presentation and `select`** (D1, D2, D6) in
   `apps/desktop/renderer/pathux/doctree/docforms.ts`, with the schema-coverage test.
   Done; `selectForm(implied, values)` is the `select` less the retained-prefix check,
   which needs the session and so stays in the pane (task 6).
5. **`docsession.ts` and `DocBuffer { rich }`** (D4) with tests: two buffers on one path
   share a session; `save()` honours `prepareSave` `refused` / `conflict`; a write that
   lands after further edits leaves the buffer dirty; `wrote()` on a dirty buffer is a
   no-op and on a clean one keeps the session when the hash is its own; the quit guard
   counts a dirty session. **Autosave** (D10) in the same task: `doc.write`'s `auto` prop
   and message (with its command test), the session timer with fake timers — a dirty
   buffer saves on the tick with `auto: true`, a clean one does not, a refused
   `prepareSave` skips and says why, a disposed entry stops ticking, and a text buffer
   ticks while open and stops on close. The Skills pane passes the option.
   `paletteonly.ts`, `pnpm gen:uxmodel` and the anchor sweep for the changed command.
   Done; see As shipped.
6. **path.ux tooltips** on `FormControl`'s buttons (D8), committed in the submodule,
   gitlink bumped. Then **the Wiki pane on the rich editor** (D6): toolbar, editor,
   `widgetOptions` from `nativeFormWidgets`, `onDiagnostic` into the footer, `viewState`
   across `wrote()`, detached-draft recovery and the Discard control. Done; see As shipped
   (recovery is reported and discardable rather than recovered).
7. **Raw toggle** (D5), as `pane.view(what='mode')`. Done; see As shipped.
8. **Sweep and model**: re-run the CDP anchor sweep (`anchors.json`) and
   `pnpm gen:uxmodel` (`rules/wiki.ts` gains the Raw and Discard offers), per
   `docs/reference/guided-tours.md`.
9. **Migration cases** (path.ux V4), scripted over CDP against `templates/basic`: a
   metadata-only edit with a comment and an unknown key leaves the body byte-identical; a
   body-only edit keeps the YAML prefix; a note with no front matter stays a note; an
   `entity_tag_conflict` sheet shows the raw block and the conflict sentence; a blank line
   before `---` shows the raw block; two panes on one document share edits and undo; a
   form draft survives a pane switch; an external rewrite between open and save is
   refused; a minute of idleness after an edit produces a commit whose subject starts
   `Autosaved`, and the editor's undo history survives it.
10. **Docs**: `docs/reference/desktop-app-editors-misc.md` (the Wiki section, including
    the reversed decision and autosave), `docs/reference/guided-tours.md` (D8: a rich
    editor records like a text box), `docs/reference/desktopAppState.md` (the Raw toggle
    is not persisted), `docs/reference/module-map.md` (`@vn/parse` codec, `docKind`),
    `docs/reference/repos-and-commits.md` (the `Autosaved` subject),
    `docs/reference/command-system.md` if `DocFile` is documented there, and this plan's
    As-shipped section. `pnpm markdown-toc`, `pnpm check:doclinks`.
11. **Write the stage 2 plan** (`docs/plans/pathux-rich-editor-widgets.md`): custom
    widgets for portraits and plates, wardrobe / variants / `prompt_override` editing, an
    asset picker in the prose, wikilink completion. Its author loads the `frontend-design`
    skill before designing any control and records in the plan where it applied, and the
    plan itself directs its implementer to the same skill where a control's look is
    decided. It is pressure-tested by a fresh-context agent the same way this one was.

## Risks

- The Zod adapter marks a construct `unsupported` and `nativeFormWidgets` declines the
  whole form. Task 4's test is the guard. The sheets use object, string, number, literal,
  enum, record, array, union, discriminated union, optional and default, all handled by
  `form_zod.ts`; `.regex` and `.min` are checks, not effects.
- `markdownText` normalizes a body that path.ux's parser could not map back to source
  (`unmappedRepair`). Task 9's byte-identity case catches it on `templates/basic`; a
  fixture that trips it is fixed in path.ux, not papered over in the app.
- The mdast chain grows the renderer bundle. Measured in task 1; if it is large, the
  markdown module becomes a dynamic import the Wiki pane awaits on first open.
- The jest ESM exception (D9) may not be enough for the mdast chain; the fallback is
  stated there.
- Two `zod` declaration trees (D7); the fallback is stated there.
- Autosave makes one commit per minute of typing, and the app's undo stack gains a
  snapshot per autosave. Both are accepted: the repo history is the author's own and a
  commit that says `Autosaved` is honest about being one; the undo stack is bounded
  already. If either turns out noisy in use, the tick is a constant.

## As shipped

### Task 1

- path.ux is on a branch named `pathux-rich-editor`, like the superproject, so its master
  is not advanced from here; it lands into path.ux master when this branch lands. Its
  first commit (`0c83c4cb`) adds `scripts/widgets/richtext/headless.ts`, its
  node-environment test, a paragraph in `documentation/richtext.md`, and fixes
  `ui_worker_shim.ts` to shim through `globalThis` (it wrote `window.HTMLElement`, and a
  worker has no `window`, so it threw in exactly the places it exists for; under node it
  threw before path-controller's polyfill could alias `window`).
- Five aliases, not four (D7). The mapped jest entries are `pathux-richtext-headless`,
  `-zod` and `-schema`; `-markdown` and `-forms` are unmapped.
- `zodFormSchema(characterFrontMatter)` and `zodFormSchema(locationFrontMatter)`
  type-check under tsgo with no cast, and both adapt with empty `diagnostics`; the two
  `zod` declaration trees are structurally compatible.
- Bundle: the markdown chain, the forms and the Zod adapter together are 214 kB minified,
  64 kB gzipped, measured as a chunk of their own (the proof reached them by dynamic
  import; the rest of the renderer was unchanged at 1,781 kB). Small enough to import
  statically from the Wiki pane; the dynamic-import fallback in Risks is not taken.
- `pnpm test` completes with a "worker process has failed to exit gracefully" notice that
  predates this branch.

### Task 2

- "No behaviour change" held for discovery and `checkDocWrite` and not quite for the two
  app callers, which had no conflict branch at all: `entityDiagnostic` validated a
  `characters/` sheet tagged `type: location` as a location, and `renameInText` renamed it
  as a character. Both now report the conflict — the save lands with the conflict sentence
  as its diagnostic (the sentence discovery would raise on the next load), and the rename
  is refused with it. Each has a test.
- `docKind`'s `reason` is a predicate on the document
  (`is a character by its location but declares type: location; move the file or fix the tag`),
  so every surface writes `${file} ${reason}`; the discovery diagnostic reads exactly as
  it did before.
- `DocFile.implied` is set by `readDocFile` itself rather than by `doc.read`, so the
  agent's `read_file` result carries it too.

### Task 3

- `packages/parse/src/frontmatterCodec.ts` exports `frontmatterCodec`, its
  `FrontmatterCodec` and `JsonValue` types, `isJsonObject` and `MAX_FRONT_MATTER_BYTES`;
  `frontmatter.ts` gains `frontMatterSpan`, the YAML's offsets under the app's fence,
  which the codec patches through. `FENCE`'s capture now includes the YAML's final line
  ending (the grammar is unchanged; `parseFrontMatter` is indifferent to it), so an
  appended key lands before the closer rather than a blank line before it.
- One departure from the example codec: a block collection's `range` runs through its
  final line ending, and replacing it wholesale with flow YAML would swallow the closer's
  line break, so a replacement's end is clamped to the last non-blank character. The
  example has the same hazard.
- A comment-free collection whose shape changed is rewritten whole as flow YAML (the
  example codec's rule); only a commented collection, a block scalar and a flow-map key
  change refuse. D3 said "anything else throws", which overstated it; the test states the
  rule.
- The fence-position case moved to the pane's `select` (D3), because the block source
  path.ux hands the codec never carries the file's leading blank lines.

### Task 5

- D4 contradicted itself: "a successful `save()` with no dirt left" disposed the session,
  and `wrote()` kept it so undo survives a save. The second is the rule. An entry now
  counts the buffers holding it; it is disposed when nothing holds it and it is clean, and
  a dirty one outlives its panes (autosaved by its own timer, counted by the quit guard,
  re-found by the next `open`). A pane switching tabs after a save therefore loses that
  document's undo history, which is what path.ux's note calls eviction; the alternative, a
  map that only grows, was not taken. `reload()` still disposes, and a second buffer on
  the path is told (`evicted`) and opens the path again, adopting whatever the reloading
  buffer created.
- `dirty` counts revisions (D4), so undoing back to what is on disk still reads as
  unsaved. The save then writes identical bytes, and commit-on-save records nothing for a
  record that changed nothing (`repos-and-commits.md` §Message shape). The test states it.
- `docsession.ts` owns the save (`prepareSave`, then `doc.write`), not `DocBuffer`,
  because the autosave tick has to run with no buffer holding the entry. Every holder is
  told the result, so two panes on one document both show the diagnostic, and two callers
  at once (the tick and Ctrl+S) share one attempt. `DocBuffer.save()` under `rich`
  delegates and returns whether the write landed.
- `DocBuffer` takes `{ rich?: DocumentProvider<MdDoc>; autosave?: number }` as a third
  constructor argument, and gains `close()`, `session` and `implied`. Both panes call
  `close()` when they leave the screen and `open(path)` on return (in place of
  `wrote([path])`): a text buffer's timer stops and restarts with them, and a rich one
  releases its hold. `DocIo.write` takes `auto`.
- `pnpm gen:uxmodel` produced no change, and no control changed, so the anchor sweep was
  not re-run. `pnpm gen:command-table` was, for the new prop.
- The quit guard's `window` check also tests `window.addEventListener`, because
  path-controller's headless polyfill aliases `window` to `globalThis` under node.

### Task 6

- Two path.ux commits, not one. `096b6146` is D8's: `FormControl`'s Apply, Discard,
  Validate and each Omit carry a `title`, and `forms.spec` asserts every button in a
  native form has one. `4241b7f3` fixes a bug the first bind in the app exposed: an
  embedded widget reads the editor's editable state once, when it mounts, and one mounted
  while an ancestor was disabled (the Wiki pane's first paint after the workspace loads)
  stayed locked — form boxes read-only, Apply greyed — for good. `applyEditable` now
  refreshes the widget host when `contenteditable` flips; `editor.test` covers it.
- Detached-draft recovery (D4) is not what shipped. `recoverDraft` returns a
  `FormControl`'s `{ base, edits }`, and `FormControl` has no way to take them back, so
  "the answers come back into the new control" needs a path.ux API this stage does not
  add. What the pane does instead: while the session holds a detached draft the footer
  says so and shows **Discard pending edits**, which runs `discardDraft` on each. A save
  is refused until then, with the sentence `docsession.ts` gives. Recovery into a new
  control goes to stage 2, with a `FormControl.restore` in path.ux. The case itself is
  rare: a control is disposed with typed answers only when its block is replaced under it,
  which one pane's raw commit does to the other pane's form.
- The Discard control is recorded as `pane.view(what='reload')` with `on: 'discard'`,
  because the closed effect vocabulary has nothing closer and the control changes what the
  pane shows without touching the project. `rules/wiki.ts` gains `discardOffer` and
  `WikiState.detached`; the `open-detached` situation joins `ux-model.json`.
- D1's filter is a `picked` field the pane's `select` sets (`note`, `sheet`, `conflict`)
  and a `codec.read` wrapper resets, since path.ux reads before it selects on every
  resolve; `onDiagnostic` is dropped only when the last answer was `note`.
- The blank-line-before-the-fence case says
  `Not front matter: the fence must open at the first line` in the footer and keeps the
  raw block, from the pane's `select` over `retainedSource.prefix` (D3).
- `viewState` across a `wrote()` swap is remapped by block index and clamped to the new
  block's text, because block ids are fresh per parse; a block the new document lacks
  drops the selection and keeps the scroll.
- The rich editor's host element is the `textBox` anchor (D8), recorded on every paint
  like the textarea was; its `keydown` stops propagation and takes Ctrl+S, as the textarea
  did.
- Verified over CDP against a copy of `templates/basic`: a form edit to `name:` patches
  one line and saves as a one-line commit; the session survives its own save, so undo
  still works after it; a note keeps its raw block with no note; an `entity_tag_conflict`
  sheet keeps its raw block with the conflict sentence; a blank line before `---` keeps
  the raw block with the fence sentence.

### Task 7

- The switch is a bar button acted on every paint, like Save, labelled with the view a
  press shows (`Raw` in the rich view, `Rich` in the raw one) because the tooltip
  describes that view. `rawOffer(raw, path)` in `rules/wiki.ts` is the offer:
  `pane.view(what='mode')` with `on: 'raw'`, refused with nothing open. The text box is
  recorded on whichever element is up, the editor with `TEXT_TIP` or the textarea with
  `RAW_TIP`.
- The draft is a `RawDraft` class in `wiki.ts`, per mount, rather than closures over pane
  fields as in `forms_demo.ts`. It keeps the typed text itself, so when the textarea moves
  on to another document the draft stays pending on the old session, detached, with
  `recover()` still answering — the same shape as a closed form's answers, and the same
  footer sentence and Discard control apply when the document is shown again. Closures
  over the pane's fields would have made a detached draft read as clean the moment the
  pane refilled, leaving a session neither dirty nor disposed.
- Staleness is by session revision rather than by re-serializing the document: the draft
  records the revision it was filled at, and `prepare` reports `conflict` (with the footer
  sentence as its `reason`) when the revision moved. The footer shows the same sentence
  and the Discard control while the raw view holds typed text behind such a move, through
  `WikiState.stale`, so a raw-view conflict has a way out that is not Reload.
  `discardOffer(detached, stale)` names whichever it is dropping.
- Rich → raw and raw → rich both run `prepareSave()` first, as D5 says; a refusal leaves
  the view up and puts `refusalOf`'s sentence (now exported from `docsession.ts`) in the
  footer. Switching documents in a raw pane also runs `prepareSave()` on the one leaving,
  so typed source is saved with its document instead of detaching; a refusal there
  detaches it. The raw view is off for the document arriving (`rawPath`), per D5's
  "default off on every open".
- A commit of the typed source hands the textarea the same text back, and the refill
  assigns `value` only when it differs, because an assignment moves the caret to the end —
  an autosave tick mid-sentence would otherwise throw the author to the bottom.
- Verified over CDP: raw shows the source with the fence; a typed change becomes one
  revision on the way back and one undo step in the rich view; an edit under a dirty raw
  view shows the stale sentence and the Discard control, the switch is refused with the
  text intact, and Discard refills; Ctrl+S in the raw view commits the draft and saves
  without replacing the session; leaving for another document applies the typed source,
  the new document opens rich, and the old one is found dirty on return with no detached
  draft.

## Pressure-test findings

A fresh-context reviewer read the first draft against the code on 2026-09-19. What it
found, and what changed:

- **`select` cannot report a conflict by returning `undefined`; it must throw.** Fixed in
  D1.
- **`presentation` cannot come from TS doc comments; `zodFormSchema` reads `.describe()`
  only.** Fixed in D6: hand-written presentation in `docforms.ts`.
- **`control: 'json'` is a no-op on record / array / union nodes.** Fixed in D6.
- **The precedence rule is already spelled three ways in the app.** D1 now introduces one
  resolver and rewrites the three callers, and keeps the path convention in `@vn/store`
  rather than moving it into `@vn/types` (the reviewer's "expensive to undo" point).
- **`packages/types/src/entities.ts` already exists.** D1 names `schemas.ts` instead.
- **`examples/` is gitignored; only `templates/basic` is a fixture.** Fixed in D3, task 9.
- **`markdown.ts` does not export the form or source helpers; the pathux-types build
  reaches none of them.** D7 now lists four entry points and the `files` rows.
- **`@vn/parse` needs no `tsconfig` path.** Fixed in D3.
- **path.ux's fence grammar is looser than `@vn/parse`'s.** D3 now pins the codec to the
  app's grammar so the form never applies where `doc.write` sees no front matter.
- **The pane has no Undo control to tooltip.** Removed.
- **The Wiki section is in `desktop-app-editors-misc.md`.** Fixed in task 10.
- **`save()` refuses on `!isDirty` before `prepareSave` could run, and a form draft does
  not make the session dirty.** D4 now defines `dirty` to include pending drafts and runs
  `prepareSave` first.
- **The raw view had two commit paths (a setter and a draft).** D4 drops the setter.
- **Form drafts were lost on a pane switch, contradicting "no silent discard".** D4 now
  keys sessions per document (which the reviewer also asked for on two-panes grounds and
  path.ux's note asks for), recovers detached drafts on re-mount, and adds a Discard
  control for the rest.
- **Serializing on every `onChange` was unweighed.** D4 serializes on demand only.
- **`wrote()` replacing the session resets the caret and leaks the old session.** D4 now
  disposes and restores `viewState`.
- **`VN_RICH_WIKI=1` has no reach in a vite bundle.** Task 1 no longer gates a UI change;
  it ships proofs only.
- **Two `zod` declaration trees.** D7 states it and the fallback.
- **The codec needs `widgetJson`'s limits without importing it.** D3 states the
  duplication.
- **What the rich root records for `supplies: text`.** D8: one control, the `textBox`
  offer, text read from the session.
- **Which effect the Raw toggle records.** D5: `pane.view(what='mode')`.
- **Toolbar and form buttons run neither commands nor effects and cannot be wrapped by
  `act()`.** D8 records the editor the way a text box is recorded — one control with its
  own history — and lists the commit points the app does own; tooltips are still required,
  hence the path.ux commit.
- **`saveUIData` persists into the layout.** D5 keeps the toggle in memory.
- **Every note would flood the footer with "No form schema selected".** D1 filters by
  kind.
- **Form-then-raw draft ordering in `prepareSave`.** D5: never both in one pane; across
  panes the later editor sees `conflict`, which is correct.
- **`addFrontmatter` is neither wired nor excluded.** D2 excludes it and says why.
- **Node-only jest cannot run the session tests or any pane test as written.** D9 is new.
- **The plan was missing from `docs/plans/index.md`.** Added with this revision.
- **Reversing "not a form over `Character`" silently.** Stated in Goal and task 10.
- **Lint does not enforce the renderer / `@vn/store` boundary.** Stated in D8.
- Recorded and left alone: `.regex` on `hexColor` is a check (the reviewer confirmed the
  adapter handles every construct used); `docKind`'s string-tagged union is the shape
  `DocResult` already uses.
