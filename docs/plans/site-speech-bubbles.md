# Speech bubbles on the published web site

Status: shipped 2026-09-19. Written 2026-09-19.

The GitHub Pages workflow the app installs (`.github/workflows/vn-pages.yml`) renders a
project with `.vnstudio/pages/vn-site.mjs`, which is `packages/export/src/site-cli.ts`
bundled over `renderSite` in `packages/export/src/site.ts`. That renderer currently
ignores everything a page shot carries beyond its image: `panels`, each panel's `lines`,
and the `bubbles` the author placed under `lettering: runner`. A published manga page
therefore comes out wordless, with its dialogue printed as paragraphs underneath. This
plan draws the bubbles on the site, the way the desktop Play pane does, and nothing else
of the Play pane's page treatment — in particular, it never dims the page.

## What the Play pane does today

The reference behaviour, from `apps/desktop/renderer/pathux/editors/play.ts` (`speak`) and
`apps/desktop/renderer/pathux/play/playback.ts` (`framesOf`):

- A `say`/`narrate` beat whose `line` has a bubble on the current page's panel gets
  `Frame.bubble = { anchor, tail? }`. The line is drawn in the bubble and the dialogue box
  is left out for that frame. A line with no bubble keeps the box.
- The bubble is a `<div>` over the picture: paper `TOKENS.paper` (`#e8e6df`) at
  `BUBBLE_PAPER` (0.92), text in `TOKENS.ink` (`#0e1116`), `TOKENS.prose` type, 15px /
  1.35, padding `8px 13px`, `max-width: 44%`, centred text, `border-radius` 16px with a
  tail and 4px without (a caption box), shadow `0 1px 4px` ink at 0.35. It shows the text
  only, no speaker name.
- Position is in the picture's pixels: the bubble is centred on `anchor`, then clamped so
  it stays `BUBBLE_MARGIN_PX` (6px) inside the picture. The tail is an SVG polygon whose
  base (`TAIL_HALF_PX` = 9px half-width) is centred under the bubble's post-clamp centre
  and whose point is at `tail`. Everything is refitted on resize.
- Separately, `lightPanel` dims the page around the lit panel when **Dim panels** is on.
  That part is out of scope here.

## Decisions

- **Where.** All of it lands in `renderSite` and its stylesheet, so it reaches the
  workflow through the existing `scripts/esbuild.sitebuilder.mjs` bundle. No change to
  `site-cli.ts`, the workflow template, or `project.installPages`. An author who already
  installed the builder sees **Update GitHub Page Builder…** the next time they open the
  menu, because `project.pagesStatus` compares the installed bytes against the running
  build's; that is the existing mechanism and needs no work.
- **Data.** A `show` beat with `panels` may carry `panels[].bubbles[]` of
  `{ line, anchor, tail? }`. The bubble holds no text: the renderer finds the text in the
  `say`/`narrate` beat with that `line` among the beats that follow the `show`, up to the
  next `show`. That group is well-formed by construction: `sceneBeats`
  (`packages/export/src/playable.ts`) emits a `show` whenever the covering shot changes
  and then the beats of the lines that follow under that shot, in line order. Coverage is
  a set rather than a range (`packages/scriptedit/src/coverage.ts`), so one page can
  appear several times in a scene — a page covering lines 1 and 3 while another shot
  covers line 2 emits `show A, L1, show B, L2, show A, L3`, each `show A` carrying the
  full `panels[].bubbles`. Each occurrence of the figure draws the bubbles of the lines
  read over that occurrence and no others, which is what the Play pane shows for those
  frames too; the picture itself is repeated, as it is today. Matching follows
  `framesOf`'s rule exactly: the panel whose `lines` include the beat's `line`, then that
  panel's `bubbles`, rather than scanning every panel's bubbles by line. A `transition`
  line is covered but produces no beat (`playable.ts`, `line.kind === 'transition'`), and
  `setBubbles` refuses a line the page does not letter, so a bubble on a transition should
  not exist; if one does, the "no beat before the next `show`" rule below skips it.
  `buildPlayable` emits bubbles only under `lettering: runner`, so the site never needs to
  know the lettering mode; a page rendered under `model` arrives with no bubbles and
  renders exactly as today.
- **A page with no image draws no bubbles.** `renderBeat` already renders an imageless
  `show` as nothing. When such a `show` carries bubbles, every bubble is treated as absent
  and every line flows as a paragraph, so a half-generated project still reads rather than
  losing its bubbled lines along with the missing picture.
- **A bubbled line leaves the text flow.** The Play pane hides the dialogue box for a
  frame read in a bubble, and the site does the same: a `say`/`narrate` beat whose line
  has a bubble is drawn in the bubble inside the `<figure>` and is not emitted as a
  `.say`/`.narrate` paragraph. A line with no bubble flows as a paragraph as before, so a
  half-lettered page still reads, and nothing places a bubble the author did not. The
  words are still on the page, in the bubble element, so search and screen readers keep
  them.
- **Every bubble of a figure shows at once.** A static page has no stepping. This is the
  one place the site departs from the Play pane by design, and it is what a printed manga
  page does anyway. The cost is size: the site's body is `max-width: 42rem`, so the
  picture is at most about 670px wide and about 340px on a phone, and several 15px bubbles
  at `max-width: 44%` of that will cover more art than one bubble at a time does in a
  wider pane. Accepted as the starting point, because it is the Play pane's own sizing;
  step 4 checks a page at phone width, and if the bubbles are unreadable there the fix is
  `font-size: clamp(11px, 2.4cqw, 15px)` under `container-type: inline-size` on the
  figure, recorded here so it is not re-derived.
- **No dim, no panel outlines.** `panels[].shape` stays unread. The site draws no overlay
  from it and nothing darkens any part of the picture.
- **Look.** The bubble's colours are fixed rather than the site's `--paper`/`--ink`
  tokens: paper `#e8e6df` at 0.92 and ink `#0e1116`, whatever the reader's colour scheme,
  because the bubble sits on a picture and the picture does not change with the scheme
  (the Play pane's tokens are fixed the same way). Type is the site's body serif at 15px /
  1.35, everything else as listed above. A bubble with a `tail` gets the 16px radius and
  the wedge; one without is a caption box with the 4px radius and no wedge. Two bubbles
  whose anchors coincide overlap, as they do in the Play pane; nothing de-overlaps them.
- **The speaker.** A bubble shows the text only, as the Play pane's does. The speaker's
  display name is still in the markup, as a visually hidden `<span class="who">` at the
  start of the bubble, the same shape the `.say` paragraph already uses, so a screen
  reader hears "Aiko" then the line while a sighted reader sees the bubble alone. Not an
  `aria-label`: on a `<div>`/`<p>` with visible text an `aria-label` either replaces the
  text or is ignored, depending on the reader.
- **Position.** Two writers, one source: the renderer formats the anchor and tail once,
  with `toFixed(4)`, and writes the anchor both into the bubble's `style` as
  `left: <ax>%; top: <ay>%` and into `data-ax`/`data-ay` (and the tail into
  `data-tx`/`data-ty`). CSS adds `transform: translate(-50%, -50%)`, so with no script the
  bubble is centred on its anchor. The edge clamp and the tail both need the bubble's
  rendered size, so each page that carries at least one bubble also carries one short
  inline `<script>` (no `src`, no request, plain `<script>` with no `type`, at the end of
  `<body>`) that does what the Play pane's `fit()` does. It reads the `data-` attributes,
  clamps the bubble's _centre_ to `[6px + w/2, W − 6px − w/2]` ×
  `[6px + h/2, H − 6px − h/2]` and writes that centre back into `left`/`top` in pixels,
  keeping the translate — so the CSS and the script agree on what `left`/`top` mean and
  there is no double offset — then sets the wedge's three points from that centre and the
  tail point with a 9px half-width. It runs from a `ResizeObserver` on the picture alone:
  the observer fires once on `observe`, and again when the lazy image decodes and the
  figure takes its height, so a `load` listener adds nothing and would miss an image
  already complete. No fallback for a browser without `ResizeObserver`, since the
  no-script rendering already covers it. Without the script, a bubble anchored near an
  edge overhangs the picture rather than being clamped; the figure gets no
  `overflow: hidden`, because clipping it would be worse. A page with no bubble carries no
  script, and an HTML page that draws no bubble is byte-for-byte what the site writes
  today; `style.css` grows for every site.
    - Considered and rejected: a CSS-only clamp bounding the anchor to `[22%, 78%]` (the
      44% max width's half). It keeps a bubble on the picture, but pushes a short bubble
      at an edge a long way from where the author dropped it, and it cannot clamp
      vertically at all because the height is unknown.
    - Considered and rejected: a tail as an SVG polygon in a `0 0 1 1` viewBox with
      `preserveAspectRatio="none"`. Its half-width would then be a page fraction,
      stretched with the picture's aspect, rather than the 9px the Play pane draws.
- **The wedge.** An empty `<svg class="tails">` covering the picture
  (`position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none` — an
  absolutely positioned `<svg>` is a replaced element and takes its intrinsic 300×150
  without the explicit size), emitted only when a drawn bubble has a tail. The script
  creates one `<polygon>` per bubble that carries `data-tx`/`data-ty`, in the
  paper-at-0.92 fill, so there is no pairing of the nth polygon with the nth tailed bubble
  to get wrong. The `viewBox` is set to the picture's pixel size by the script, so the
  points are in the same pixels the bubbles are clamped in; without the script the `<svg>`
  is empty. The wedge's base is centred on the bubble's centre, inside the bubble, and
  only its point shows past the paper — which needs the `<svg>` to come before the bubbles
  in the DOM, as `speak` appends `tail` before `body`. The figure's order is therefore
  `<img>`, `<svg class="tails">`, then the bubbles in beat order.
- **Tolerance.** `site-cli.ts`'s hand-written `asPlayable` checks nothing below `beats`,
  and is not extended. The renderer treats `panels` that is not an array, a panel that is
  not an object, `lines`/`bubbles` that are not arrays, and a bubble that is not an object
  as absent, and skips a bubble whose `line` is not a string or has no beat before the
  next `show`, whose `anchor` is not a pair of finite numbers, or whose `tail` is present
  and malformed the same way; the fractions it does use are clamped into `[0, 1]`. A
  malformed bubble costs one bubble, not the publish. A beat with `text: ''` (the schema
  allows it) still leaves the flow and draws an empty bubble, as the Play pane would.
- **Escaping.** Bubble text and the speaker name go through `esc` like every other
  authored string. Fractions are numbers the renderer has already checked finite and
  clamped, formatted with `toFixed(4)`, so no `NaN` reaches an attribute and the output is
  the same on every engine. The inline script is a constant with no interpolation: it
  reads anchors and tails from the `data-` attributes, so nothing authored is ever placed
  inside script.

## Work

One stage, one commit.

1. `packages/export/src/site.ts`
    - `renderScene` walks beats in groups: a `show` beat and the `say`/`narrate` beats up
      to the next `show`. For a `show` with bubbles, build `Map<line, Beat>` from the
      group, render the figure with its bubbles, and drop the bubbled beats from the flow.
    - `renderBeat`'s `show` branch grows a bubbles argument, or a new `renderFigure` takes
      over the figure so the single-frame path stays a one-liner.
    - Markup per bubble:
      `<p class="bubble speech|caption" style="left:…%;top:…%" data-ax data-ay [data-tx data-ty]><span class="who">Aiko</span>text</p>`
      (`.who` only on a `say`). A figure that draws at least one bubble gets
      `class="frame page"` — a page shot with no bubble drawn keeps `class="frame"` — and,
      when any drawn bubble has a tail, an empty `<svg class="tails">` placed before the
      bubbles.
    - `STYLESHEET` gains `.frame.page { position: relative }`, `.bubble`,
      `.bubble.speech`, `.bubble.caption`, `.bubble .who` (visually hidden), `.tails`
      rules. The constants (0.92, 6px, 9px, 44%, 15px, radii) are named once at the top of
      the module under a one-line
      `// Mirrors the Play pane's bubble constants in editors/play.ts`, so the two drift
      only on purpose.
    - `FIT_SCRIPT`: one string constant, inserted by `document()` at the end of `<body>`
      only when the page carries a bubble. It queries `.frame.page`, and for each runs the
      clamp and wedge maths above once the image has laid out and in a `ResizeObserver`.
    - Nothing tests the bundle's size or content:
      `apps/desktop/src/main/tests/pages.test.ts` mocks the bundle's bytes and tests
      install/status only, and `scripts/esbuild.sitebuilder.mjs` has no size budget.
      `lintrix.config.json` and `.commentlintrc.json` reject nothing about a long script
      constant.
2. `packages/export/src/tests/site.test.ts`
    - a bubbled `say` renders inside the figure and not as `<p class="say">`; its
      unbubbled neighbour still does
    - a `narrate` bubble with no tail is `.caption`; a `say` with a tail is `.speech` and
      the figure has a `<polygon>`
    - the page's HTML contains a `<script>` only when a bubble is drawn; a page without
      bubbles is unchanged from the existing expectations
    - the `<svg class="tails">` precedes the first `.bubble` in the figure, and is absent
      when no drawn bubble has a tail
    - interleaved coverage (`show A, L1, show B, L2, show A, L3` with bubbles on L1 and
      L3): the first figure draws L1's bubble only, the second draws L3's only, and L2
      flows
    - a bubble filed under a panel whose `lines` do not include its line is not drawn (the
      `framesOf` rule)
    - no `dim`/`evenodd` markup anywhere in the output
    - a bubble naming a line with no beat, or with a malformed anchor, is skipped
    - a `show` with bubbles but no `image` draws no figure and every line flows as a
      paragraph
    - percentages and `data-` values are formatted to four decimals, asserted as exact
      markup
    - bubble text and the speaker name are escaped: with `<script>x</script>` as the
      bubble text, the page contains `&lt;script&gt;` and exactly one `<script>` (the fit
      script), which is what tells this test apart from "one script per bubbled page"; a
      `say` bubble carries `.who` and a `narrate` bubble does not
3. Docs
    - `docs/reference/playable-format.md`: the two sentences saying the static site
      renderer ignores `line`/`panels` and `bubbles`. After this plan the site reads
      `line`, `panels[].lines` and `panels[].bubbles`, and still not `shape`. The "Three
      contracts" under The web export say nothing about script, so nothing there changes.
    - `packages/export/src/site.ts`: the `STYLESHEET` doc comment "One stylesheet, no
      script, no request that leaves the page" is the sentence that becomes untrue; it
      becomes "no request that leaves the page; the only script is the inline bubble fit,
      on a page that draws one".
    - `docs/guides/github-pages.md`: one line under Things worth knowing — bubbles placed
      in the Page editor appear on the site; the page is never dimmed; a reader with
      scripts off sees bubbles centred on their anchors, possibly overhanging the
      picture's edge, with no tails.
    - `docs/plans/manga-style.md`: the Stage 5 sentence "The standalone web player keeps
      its text overlay and ignores the field" and the as-shipped note "the static site
      ignores" further down both get a pointer to this plan.
    - `docs/plans/index.md`: a row for this plan (written with the plan).
4. `pnpm check && pnpm test && pnpm lint`, then `pnpm build` and run
   `node apps/desktop/dist/main/vn-site.mjs --project examples/mySampleRepo --out <tmp>`
   (or any project with a runner-lettered page) and open a page in a browser: bubbles at
   their anchors, tails pointing where the Page editor put them, no darkening, the same
   page at about 360px wide still readable, and the same page with scripts disabled still
   showing the bubbles.

## Out of scope

- Dimming or outlining panels on the site. The user asked for none, and a static page has
  no current panel to light.
- Reading a page panel by panel (stepping) on the site.
- Portrait overlay on the site (`renderIndex`'s comment already records why not).
- Extending `asPlayable` to validate panels and bubbles.
- Fonts: the site keeps its body serif rather than shipping Newsreader.

## As shipped

Shipped 2026-09-19 in one commit, as planned. Two notes:

- The live check (step 4) ran on `examples/dadsStory`, whose `abduction` page carries a
  caption and a tailed speech bubble. Rendered through the bundled `vn-site.mjs` and
  opened in Electron at 900px and 380px, and at 900px with JavaScript off: bubbles sat at
  their anchors, the wedge's base measured 18px centred on the bubble with its point at
  the tail, nothing darkened, and the no-script page showed the bubbles centred with no
  tails. At 380px the 15px bubbles stayed readable, so the `clamp()` font fallback
  recorded under Decisions was not needed.
- The polygon's fill is a stylesheet rule (`.tails polygon`) rather than an attribute the
  script sets, so the script writes only geometry.

## Review findings

A fresh-context agent reviewed the plan on 2026-09-19. What it found, and what changed:

- **The same page's `show` recurs under interleaved coverage**, so "every bubble on a page
  shows at once" was false. Fixed: each occurrence of the figure draws the bubbles of the
  lines read over it, stated under Data, with an interleaved test.
- **The CSS centring and the script's clamp double-offset** if the script writes the
  top-left corner in px while `translate(-50%, -50%)` stays. Fixed: the script clamps and
  writes the centre and keeps the translate.
- **An absolutely positioned `<svg>` needs `width`/`height` 100%**, and its DOM position
  was unstated. Fixed under The wedge.
- **`aria-label` on a generic element** is dropped or replaces the text, and Ctrl-F does
  not search attributes. Fixed: a visually hidden `.who` span in the bubble.
- **"Byte-for-byte" was over-claimed**: `style.css` changes for every site, and
  `class="frame page"` on every panelled figure would change model-lettered pages. Fixed:
  the claim is scoped to an HTML page that draws no bubble, and the class is added only
  when a bubble is drawn.
- **"One stylesheet, no script" lives in `site.ts`'s `STYLESHEET` doc comment**, not in
  `playable-format.md`'s contracts. Fixed in the docs step, along with "both are read now"
  (the site still ignores `shape`).
- **Several bubbles at once on a 42rem page** is bigger than the Play pane's one at a
  time. Recorded as accepted with a phone-width check and a named fallback.
- **The no-script fallback overhangs at an edge anchor.** Recorded, and the guide's
  wording says so.
- **A `load` listener is redundant** with the `ResizeObserver`'s initial callback and
  misses a complete image. Fixed: the observer alone.
- **The plan's matching differed from `framesOf`** (any panel's bubbles by line, rather
  than the lettering panel's). Fixed: the site uses `framesOf`'s rule.
- **Pairing the nth polygon with the nth tailed bubble** is fragile. Fixed: the script
  creates a polygon per bubble carrying `data-tx`/`data-ty`.
- **Tolerance was incomplete** for hand-validated input. Fixed: the shape checks are
  listed, and an empty `text` is decided.
- **The escaping test and the one-script test could not be told apart.** Fixed: the
  escaping test counts `<script>` occurrences.
- **Percent formatting** was unspecified. Fixed: four decimals.
- Checked and found no problem: the Play pane constants the plan quotes match `play.ts`;
  `buildPlayable` emits bubbles only under `runner`; `pages.test.ts` and
  `esbuild.sitebuilder.mjs` test neither bundle size nor content; lintrix and commentlint
  reject nothing about a script constant; `project.pagesStatus` flips to Update on its
  own. The "275 lines to 4,688" sentence in `site-cli.ts` and `playable-format.md` is
  about zod's cost, not the file's size, so it stays as it is.
