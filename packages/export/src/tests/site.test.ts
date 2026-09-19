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

describe('renderSite bubbles', () => {
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const image = { hash: 'pg', ext: 'png' } as const;

  /** A one-scene playable whose page letters `lines` and carries `bubbles`. */
  const paged = (
    bubbles: Playable['scenes'][string]['beats'][number][] | Record<string, unknown>[],
    lines: string[],
    beats: Playable['scenes'][string]['beats'],
    panels?: Record<string, unknown>[],
  ): string => {
    const show = {
      type: 'show',
      shot: 'one__page',
      image,
      panels: panels ?? [{ shape: square, lines, bubbles }],
    } as unknown as Playable['scenes'][string]['beats'][number];
    const build = renderSite(
      playable({
        characters: { aiko: { name: 'Aiko' } },
        scenes    : { one: { beats: [show, ...beats], choices: [] } },
      }),
    );
    return pageFor(build, 'one.html');
  };

  it('draws a bubbled say in the figure and leaves it out of the flow', () => {
    const html = paged(
      [{ line: 'l1', anchor: [0.25, 0.5], tail: [0.3, 0.7] }],
      ['l1', 'l2'],
      [
        { type: 'say', who: 'aiko', text: 'Hello.', line: 'l1' },
        { type: 'say', who: 'aiko', text: 'Still here.', line: 'l2' },
      ],
    );
    expect(html).toContain(
      '<figure class="frame page"><img src="assets/pg.png" alt="one__page" loading="lazy"><svg class="tails"></svg><p class="bubble speech" style="left:25.0000%;top:50.0000%" data-ax="0.2500" data-ay="0.5000" data-tx="0.3000" data-ty="0.7000"><span class="who">Aiko</span>Hello.</p></figure>',
    );
    expect(html).not.toContain('“Hello.”');
    expect(html).toContain('<p class="say"><span class="who">Aiko</span>“Still here.”</p>');
  });

  it('draws a tailless narrate as a caption with no who and no tails svg', () => {
    const html = paged(
      [{ line: 'l1', anchor: [0.5, 0.5] }],
      ['l1'],
      [{ type: 'narrate', text: 'Rain.', line: 'l1' }],
    );
    expect(html).toContain(
      '<p class="bubble caption" style="left:50.0000%;top:50.0000%" data-ax="0.5000" data-ay="0.5000">Rain.</p>',
    );
    expect(html).not.toContain('class="who"');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<p class="narrate">');
  });

  it('carries the fit script only on a page that draws a bubble', () => {
    const bubbled = paged(
      [{ line: 'l1', anchor: [0.5, 0.5] }],
      ['l1'],
      [{ type: 'narrate', text: 'Rain.', line: 'l1' }],
    );
    expect(bubbled.match(/<script>/g)).toHaveLength(1);
    expect(bubbled).toContain('ResizeObserver');
    const plain = paged([], ['l1'], [{ type: 'narrate', text: 'Rain.', line: 'l1' }]);
    expect(plain).not.toContain('<script');
    expect(plain).toContain('<figure class="frame"><img src="assets/pg.png"');
  });

  it('puts the tails svg before the first bubble', () => {
    const html = paged(
      [
        { line: 'l1', anchor: [0.2, 0.2] },
        { line: 'l2', anchor: [0.8, 0.8], tail: [0.9, 0.9] },
      ],
      ['l1', 'l2'],
      [
        { type: 'narrate', text: 'One.', line: 'l1' },
        { type: 'narrate', text: 'Two.', line: 'l2' },
      ],
    );
    expect(html.indexOf('<svg class="tails">')).toBeLessThan(html.indexOf('<p class="bubble'));
    expect(html.indexOf('<svg class="tails">')).toBeGreaterThan(html.indexOf('<img'));
  });

  it('draws only the bubbles of the lines read over each occurrence of a page', () => {
    const pageA = {
      type: 'show',
      image,
      panels: [
        {
          shape  : square,
          lines  : ['l1', 'l3'],
          bubbles: [
            { line: 'l1', anchor: [0.2, 0.2] },
            { line: 'l3', anchor: [0.8, 0.8] },
          ],
        },
      ],
    } as unknown as Playable['scenes'][string]['beats'][number];
    const build = renderSite(
      playable({
        scenes: {
          one: {
            beats: [
              pageA,
              { type: 'narrate', text: 'One.', line: 'l1' },
              { type: 'show', image: { hash: 'b', ext: 'png' } },
              { type: 'narrate', text: 'Two.', line: 'l2' },
              pageA,
              { type: 'narrate', text: 'Three.', line: 'l3' },
            ],
            choices: [],
          },
        },
      }),
    );
    const html = pageFor(build, 'one.html');
    const figures = html.match(/<figure[^]*?<\/figure>/g) ?? [];
    expect(figures).toHaveLength(3);
    expect(figures[0]).toContain('>One.</p>');
    expect(figures[0]).not.toContain('Three.');
    expect(figures[2]).toContain('>Three.</p>');
    expect(figures[2]).not.toContain('One.');
    expect(html).toContain('<p class="narrate">Two.</p>');
    expect(html).not.toContain('<p class="narrate">One.</p>');
  });

  it('ignores a bubble filed under a panel that does not letter its line', () => {
    const html = paged(
      [],
      [],
      [{ type: 'narrate', text: 'Rain.', line: 'l1' }],
      [
        { shape: square, lines: ['l2'], bubbles: [{ line: 'l1', anchor: [0.5, 0.5] }] },
        { shape: square, lines: ['l1'], bubbles: [] },
      ],
    );
    expect(html).not.toContain('bubble');
    expect(html).toContain('<p class="narrate">Rain.</p>');
  });

  it('never dims or outlines the page', () => {
    const html = paged(
      [{ line: 'l1', anchor: [0.5, 0.5] }],
      ['l1'],
      [{ type: 'narrate', text: 'Rain.', line: 'l1' }],
    );
    expect(html).not.toMatch(/dim|evenodd/);
    expect(pageFor(renderSite(playable()), 'style.css')).not.toMatch(/dim|evenodd/);
  });

  it('skips a bubble with no beat or a malformed anchor and keeps the rest', () => {
    const html = paged(
      [
        { line: 'l9', anchor: [0.5, 0.5] },
        { line: 'l1', anchor: [Number.NaN, 0.5] },
        { line: 'l1', anchor: [0.5] },
        { line: 'l2', anchor: [0.5, 0.5], tail: ['x', 0.5] },
        { line: 'l3', anchor: [2, -1] },
      ],
      ['l1', 'l2', 'l3', 'l9'],
      [
        { type: 'narrate', text: 'One.', line: 'l1' },
        { type: 'narrate', text: 'Two.', line: 'l2' },
        { type: 'narrate', text: 'Three.', line: 'l3' },
      ],
    );
    expect(html).toContain('<p class="narrate">One.</p>');
    expect(html).toContain('<p class="narrate">Two.</p>');
    expect(html).toContain(
      '<p class="bubble caption" style="left:100.0000%;top:0.0000%" data-ax="1.0000" data-ay="0.0000">Three.</p>',
    );
  });

  it('draws no bubble for a page with no image, so every line flows', () => {
    const show = {
      type  : 'show',
      panels: [{ shape: square, lines: ['l1'], bubbles: [{ line: 'l1', anchor: [0.5, 0.5] }] }],
    } as unknown as Playable['scenes'][string]['beats'][number];
    const build = renderSite(
      playable({
        scenes: {
          one: { beats: [show, { type: 'narrate', text: 'Rain.', line: 'l1' }], choices: [] },
        },
      }),
    );
    const html = pageFor(build, 'one.html');
    expect(html).not.toContain('<figure');
    expect(html).not.toContain('<script');
    expect(html).toContain('<p class="narrate">Rain.</p>');
  });

  it('formats fractions to four decimals', () => {
    const html = paged(
      [{ line: 'l1', anchor: [1 / 3, 2 / 3], tail: [0.123456, 0.9] }],
      ['l1'],
      [{ type: 'say', who: 'aiko', text: 'Hm.', line: 'l1' }],
    );
    expect(html).toContain(
      'style="left:33.3333%;top:66.6667%" data-ax="0.3333" data-ay="0.6667" data-tx="0.1235" data-ty="0.9000"',
    );
  });

  it('escapes bubble text and the speaker name', () => {
    const build = renderSite(
      playable({
        characters: { evil: { name: 'A & "B"' } },
        scenes: {
          one: {
            beats: [
              {
                type: 'show',
                image,
                panels: [
                  {
                    shape  : square,
                    lines  : ['l1', 'l2'],
                    bubbles: [
                      { line: 'l1', anchor: [0.5, 0.5], tail: [0.5, 0.9] },
                      { line: 'l2', anchor: [0.5, 0.5] },
                    ],
                  },
                ],
              } as unknown as Playable['scenes'][string]['beats'][number],
              { type: 'say', who: 'evil', text: '<script>x</script>', line: 'l1' },
              { type: 'narrate', text: 'Quiet.', line: 'l2' },
            ],
            choices: [],
          },
        },
      }),
    );
    const html = pageFor(build, 'one.html');
    expect(html).toContain(
      '<span class="who">A &amp; &quot;B&quot;</span>&lt;script&gt;x&lt;/script&gt;</p>',
    );
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain(
      '<p class="bubble caption" style="left:50.0000%;top:50.0000%" data-ax="0.5000" data-ay="0.5000">Quiet.</p>',
    );
  });
});
