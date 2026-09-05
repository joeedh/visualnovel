import type { Playable } from '@vn/types';
import { renderSite } from '../site.js';

/** A playable built by hand. The renderer reads the exporter's output, not the model. */
function playable(partial: Partial<Playable> = {}): Playable {
  return {
    version        : 1,
    title          : 'Test Story',
    start          : 'one',
    portraitOverlay: false,
    characters     : {},
    scenes         : {},
    ...partial,
  };
}

const pageFor = (build: ReturnType<typeof renderSite>, path: string): string =>
  build.pages.find((p) => p.path === path)?.html ?? '';

describe('renderSite', () => {
  it('writes an index, a stylesheet and one page per scene', () => {
    const build = renderSite(
      playable({
        scenes: {
          one: { beats: [], choices: [], next: 'two' },
          two: { beats: [], choices: [] },
        },
      }),
    );
    expect(build.pages.map((p) => p.path).sort()).toEqual([
      'index.html',
      'one.html',
      'style.css',
      'two.html',
    ]);
  });

  it('renders each beat kind', () => {
    const build = renderSite(
      playable({
        characters: { aiko: { name: 'Aiko' } },
        scenes: {
          one: {
            beats: [
              { type: 'show', shot: 'one__establishing', image: { hash: 'abc', ext: 'png' } },
              { type: 'say', who: 'aiko', text: 'Um… hello.' },
              { type: 'narrate', text: 'She bows.' },
            ],
            choices: [],
          },
        },
      }),
    );
    const html = pageFor(build, 'one.html');
    expect(html).toContain('<img src="assets/abc.png"');
    expect(html).toContain('<span class="who">Aiko</span>“Um… hello.”');
    expect(html).toContain('<p class="narrate">She bows.</p>');
  });

  it('names an unknown speaker by their id', () => {
    const build = renderSite(
      playable({
        scenes: { one: { beats: [{ type: 'say', who: 'ghost', text: 'Hm.' }], choices: [] } },
      }),
    );
    expect(pageFor(build, 'one.html')).toContain('<span class="who">ghost</span>');
  });

  it('omits a show beat that has no image', () => {
    const build = renderSite(
      playable({
        scenes: { one: { beats: [{ type: 'show', shot: 'one__establishing' }], choices: [] } },
      }),
    );
    expect(pageFor(build, 'one.html')).not.toContain('<figure');
    expect(build.assets).toEqual([]);
  });

  it('renders choices as links, a bare next as a continue link, and neither as an ending', () => {
    const build = renderSite(
      playable({
        scenes: {
          one  : { beats: [], choices: [{ label: 'Say hello', goto: 'two' }] },
          two  : { beats: [], choices: [], next: 'three' },
          three: { beats: [], choices: [] },
        },
      }),
    );
    expect(pageFor(build, 'one.html')).toContain('<a href="two.html">Say hello</a>');
    expect(pageFor(build, 'two.html')).toContain('<a class="continue" href="three.html">');
    expect(pageFor(build, 'three.html')).toContain('The End');
  });

  it('escapes authored text', () => {
    const build = renderSite(
      playable({
        title : 'Ink & <Bone>',
        scenes: { one: { beats: [{ type: 'narrate', text: '<script>x</script>' }], choices: [] } },
      }),
    );
    expect(pageFor(build, 'index.html')).toContain('Ink &amp; &lt;Bone&gt;');
    expect(pageFor(build, 'one.html')).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(pageFor(build, 'one.html')).not.toContain('<script>');
  });

  it('collects every referenced asset once, portraits included', () => {
    const build = renderSite(
      playable({
        characters: { aiko: { name: 'Aiko', portrait: { hash: 'p1', ext: 'png' } } },
        scenes: {
          one: {
            beats: [
              { type: 'show', image: { hash: 'a1', ext: 'png' } },
              { type: 'show', image: { hash: 'a1', ext: 'png' } },
              { type: 'show', image: { hash: 'a2', ext: 'webp' } },
            ],
            choices: [],
          },
        },
      }),
    );
    expect(build.assets.map((a) => a.hash).sort()).toEqual(['a1', 'a2', 'p1']);
  });

  it('lists scenes in reading order, with unreachable ones last', () => {
    const build = renderSite(
      playable({
        start : 'one',
        scenes: {
          orphan: { beats: [], choices: [] },
          one   : { beats: [], choices: [], next: 'two' },
          two   : { beats: [], choices: [] },
        },
      }),
    );
    const index = pageFor(build, 'index.html');
    expect(index.indexOf('one.html')).toBeLessThan(index.indexOf('two.html'));
    expect(index.indexOf('two.html')).toBeLessThan(index.indexOf('orphan.html'));
  });

  it('survives a cycle between scenes', () => {
    const build = renderSite(
      playable({
        scenes: {
          one: { beats: [], choices: [], next: 'two' },
          two: { beats: [], choices: [], next: 'one' },
        },
      }),
    );
    expect(build.pages.map((p) => p.path)).toContain('two.html');
  });

  it('keeps a scene named index off the index page itself', () => {
    const build = renderSite(
      playable({ start: 'index', scenes: { index: { beats: [], choices: [] } } }),
    );
    const paths = build.pages.map((p) => p.path);
    expect(paths).toContain('index-scene.html');
    expect(paths.filter((p) => p === 'index.html')).toHaveLength(1);
  });
});
