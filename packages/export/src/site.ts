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

function renderBeat(playable: Playable, beat: Beat): string {
  if (beat.type === 'show') {
    // A frame with no accepted asset yet renders as nothing at all. The alternative is a broken
    // image on every page of a half-generated project.
    if (!beat.image) return '';
    const src = `assets/${esc(beat.image.hash)}.${esc(beat.image.ext)}`;
    const alt = beat.shot ? esc(beat.shot) : 'Illustration';
    return `<figure class="frame"><img src="${src}" alt="${alt}" loading="lazy"></figure>`;
  }
  if (beat.type === 'say') {
    const who = esc(speakerName(playable, beat.who));
    return `<p class="say"><span class="who">${who}</span>“${esc(beat.text)}”</p>`;
  }
  return `<p class="narrate">${esc(beat.text)}</p>`;
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

/** The shell every page shares. `body` is already markup. */
function document(title: string, body: string): string {
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
</body>
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
  const beats = scene.beats
    .map((b) => renderBeat(playable, b))
    .filter((html) => html !== '')
    .join('\n    ');
  const body = `<header class="crumb">
    <a href="index.html">${esc(playable.title)}</a>
    <span class="pos">${index + 1} / ${total}</span>
  </header>
  <main class="scene">
    ${beats}
  </main>
  ${renderFooter(scene)}`;
  return document(`${playable.title} — ${id}`, body);
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

/** One stylesheet, no script, no request that leaves the page. */
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
