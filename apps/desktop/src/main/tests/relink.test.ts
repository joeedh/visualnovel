import { relink } from '../doctree/relink.js';

const moveA = [{ from: 'wiki/a.md', to: 'wiki/lore/a.md' }];

/** The text of `doc`, which stays put, after `wiki/a.md` moves into `wiki/lore/`. */
const inbound = (text: string, doc = 'wiki/index.md') => relink(doc, doc, text, moveA);

describe('relink, in a document that links to a moved file', () => {
  it('rewrites an inline link and an image, keeping the text and the alt', () => {
    expect(inbound('See [A](a.md) and ![pic](a.md).\n')).toEqual({
      text : 'See [A](lore/a.md) and ![pic](lore/a.md).\n',
      count: 2,
    });
  });

  it('keeps a title, a fragment and a query', () => {
    expect(inbound('[A](a.md#top "The A page") [B](./a.md?x=1#y)').text).toBe(
      '[A](lore/a.md#top "The A page") [B](lore/a.md?x=1#y)',
    );
  });

  it('rewrites an angle-bracket href and keeps the brackets', () => {
    const moves = [{ from: 'wiki/a b.md', to: 'wiki/lore/a b.md' }];
    expect(relink('wiki/index.md', 'wiki/index.md', '[A](<a b.md>)', moves).text).toBe(
      '[A](<lore/a b.md>)',
    );
  });

  it('decodes %20 to resolve an href and encodes the rewritten one', () => {
    const moves = [{ from: 'wiki/a b.md', to: 'wiki/old notes/a b.md' }];
    expect(relink('wiki/index.md', 'wiki/index.md', '[A](a%20b.md)', moves).text).toBe(
      '[A](old%20notes/a%20b.md)',
    );
  });

  it('rewrites a reference definition', () => {
    expect(inbound('Read [the page][a].\n\n[a]: a.md "A"\n').text).toBe(
      'Read [the page][a].\n\n[a]: lore/a.md "A"\n',
    );
  });

  it('leaves fenced code and inline code alone', () => {
    const text =
      '```md\n[A](a.md)\n```\n\nInline `[A](a.md)` here, [real](a.md).\n~~~\n[A](a.md)\n~~~\n';
    expect(inbound(text)).toEqual({
      text : text.replace('[real](a.md)', '[real](lore/a.md)'),
      count: 1,
    });
  });

  it('leaves urls, absolute paths, fragments and escaped brackets alone', () => {
    const text =
      '[w](https://example.com/a.md) [m](mailto:x@y) [r](/wiki/a.md) [f](#a) \\[x](a.md)\n';
    expect(inbound(text)).toEqual({ text, count: 0 });
  });

  it('leaves an href that climbs out of the workspace alone', () => {
    const text = '[out](../../a.md)';
    expect(inbound(text)).toEqual({ text, count: 0 });
  });

  it('rewrites a link to a file under a moved folder', () => {
    const moves = [{ from: 'wiki/cast', to: 'wiki/people' }];
    const text = '[Aiko](../wiki/cast/aiko.md) [cast](../wiki/cast/)';
    expect(relink('characters/index.md', 'characters/index.md', text, moves).text).toBe(
      '[Aiko](../wiki/people/aiko.md) [cast](../wiki/people)',
    );
  });

  it('finds an image nested inside a link', () => {
    const moves = [
      { from: 'wiki/a.md', to: 'wiki/lore/a.md' },
      { from: 'wiki/pic.md', to: 'wiki/lore/pic.md' },
    ];
    expect(relink('wiki/index.md', 'wiki/index.md', '[![p](pic.md)](a.md)', moves)).toEqual({
      text : '[![p](lore/pic.md)](lore/a.md)',
      count: 2,
    });
  });

  it('keeps line endings as they were', () => {
    expect(inbound('[A](a.md)\r\n```\r\n[A](a.md)\r\n```\r\n').text).toBe(
      '[A](lore/a.md)\r\n```\r\n[A](a.md)\r\n```\r\n',
    );
  });
});

describe('relink, in a document that moved itself', () => {
  it('rewrites its relative links so they name the same files from the new place', () => {
    const text =
      '[W](world.md) ![p](../assets/objects/abc.png) [c](../characters/aiko/character.md)';
    expect(relink('wiki/a.md', 'wiki/lore/a.md', text, moveA)).toEqual({
      text: '[W](../world.md) ![p](../../assets/objects/abc.png) [c](../../characters/aiko/character.md)',
      count: 3,
    });
  });

  it('follows a link to another moved file, and a link to itself', () => {
    const moves = [
      { from: 'wiki/a.md', to: 'archive/a.md' },
      { from: 'wiki/b.md', to: 'wiki/lore/b.md' },
    ];
    expect(relink('wiki/a.md', 'archive/a.md', '[B](b.md) [me](a.md#top)', moves).text).toBe(
      '[B](../wiki/lore/b.md) [me](a.md#top)',
    );
  });

  it('leaves links inside a moved folder that still resolve alone', () => {
    const moves = [{ from: 'wiki/cast', to: 'wiki/people' }];
    const text = '[B](bo.md) [W](../world.md)';
    expect(relink('wiki/cast/aiko.md', 'wiki/people/aiko.md', text, moves)).toEqual({
      text,
      count: 0,
    });
  });
});
