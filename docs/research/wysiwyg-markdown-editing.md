# WYSIWYG markdown editing in the wiki pane

_This document is an investigation rather than a plan, so it commits to no steps and no waves. It surveys the
candidates that could replace the `<textarea>` in the Wiki editor with a richer editing surface, and evaluates each
one against the constraints that already apply to that pane._

_Status: nothing is built and nothing is decided. The Wiki editor ships the plain textarea described in
[`../reference/desktop-app.md`](../reference/desktop-app.md). CodeMirror 6 is the current favourite on the strength of
the round-trip argument below, but it has not been chosen. The open questions at the end are real, and two of them
could still change the choice._

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

The Wiki editor (`apps/desktop/renderer/pathux/editors/wiki.ts`) shows one markdown document (the story bible, a
character sheet, or a location sheet) as raw text in a `<textarea>`. It works, and the plumbing around it is settled.
That plumbing is `doc.read` and `doc.write`, a content hash that refuses a file something else rewrote underneath, a
draft map that survives a pane switch, and a `beforeunload` guard. None of that is in question here.

The editing surface is in question. An author writing prose in a story bible is not editing code, and asking them to
read `##` and `**` while they do it is a real cost. A WYSIWYG markdown editor is the obvious choice. This document
establishes what a WYSIWYG editor would actually cost, because the answer is not "pick a library": the pane must
satisfy an invariant that most of the field violates.

## The fault line

A true WYSIWYG editor parses markdown into a document model and serializes it back. That round trip is the source of
the problem. Every markdown serializer normalizes: `*` bullets become `-`, setext headings become ATX, hard-wrapped
paragraphs get reflowed onto one line, `_emphasis_` becomes `*emphasis*`, and punctuation gets defensively escaped.
The output is equivalent markdown, not the same markdown.

That is not a cosmetic complaint in this repo, because three shipped decisions depend on the bytes:

- **`doc.write` refuses by content, not mtime.** A serializer that rewrites a file on open changes the file's
  content, so the hash the author read at describe time describes a document nobody wrote.
- **Front-matter is spliced byte-exactly.** A model that round-trips the whole file must either hold the
  front-matter out of the parse or destroy it. Holding it out means the pane no longer shows the author what the file
  says. The current editor's doc comment states that requirement outright: "it is **not** a form over `Character`".
- **`vngen/` is committed and the Committer stamps provenance.** Opening a page and fixing one typo would produce a
  whole-file diff attributed to an authored edit. Git history no longer shows which lines a person edited.

There is a fourth cost that is harder to measure and probably larger: using markdown as the document model loses
information in the other direction too. Anything the schema has no node for (an HTML block, a footnote, a `[[line:]]`
marker, a table the schema didn't anticipate) either round-trips as an opaque blob or disappears without warning. The
author learns of the loss only after the content is gone.

So the field splits in two, and this split matters more than any individual library.

## The constraints any candidate inherits

Beyond the round-trip question, the pane does not start empty:

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

These do not have a serializer. The text in the editor is the file, so there is no round-trip risk.

**A. CodeMirror 6 with a decoration layer.** Obsidian "Live Preview", Bear, and iA Writer follow this model. The
buffer holds markdown source, and a `ViewPlugin` reading `syntaxTree` decorates it: headings render large, emphasis
renders emphasized, the `**` markers hide unless the cursor is on that line, and images and tables can become widgets.
Serializing returns the buffer unchanged. CodeMirror ships as ESM, is framework-agnostic, and has genuine shadow-root
support (`new EditorView({root: shadowRoot})`) plus its own style injection, which is the piece most libraries get
wrong. We write and own the decoration layer; there is no off-the-shelf "make it look like Obsidian" extension.

**B. Split source + preview.** Places a textarea beside a rendered pane and renders with `marked`, which path.ux
already vendors in `simple_docsys`. It is not WYSIWYG, and it halves the horizontal space in a pane that may already
be narrow. It takes an afternoon of work and captures a real fraction of the value for a story bible. It belongs in
the list as the baseline that richer options must improve on.

**C. A block editor on the path.ux line-list model.** The Script editor already "edits a list of lines, not a buffer",
and the chunked prompt editor uses the same model. A markdown pane built that way re-serializes only the blocks the
author touched, so untouched prose stays byte-identical. That gives it the best fidelity of any WYSIWYG-shaped option,
and it matches a model this codebase already uses elsewhere. It is also the most work by a wide margin: block parsing,
block serialization, caret movement across block boundaries, selection spanning blocks, paste.

### Tier 2 — real WYSIWYG, accepting a serializer

| Option | Shape | Assessment |
| ------ | ----- | ---------- |
| **ProseMirror** + `prosemirror-markdown` | Vanilla ESM, assembled by hand | The serious one. Genuine WYSIWYG, no framework, smallest of the tier. `prosemirror-markdown` is explicitly a lossy projection — the docs say so — and its schema is a starting point you extend. Shadow DOM works in Chromium. |
| **Milkdown** | ProseMirror + remark, plugin-based | Batteries included (tables, slash menu, math), framework-agnostic core. Remark round-trip is the best of this tier, and remark is extensible enough to teach about `[[line:]]`. Heaviest dependency tree, and the plugin surface is a lot to adopt for one pane. |
| **TipTap** | ProseMirror wrapper | `@tiptap/core` runs vanilla, but its native currency is HTML; markdown is an add-on. Wrong direction — we would be converting md → HTML → md. |
| **Lexical** | Meta's editor, vanilla core | `@lexical/markdown` gives typing shortcuts and transformers, and the core is genuinely framework-agnostic. Historically the weakest shadow-DOM story of this group, which is the one thing we cannot compromise on. |
| **Toast UI Editor** | Turnkey, zero-framework, dual-mode | Ships a complete toolbar and a whole visual identity in global CSS. Fastest route to a working demo; worst fit for `tokens.css` and the shadow-root sheet discipline. |

### Rejected outright

- **EasyMDE / SimpleMDE** — both date from the CodeMirror 5 era, and both provide only a toolbar and a preview, not
  WYSIWYG. The editor underneath is a generation behind option A and offers none of its room to grow.
- **A hand-rolled `contenteditable`** — the difficulty is not the time it takes. IME, selection across block
  boundaries, undo, and paste are each a multi-month problem, and ProseMirror and CodeMirror already solve them.

## What each costs

Each number here was measured rather than quoted from memory. Each configuration was bundled with `esbuild --bundle
--minify --format=esm --target=chrome120`, in a throwaway project outside the repo, and compressed with Brotli at
default quality. The versions installed on 2026-08-15 were `@codemirror/state` 6.7.1, `@codemirror/view` 6.43.8,
`@codemirror/language` 6.12.4, `@codemirror/commands` 6.10.4, `@codemirror/lang-markdown` 6.5.2,
`@codemirror/language-data` 6.5.2, `codemirror` 6.0.2, `prosemirror-markdown` 1.13.5, `prosemirror-view` 1.42.2, and
`@toast-ui/editor` 3.2.2.

| Configuration | Minified | Brotli |
| ------------- | -------: | -----: |
| CodeMirror core (`state` + `view` + `commands`) | 262 KB | 74 KB |
| **CodeMirror + `lang-markdown` + `language`** — what option A needs | **489 KB** | **144 KB** |
| CodeMirror `basicSetup` meta-package + markdown | 595 KB | 171 KB |
| CodeMirror + `language-data`, bundled eagerly | 1,626 KB | 444 KB |
| ProseMirror + `prosemirror-markdown` | 352 KB | 99 KB |
| Toast UI Editor | 565 KB | 147 KB |

For scale, the renderer shell as built today (`apps/desktop/dist/renderer/assets/shell-*.js`) is 1,051 KB. Option A
therefore adds about 47% to the shell bundle if it is imported eagerly.

Those numbers support three findings:

Markdown costs more than the editor does. CodeMirror's core is 262 KB; `lang-markdown` nearly doubles it, because the
Lezer markdown grammar pulls in the HTML grammar (markdown embeds HTML), which pulls in JS and CSS. That cost is
mostly unavoidable, because the decorations read from the same parse tree.

`basicSetup` accounts for the 106 KB between rows two and three. It adds search panels, autocomplete, lint gutters,
line numbers and code folding. None of these belong in a prose pane, and each of them conflicts with `tokens.css`.
Compose the extensions by hand.

`language-data` costs 1.6 MB when bundled eagerly, and that cost is avoidable. It is written as dynamic imports, so a
real Vite build splits it into ~124 lazy chunks that load only when a document contains a fenced block of that
language. Either omit `codeLanguages` entirely, or pass a hand-picked list (`yaml`, `json`) and pay tens of kilobytes
instead of a megabyte.

The compressed column barely matters in an Electron app. The modules load from local disk, so the cost is
parse/compile time on a local file (single-digit milliseconds), and only if a module lands in the startup chunk. A
dynamic `import()` inside `WikiEditor.init()` keeps it out of the shell entirely, since the pane can render its "No
document selected" state before the module resolves.

## Where this stands

CodeMirror 6 with a hand-written decoration layer (option A) is the leading candidate, on two grounds. It is the only
option that gives a rich surface without putting a normalizing serializer in front of files whose exact bytes matter,
and its shadow-root and style-isolation behavior matches how `VnEditor` already mounts surfaces. Choosing option A
leaves `doc.read` / `doc.write`, `seenHash`, the draft map and the `beforeunload` guard untouched, and changes only
`this.text`.

ProseMirror is the fallback if the decoration approach turns out to behave too much like a text editor. ProseMirror is
140 KB smaller, but it requires a serializer that rewrites the author's files. This document argues against that trade
but does not treat the question as closed.

What follows is a leaning rather than a decision. Nothing has been prototyped, and the sections below give the
reasons.

## Open questions

1. 1. **Does a decoration layer actually feel like WYSIWYG?** This question decides between tiers, and no one can
   answer it on paper. A spike in the wiki pane (headings, emphasis, links, marker hiding) would answer the question
   in a day or two. Every other item here is secondary to that answer.
2. 2. **Where does the front-matter go?** It can stay in the box, as it does today and as the editor's stated
   requirement demands, or it can be held out in a fielded header with the prose below. Option A can cheaply fence it
   as a non-decorated region, while the tier-2 options mostly have to hold it out. The answer may be different for a
   character sheet than for a free-form wiki page, and a difference of that kind argues for a per-document-kind
   decision rather than a per-editor one.
3. 3. **Does the choice made for the wiki pane apply to the other prose panes?** The Script editor and the chunked
   prompt editor already have their own list-of-lines surfaces. If option C turns out to be right for them as well,
   this document does not estimate the cost of adopting a second editing stack for the wiki.
4. 4. **How much of the value is in the preview rather than the editing?** If a split preview (option B) gets most of
   the way for an afternoon's work, it is the correct first move regardless of which candidate eventually wins. It
   also puts a rendered view in front of the author while the spike in question 1 runs.
5. 5. **How is this tested?** The desktop jest project is node-only, so a surface is verified live over CDP.
   Decoration logic can be factored into a pure `.ts` with a `tests/` sibling. How much of that logic factors out
   cleanly is unknown until the spike.
