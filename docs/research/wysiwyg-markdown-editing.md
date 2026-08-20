# WYSIWYG markdown editing in the wiki pane

_Investigation. Not a plan — no steps, no waves committed to. It surveys what could replace the
`<textarea>` in the Wiki editor with a richer editing surface, and prices each candidate against
the constraints that pane already carries._

_Status: **nothing built, and nothing decided.** The Wiki editor ships the plain textarea described
in [`../reference/desktop-app.md`](../reference/desktop-app.md). CodeMirror 6 is the current favourite on the strength
of the round-trip argument below, but it has not been chosen — the open questions at the end are
real, and two of them could still move the verdict._

<!-- toc -->

- [The question](#the-question)
- [The fault line](#the-fault-line)
- [The constraints any candidate inherits](#the-constraints-any-candidate-inherits)
- [The options](#the-options)
  * [Tier 1 — the buffer stays authoritative](#tier-1--the-buffer-stays-authoritative)
  * [Tier 2 — real WYSIWYG, accepting a serializer](#tier-2--real-wysiwyg-accepting-a-serializer)
  * [Rejected outright](#rejected-outright)
- [What each costs](#what-each-costs)
- [Where this stands](#where-this-stands)
- [Open questions](#open-questions)

<!-- tocstop -->

## The question

The Wiki editor (`apps/desktop/renderer/pathux/editors/wiki.ts`) shows one markdown document — the
story bible, a character sheet, a location sheet — as raw text in a `<textarea>`. It works, and the
plumbing around it is settled: `doc.read` / `doc.write`, a content hash that refuses a file
something else rewrote underneath, a draft map that survives a pane switch, a `beforeunload` guard.
None of that is in question here.

What is in question is the surface. An author writing prose in a story bible is not editing code,
and asking them to read `##` and `**` while they do it is a real cost. The obvious move is a WYSIWYG
markdown editor. The purpose of this document is to establish what that would actually cost, because
the answer is not "pick a library" — the pane sits behind an invariant that most of the field
violates.

## The fault line

**A true WYSIWYG editor parses markdown into a document model and serializes it back.** That is the
definition, and it is also the problem. Every markdown serializer normalizes: `*` bullets become
`-`, setext headings become ATX, hard-wrapped paragraphs get reflowed onto one line,
`_emphasis_` becomes `*emphasis*`, and punctuation gets defensively escaped. The output is
*equivalent* markdown. It is not the *same* markdown.

For this repo that is not a cosmetic complaint, because three shipped decisions depend on the bytes:

- **`doc.write` refuses by content, not mtime.** A serializer that rewrites a file on open makes the
  hash the author read at describe a document nobody wrote.
- **Front-matter is spliced byte-exactly.** A model that round-trips the whole file has to hold the
  front-matter out of the parse or destroy it, and holding it out means the pane no longer shows the
  author what the file says — which is the requirement the current editor's doc comment states
  outright ("it is **not** a form over `Character`").
- **`vngen/` is committed and the Committer stamps provenance.** Opening a page and fixing one typo
  would produce a whole-file diff attributed to an authored edit. Git history stops being evidence.

There is a fourth cost that is harder to measure and probably larger: markdown-as-a-document-model is
lossy in the other direction too. Anything the schema has no node for — an HTML block, a footnote, a
`[[line:]]` marker, a table the schema didn't anticipate — either round-trips as an opaque blob or
silently disappears. The author finds out when it disappears.

So the field splits in two, and the split is more important than any individual library.

## The constraints any candidate inherits

Beyond the round-trip question, the pane is not a blank slate:

| Constraint | Consequence |
| ---------- | ----------- |
| The renderer is a path.ux screen mesh; **there is no React** | Rules out anything whose only supported binding is a React component. Vanilla or framework-agnostic core only. |
| Surfaces mount in a **shadow root** via `VnEditor.appendSurface` | Selection and focus APIs must work under a shadow root (`shadowRoot.getSelection()` is Chromium-only, which Electron is). This is where editors that "support" shadow DOM tend to be quietly broken. |
| Styles arrive through `adoptStyle`, and **`tokens.css` is the design contract** | A library shipping global CSS and its own accent hues fights the contract. `--sodium` authored, `--signal` machine, no new hues. |
| The screen keymap is a **bubble-phase window listener** | Any surface must `stopPropagation` on its own keydown, exactly as the textarea does today, or the first `/` of a sentence opens the palette. |
| `src/shared/` is in the browser bundle and must stay **node-free** | Only bites if editor glue lands in `shared/`; worth stating because neither `tsgo` pass catches a violation. |
| Electron, offline, ESM, `verbatimModuleSyntax` | No CDN loading, no CommonJS-only packages, explicit `.js` on relative paths. |
| The desktop jest project is **node-only** | The surface cannot be unit-tested. Pure logic goes in a `.ts` with a `tests/` sibling; the surface itself is verified live over CDP. |

## The options

### Tier 1 — the buffer stays authoritative

These do not have a serializer. The text in the editor *is* the file, and round-trip risk is exactly
zero.

**A. CodeMirror 6 with a decoration layer.** The Obsidian "Live Preview" / Bear / iA Writer model:
markdown source in the buffer, decorated by a `ViewPlugin` reading `syntaxTree` — headings render
large, emphasis renders emphasized, the `**` markers hide unless the cursor is on that line, images
and tables can become widgets. Serialization is the identity function. ESM, framework-agnostic, and
CodeMirror has genuine shadow-root support (`new EditorView({root: shadowRoot})`) plus its own style
injection, which is the piece most libraries get wrong. The decoration layer is code we write and
own; there is no off-the-shelf "make it look like Obsidian" extension.

**B. Split source + preview.** A textarea beside a rendered pane, using `marked` — which path.ux
already vendors in `simple_docsys`. Not WYSIWYG, and it halves the horizontal space in a pane that
may already be narrow. It is an afternoon of work and captures a real fraction of the value for a
story bible. It belongs in the list as the honest baseline any richer option has to beat.

**C. A block editor on the path.ux line-list model.** The Script editor already "edits a list of
lines, not a buffer", and the chunked prompt editor landed on the same idea. A markdown pane built
that way re-serializes only the blocks the author touched, so untouched prose stays byte-identical —
the best fidelity of any WYSIWYG-shaped option, and the most consistent with how this codebase
already thinks. It is also, by a wide margin, the most work: block parsing, block serialization,
caret movement across block boundaries, selection spanning blocks, paste.

### Tier 2 — real WYSIWYG, accepting a serializer

| Option | Shape | Assessment |
| ------ | ----- | ---------- |
| **ProseMirror** + `prosemirror-markdown` | Vanilla ESM, assembled by hand | The serious one. Genuine WYSIWYG, no framework, smallest of the tier. `prosemirror-markdown` is explicitly a lossy projection — the docs say so — and its schema is a starting point you extend. Shadow DOM works in Chromium. |
| **Milkdown** | ProseMirror + remark, plugin-based | Batteries included (tables, slash menu, math), framework-agnostic core. Remark round-trip is the best of this tier, and remark is extensible enough to teach about `[[line:]]`. Heaviest dependency tree, and the plugin surface is a lot to adopt for one pane. |
| **TipTap** | ProseMirror wrapper | `@tiptap/core` runs vanilla, but its native currency is HTML; markdown is an add-on. Wrong direction — we would be converting md → HTML → md. |
| **Lexical** | Meta's editor, vanilla core | `@lexical/markdown` gives typing shortcuts and transformers, and the core is genuinely framework-agnostic. Historically the weakest shadow-DOM story of this group, which is the one thing we cannot compromise on. |
| **Toast UI Editor** | Turnkey, zero-framework, dual-mode | Ships a complete toolbar and a whole visual identity in global CSS. Fastest route to a working demo; worst fit for `tokens.css` and the shadow-root sheet discipline. |

### Rejected outright

- **EasyMDE / SimpleMDE** — CodeMirror 5-era, and they only do toolbar + preview, not WYSIWYG. The
  editor underneath is a generation behind option A with none of its ceiling.
- **A hand-rolled `contenteditable`** — the failure mode is not "it takes a while", it is IME,
  selection across block boundaries, undo, and paste, each of which is a multi-month problem that
  ProseMirror and CodeMirror exist to have already solved.

## What each costs

Measured, not quoted from memory: each configuration bundled with `esbuild --bundle --minify
--format=esm --target=chrome120`, in a throwaway project outside the repo. Brotli at default
quality. Versions as installed on 2026-08-15: `@codemirror/state` 6.7.1, `@codemirror/view` 6.43.8,
`@codemirror/language` 6.12.4, `@codemirror/commands` 6.10.4, `@codemirror/lang-markdown` 6.5.2,
`@codemirror/language-data` 6.5.2, `codemirror` 6.0.2, `prosemirror-markdown` 1.13.5,
`prosemirror-view` 1.42.2, `@toast-ui/editor` 3.2.2.

| Configuration | Minified | Brotli |
| ------------- | -------: | -----: |
| CodeMirror core (`state` + `view` + `commands`) | 262 KB | 74 KB |
| **CodeMirror + `lang-markdown` + `language`** — what option A needs | **489 KB** | **144 KB** |
| CodeMirror `basicSetup` meta-package + markdown | 595 KB | 171 KB |
| CodeMirror + `language-data`, bundled eagerly | 1,626 KB | 444 KB |
| ProseMirror + `prosemirror-markdown` | 352 KB | 99 KB |
| Toast UI Editor | 565 KB | 147 KB |

For scale, the renderer shell as built today (`apps/desktop/dist/renderer/assets/shell-*.js`) is
**1,051 KB**. Option A is therefore about **+47%** on the shell bundle, if it is imported eagerly.

Three findings from those numbers:

**Markdown costs more than the editor does.** CodeMirror's core is 262 KB; `lang-markdown` nearly
doubles it, because the Lezer markdown grammar pulls in the HTML grammar (markdown embeds HTML),
which pulls in JS and CSS. That is mostly unavoidable cost — it is the same parse tree the
decorations read from.

**`basicSetup` is a trap in miniature.** It is the 106 KB between rows two and three, and it buys
search panels, autocomplete, lint gutters, line numbers and code folding: none of which belong in a
prose pane, all of which would fight `tokens.css`. Compose the extensions by hand.

**`language-data` is the big trap, and it is avoidable.** Bundled eagerly it is 1.6 MB, but it is
written as dynamic imports — a real Vite build splits it into ~124 lazy chunks that load only when a
document actually contains a fenced block of that language. Either omit `codeLanguages` entirely, or
pass a hand-picked list (`yaml`, `json`) and pay tens of kilobytes instead of a megabyte.

**And in an Electron app the compressed column barely matters.** These load from local disk, so what
is actually being spent is parse/compile time on a local file — single-digit milliseconds — and only
if it lands in the startup chunk. A dynamic `import()` inside `WikiEditor.init()` keeps it out of the
shell entirely, since the pane can render its "No document selected" state before the module
resolves.

## Where this stands

**CodeMirror 6 with a hand-written decoration layer (option A) is the leading candidate**, on two
grounds. It is the only option that gives a rich surface without putting a normalizing serializer in
front of files whose bytes are load-bearing, and its shadow-root and style-isolation story matches
how `VnEditor` already mounts surfaces. Under it, `doc.read` / `doc.write`, `seenHash`, the draft map
and the `beforeunload` guard are all untouched — only `this.text` changes.

ProseMirror is the fallback if the decoration approach turns out to feel like a text editor wearing a
costume. It is 140 KB smaller, and that saving buys a serializer that rewrites the author's files —
a trade this document argues against but does not consider closed.

**This is a leaning, not a decision.** Nothing has been prototyped, and the sections below are why.

## Open questions

1. **Does a decoration layer actually feel like WYSIWYG?** This is the question that decides between
   tiers, and it cannot be answered on paper. A spike in the wiki pane — headings, emphasis, links,
   marker hiding — would answer it in a day or two. Everything else here is secondary to it.
2. **Where does the front-matter go?** In the box (as today, matching the editor's stated
   requirement), or held out in a fielded header with the prose below? Option A can fence it as a
   non-decorated region cheaply; the tier-2 options mostly have to hold it out. The answer may be
   different for a character sheet than for a free-form wiki page, which would be an argument for a
   per-document-kind decision rather than a per-editor one.
3. **Does the wiki pane's answer bind the other prose panes?** The Script editor and the chunked
   prompt editor already have their own list-of-lines surfaces. If option C is ever the answer for
   them, adopting a second editing stack for the wiki is a cost this document has not priced.
4. **How much of the value is in the preview rather than the editing?** If a split preview (option B)
   gets most of the way for an afternoon's work, it is the correct first move regardless of which
   candidate eventually wins — and it would put a rendered view in front of the author while the
   spike in question 1 runs.
5. **How is any of this tested?** The desktop jest project is node-only, so a surface is verified
   live over CDP. Decoration logic can be factored into a pure `.ts` with a `tests/` sibling; how
   much of it factors out cleanly is unknown until the spike.
