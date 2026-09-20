/**
 * The web export. Renders a {@link Playable} as a static gamebook site.
 *
 * Pure and in-memory, the way {@link buildPlayable} is. It renders the beats a playable already
 * carries and never re-walks `Scene`/`Shot`, because the coverage rules (first shot covering a
 * line wins, a transition emits no beat, an absent asset is omitted) were applied at export.
 *
 * Output is one page per scene, with `choices` and `next` rendered as ordinary links. Nothing is
 * linearized and nothing is dropped.
 *
 * Deliberately not re-exported from the package barrel: the only consumer is `site-cli.ts`, and
 * the desktop app would otherwise pull a stylesheet and an HTML template into its main bundle.
 */
import type { Playable, PlayableScene, Beat } from '@vn/types';

// Mirrors the Play pane's bubble constants in pathux/play/bubble.ts
const BUBBLE_PAPER = 'rgba(232, 230, 223, 0.92)';
const BUBBLE_INK = '#0e1116';
const BUBBLE_MARGIN_PX = 6;
const TAIL_HALF_PX = 9;
const BUBBLE_MAX_WIDTH = '44%';
const BUBBLE_FONT_PX = 15;
const BUBBLE_NAME_FONT_PX = 11;
const BUBBLE_LINE_HEIGHT = 1.35;
const SPEECH_RADIUS_PX = 16;
const CAPTION_RADIUS_PX = 4;

/** One rendered file, at a path relative to the site root. */
export interface SitePage {
  path: string;
  html: string;
}

/** A reference the caller has to copy bytes for, into `assets/<hash>.<ext>`. */
export interface SiteAssetRef {
  hash: string;
  ext: string;
}

export interface SiteBuild {
  pages: SitePage[];
  /** Every asset the pages reference, deduped. */
  assets: SiteAssetRef[];
}

/** Escapes text for markup. Applied to every authored string. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A scene id as a filename. Scene ids are already id-shaped coming out of the model, but this
 * writes files from them, so anything that is not a plain id character becomes a dash.
 */
function pageOf(sceneId: string): string {
  const safe = sceneId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  const name = safe === '' ? 'scene' : safe;
  // `index` and `style` are the site's own two files. A scene named either gets a suffix so it
  // cannot overwrite them. Links are formed through this same function, so they still resolve.
  return /^(index|style)$/i.test(name) ? `${name}-scene.html` : `${name}.html`;
}

/**
 * Scenes in reading order: the entry scene, then everything reachable from it depth-first,
 * following `next` before `choices`. Scenes no branch reaches are appended in declaration order
 * rather than dropped — an unreachable scene is an authoring mistake the site should still show.
 */
function readingOrder(playable: Playable): string[] {
  const all = Object.keys(playable.scenes);
  const order: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    const scene = playable.scenes[id];
    if (seen.has(id) || !scene) return;
    seen.add(id);
    order.push(id);
    if (scene.next) walk(scene.next);
    for (const choice of scene.choices) walk(choice.goto);
  };
  if (playable.start) walk(playable.start);
  for (const id of all) walk(id);
  return order;
}

/** The speaker's display name, falling back to the raw id when the cast does not name them. */
function speakerName(playable: Playable, who: string): string {
  return playable.characters[who]?.name ?? who;
}

type ShowBeat = Extract<Beat, { type: 'show' }>;
type LineBeat = Exclude<Beat, { type: 'show' }>;

/** A bubble the renderer has checked: the beat it reads, and its points clamped into the page. */
interface DrawnBubble {
  beat: LineBeat;
  anchor: [number, number];
  tail?: [number, number];
  /** The bubble's own say on the speaker's name; absent defers to the playable. */
  name?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A page point clamped into `[0, 1]`, or undefined unless the value is a pair of finite numbers. */
function pointOf(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [x, y] = value as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number') return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return [clamp(x), clamp(y)];
}

/**
 * The bubbles a `show` draws over the beats read under it, following the desktop runner's rule:
 * a beat's bubble is filed under the panel whose `lines` include the beat's line. `site-cli.ts`
 * validates nothing below `beats`, so every shape is checked here and a malformed bubble is
 * skipped rather than failing the publish.
 */
function bubblesOf(show: ShowBeat, group: LineBeat[]): DrawnBubble[] {
  const byLine = new Map<string, LineBeat>();
  for (const beat of group) {
    if (beat.line !== undefined && !byLine.has(beat.line)) byLine.set(beat.line, beat);
  }
  const drawn: DrawnBubble[] = [];
  const panels: unknown = show.panels;
  if (!Array.isArray(panels)) return drawn;
  for (const panel of panels as unknown[]) {
    if (!isRecord(panel) || !Array.isArray(panel.lines) || !Array.isArray(panel.bubbles)) continue;
    const lines = panel.lines as unknown[];
    for (const bubble of panel.bubbles as unknown[]) {
      if (!isRecord(bubble) || typeof bubble.line !== 'string') continue;
      if (!lines.includes(bubble.line)) continue;
      const beat = byLine.get(bubble.line);
      if (!beat) continue;
      const anchor = pointOf(bubble.anchor);
      if (!anchor) continue;
      const name = typeof bubble.name === 'boolean' ? { name: bubble.name } : {};
      if (bubble.tail === undefined) {
        drawn.push({ beat, anchor, ...name });
        continue;
      }
      const tail = pointOf(bubble.tail);
      if (tail) drawn.push({ beat, anchor, tail, ...name });
    }
  }
  return drawn;
}

const pct = (fraction: number): string => (fraction * 100).toFixed(4);

/**
 * One bubble over the picture: centred on its anchor by CSS, clamped and tailed by the fit
 * script. The speaker's name is always in the markup for a reader that cannot see the picture;
 * it is shown only when the bubble, else the playable, says so.
 */
function renderBubble(playable: Playable, bubble: DrawnBubble): string {
  const { beat, anchor, tail } = bubble;
  const named = beat.type === 'say' && (bubble.name ?? playable.bubbleNames);
  const kind = `${tail ? 'speech' : 'caption'}${named ? ' named' : ''}`;
  const style = `left:${pct(anchor[0])}%;top:${pct(anchor[1])}%`;
  let data = `data-ax="${anchor[0].toFixed(4)}" data-ay="${anchor[1].toFixed(4)}"`;
  if (tail) data += ` data-tx="${tail[0].toFixed(4)}" data-ty="${tail[1].toFixed(4)}"`;
  const who =
    beat.type === 'say' ? `<span class="who">${esc(speakerName(playable, beat.who))}</span>` : '';
  return `<p class="bubble ${kind}" style="${style}" ${data}>${who}${esc(beat.text)}</p>`;
}

/**
 * A `show` as a figure, with the bubbles of the lines read under it drawn over the picture. The
 * beats in `drawn` are read in a bubble and must not flow as paragraphs.
 */
function renderFigure(
  playable: Playable,
  show: ShowBeat,
  group: LineBeat[],
): { html: string; drawn: Set<LineBeat> } {
  const drawn = new Set<LineBeat>();
  // A frame with no accepted asset yet renders as nothing at all. The alternative is a broken
  // image on every page of a half-generated project. Its bubbles go with it, so the lines flow.
  if (!show.image) return { html: '', drawn };
  const src = `assets/${esc(show.image.hash)}.${esc(show.image.ext)}`;
  const alt = show.shot ? esc(show.shot) : 'Illustration';
  const img = `<img src="${src}" alt="${alt}" loading="lazy">`;
  const bubbles = bubblesOf(show, group);
  if (bubbles.length === 0) return { html: `<figure class="frame">${img}</figure>`, drawn };
  for (const bubble of bubbles) drawn.add(bubble.beat);
  // The wedges' base sits under the bubble paper, so the svg is drawn before the bubbles
  const tails = bubbles.some((b) => b.tail) ? '<svg class="tails"></svg>' : '';
  const overlay = bubbles.map((b) => renderBubble(playable, b)).join('');
  return { html: `<figure class="frame page">${img}${tails}${overlay}</figure>`, drawn };
}

function renderLine(playable: Playable, beat: LineBeat): string {
  if (beat.type === 'say') {
    const who = esc(speakerName(playable, beat.who));
    return `<p class="say"><span class="who">${who}</span>“${esc(beat.text)}”</p>`;
  }
  return `<p class="narrate">${esc(beat.text)}</p>`;
}

/**
 * A scene's beats as markup, walked in groups: a `show` and the line beats up to the next
 * `show`. A line read in one of the figure's bubbles is left out of the flow.
 */
function renderBeats(playable: Playable, beats: Beat[]): { html: string[]; bubbled: boolean } {
  const html: string[] = [];
  let bubbled = false;
  let i = 0;
  while (i < beats.length) {
    const beat = beats[i]!;
    if (beat.type !== 'show') {
      html.push(renderLine(playable, beat));
      i += 1;
      continue;
    }
    const group: LineBeat[] = [];
    let j = i + 1;
    for (; j < beats.length; j += 1) {
      const next = beats[j]!;
      if (next.type === 'show') break;
      group.push(next);
    }
    const figure = renderFigure(playable, beat, group);
    if (figure.drawn.size > 0) bubbled = true;
    if (figure.html !== '') html.push(figure.html);
    for (const line of group) {
      if (!figure.drawn.has(line)) html.push(renderLine(playable, line));
    }
    i = j;
  }
  return { html, bubbled };
}

/** The branch footer. Renders the choices, a single continuation link, or an ending marker. */
function renderFooter(scene: PlayableScene): string {
  if (scene.choices.length > 0) {
    const items = scene.choices
      .map((c) => `<li><a href="${esc(pageOf(c.goto))}">${esc(c.label)}</a></li>`)
      .join('\n      ');
    return `<nav class="choices">\n    <ul>\n      ${items}\n    </ul>\n  </nav>`;
  }
  if (scene.next) {
    return `<nav class="choices">\n    <a class="continue" href="${esc(pageOf(scene.next))}">Continue →</a>\n  </nav>`;
  }
  return `<nav class="choices">\n    <p class="ending">The End</p>\n  </nav>`;
}

/**
 * The shell every page shares. `body` is already markup. `script` appends the bubble fit, which
 * only a page that draws a bubble carries.
 */
function document(title: string, body: string, script = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
${body}
${script ? `<script>${FIT_SCRIPT}</script>\n` : ''}</body>
</html>
`;
}

function renderScene(
  playable: Playable,
  id: string,
  scene: PlayableScene,
  index: number,
  total: number,
): string {
  const rendered = renderBeats(playable, scene.beats);
  const beats = rendered.html.join('\n    ');
  const body = `<header class="crumb">
    <a href="index.html">${esc(playable.title)}</a>
    <span class="pos">${index + 1} / ${total}</span>
  </header>
  <main class="scene">
    ${beats}
  </main>
  ${renderFooter(scene)}`;
  return document(`${playable.title} — ${id}`, body, rendered.bubbled);
}

/**
 * The contents page: where to start reading, the cast, and every scene by id.
 *
 * The cast is drawn from the portraits the playable carries. A light novel has no place to
 * overlay a portrait on a frame, so `portraitOverlay` is not consulted here. The portraits are
 * listed as a cast section rather than composited onto frames.
 */
function renderIndex(playable: Playable, order: string[]): string {
  const cast = Object.values(playable.characters)
    .map((character) => {
      const portrait = character.portrait
        ? `<img src="assets/${esc(character.portrait.hash)}.${esc(character.portrait.ext)}" alt="${esc(character.name)}" loading="lazy">`
        : '';
      return `<li>${portrait}<span>${esc(character.name)}</span></li>`;
    })
    .join('\n      ');
  const contents = order
    .map((id) => `<li><a href="${esc(pageOf(id))}">${esc(id)}</a></li>`)
    .join('\n      ');
  const start = order[0];
  const body = `<header class="title">
    <h1>${esc(playable.title)}</h1>
    ${start ? `<a class="continue" href="${esc(pageOf(start))}">Start reading →</a>` : ''}
  </header>
  ${cast === '' ? '' : `<section class="cast">\n    <h2>Cast</h2>\n    <ul>\n      ${cast}\n    </ul>\n  </section>`}
  <section class="contents">
    <h2>Contents</h2>
    <ol>
      ${contents}
    </ol>
  </section>`;
  return document(playable.title, body);
}

/**
 * One stylesheet, no request that leaves the page; the only script is the inline bubble fit, on a
 * page that draws one.
 */
const STYLESHEET = `:root {
  color-scheme: light dark;
  --ink: #1b1b1f;
  --paper: #faf8f4;
  --muted: #6b6a72;
  --rule: rgba(0, 0, 0, 0.12);
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e8e6e3;
    --paper: #17171a;
    --muted: #9a98a2;
    --rule: rgba(255, 255, 255, 0.16);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 2rem 1.25rem 5rem;
  max-width: 42rem;
  background: var(--paper);
  color: var(--ink);
  font: 1.05rem/1.7 Georgia, 'Iowan Old Style', 'Times New Roman', serif;
}
a { color: inherit; }
h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 1rem; }
h2 { font-size: 1.1rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.crumb {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--rule);
  font-size: 0.85rem;
  color: var(--muted);
}
.crumb a { text-decoration: none; }
.pos { font-variant-numeric: tabular-nums; }
.frame { margin: 2rem 0; }
.frame img { display: block; width: 100%; height: auto; border-radius: 4px; }
.frame.page { position: relative; }
.bubble {
  position: absolute;
  transform: translate(-50%, -50%);
  margin: 0;
  max-width: ${BUBBLE_MAX_WIDTH};
  padding: 8px 13px;
  background: ${BUBBLE_PAPER};
  color: ${BUBBLE_INK};
  font-size: ${BUBBLE_FONT_PX}px;
  line-height: ${BUBBLE_LINE_HEIGHT};
  text-align: center;
  box-shadow: 0 1px 4px rgba(14, 17, 22, 0.35);
}
.bubble.speech { border-radius: ${SPEECH_RADIUS_PX}px; }
.bubble.caption { border-radius: ${CAPTION_RADIUS_PX}px; }
.bubble .who {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.bubble.named .who {
  position: static;
  display: block;
  width: auto;
  height: auto;
  clip-path: none;
  font-family: system-ui, sans-serif;
  font-size: ${BUBBLE_NAME_FONT_PX}px;
  letter-spacing: 0.08em;
  margin-bottom: 2px;
}
.tails { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.tails polygon { fill: ${BUBBLE_PAPER}; }
.narrate { margin: 1rem 0; }
.say { margin: 1rem 0; }
.say .who {
  display: block;
  font-family: system-ui, sans-serif;
  font-size: 0.8rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.choices { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); }
.choices ul { list-style: none; padding: 0; margin: 0; }
.choices li + li { margin-top: 0.5rem; }
.choices a { display: inline-block; padding: 0.4rem 0; }
.continue { font-family: system-ui, sans-serif; font-size: 0.95rem; text-decoration: none; }
.ending { color: var(--muted); font-style: italic; }
.cast ul { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 1rem; }
.cast li { width: 8rem; text-align: center; font-size: 0.9rem; }
.cast img { width: 100%; height: auto; border-radius: 4px; }
.contents ol { padding-left: 1.25rem; }
`;

/**
 * The bubble fit, inlined on a page that draws a bubble. It does what the Play pane's `fit` does:
 * clamps each bubble's centre `BUBBLE_MARGIN_PX` inside the picture, writes the centre back in
 * pixels (the stylesheet's translate keeps centring it), and draws one wedge per tailed bubble
 * with a `TAIL_HALF_PX` base. It reads only `data-` attributes, so nothing authored is in script.
 * A `ResizeObserver` on the picture fires once on observe and again when the lazy image decodes.
 */
const FIT_SCRIPT = `(function () {
  var M = ${BUBBLE_MARGIN_PX}, T = ${TAIL_HALF_PX};
  if (!window.ResizeObserver) return;
  function fit(fig, img) {
    var W = img.offsetWidth, H = img.offsetHeight;
    if (!W || !H) return;
    var svg = fig.querySelector('svg.tails');
    if (svg) { svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.textContent = ''; }
    var bubbles = fig.querySelectorAll('.bubble');
    for (var i = 0; i < bubbles.length; i++) {
      var b = bubbles[i], w = b.offsetWidth, h = b.offsetHeight;
      var cx = Math.min(Math.max(b.dataset.ax * W, M + w / 2), W - M - w / 2);
      var cy = Math.min(Math.max(b.dataset.ay * H, M + h / 2), H - M - h / 2);
      b.style.left = cx + 'px';
      b.style.top = cy + 'px';
      if (!svg || b.dataset.tx === undefined) continue;
      var tx = b.dataset.tx * W, ty = b.dataset.ty * H;
      var len = Math.hypot(tx - cx, ty - cy) || 1;
      var nx = (-(ty - cy) / len) * T, ny = ((tx - cx) / len) * T;
      var wedge = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      wedge.setAttribute('points', (cx + nx) + ',' + (cy + ny) + ' ' + (cx - nx) + ',' + (cy - ny) + ' ' + tx + ',' + ty);
      svg.appendChild(wedge);
    }
  }
  var figs = document.querySelectorAll('.frame.page');
  for (var i = 0; i < figs.length; i++) {
    (function (fig) {
      var img = fig.querySelector('img');
      if (!img) return;
      new ResizeObserver(function () { fit(fig, img); }).observe(img);
    })(figs[i]);
  }
})();`;

/**
 * Render a playable as a static site. Returns the files to write and the assets to copy; it
 * touches no filesystem, so the caller decides where any of it lands.
 */
export function renderSite(playable: Playable): SiteBuild {
  const order = readingOrder(playable);
  const pages: SitePage[] = [
    { path: 'index.html', html: renderIndex(playable, order) },
    { path: 'style.css', html: STYLESHEET },
  ];
  for (const [index, id] of order.entries()) {
    const scene = playable.scenes[id];
    if (!scene) continue;
    pages.push({ path: pageOf(id), html: renderScene(playable, id, scene, index, order.length) });
  }

  const assets = new Map<string, SiteAssetRef>();
  for (const character of Object.values(playable.characters)) {
    if (character.portrait) assets.set(character.portrait.hash, character.portrait);
  }
  for (const id of order) {
    for (const beat of playable.scenes[id]?.beats ?? []) {
      if (beat.type === 'show' && beat.image) assets.set(beat.image.hash, beat.image);
    }
  }
  return { pages, assets: [...assets.values()] };
}
