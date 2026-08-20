/**
 * The subset reader. Every case here is a shape `docs/guides/api-keys.md` actually contains, because
 * that page is the reason this exists — a general markdown suite would be testing a library we
 * deliberately did not write.
 */
import { blockText, parseInline, parseMarkdown, spansText } from '../markdown.js';

describe('parseInline', () => {
  it('reads code, strong and links, and keeps the text between them', () => {
    expect(parseInline('It begins with `AIza`, and **is shown once**.')).toEqual([
      { kind: 'text', text: 'It begins with ' },
      { kind: 'code', text: 'AIza' },
      { kind: 'text', text: ', and ' },
      { kind: 'strong', text: 'is shown once' },
      { kind: 'text', text: '.' },
    ]);

    expect(parseInline('see [Where a key goes](#where-a-key-goes)')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'Where a key goes', href: '#where-a-key-goes' },
    ]);
  });

  /**
   * The property that matters more than any particular syntax: nothing is dropped. A page this
   * cannot fully draw is still a page a reader can follow.
   */
  it('keeps unmatched markup as the text it was written as', () => {
    expect(spansText(parseInline('a stray ` backtick and [half a link'))).toBe(
      'a stray ` backtick and [half a link',
    );
  });
});

describe('parseMarkdown', () => {
  it('reads a heading, a paragraph and a numbered list', () => {
    const blocks = parseMarkdown('## Gemini\n\nSign in first.\n\n1. Open it.\n2. Copy the key.\n');
    expect(blocks[0]).toEqual({
      kind: 'heading',
      level: 2,
      spans: [{ kind: 'text', text: 'Gemini' }],
    });
    expect(blockText(blocks[1]!)).toBe('Sign in first.');
    expect(blocks[2]!.kind).toBe('list');
    expect(blockText(blocks[2]!)).toBe('Open it.\nCopy the key.');
  });

  /**
   * The source is wrapped at 100 columns, so almost every real step has a continuation line. A
   * reader that started a new paragraph there would turn one step into two.
   */
  it('joins a wrapped list item rather than starting a paragraph', () => {
    const blocks = parseMarkdown('1. Open the console link above\n   and sign in.\n2. Copy it.\n');
    expect(blockText(blocks[0]!)).toBe('Open the console link above and sign in.\nCopy it.');
  });

  it('keeps a bulleted list separate from a numbered one', () => {
    const blocks = parseMarkdown('- one\n- two\n\n1. first\n');
    expect(blocks.map((block) => block.kind)).toEqual(['list', 'list']);
    expect(blocks[0]).toMatchObject({ ordered: false });
    expect(blocks[1]).toMatchObject({ ordered: true });
  });

  it('reads a fenced block whole, and remembers what language it claimed', () => {
    const blocks = parseMarkdown('text\n\n```yaml\nvendor: gemini\nfreeTier: true\n```\n\nafter\n');
    expect(blocks[1]).toEqual({
      kind: 'code',
      lang: 'yaml',
      text: 'vendor: gemini\nfreeTier: true',
    });
    expect(blockText(blocks[2]!)).toBe('after');
  });

  it('reads a pipe table and drops the delimiter row', () => {
    const table = parseMarkdown(
      '| Platform | Directory |\n| --- | --- |\n| macOS | `~/Library` |\n',
    )[0];
    expect(table!.kind).toBe('table');
    expect(blockText(table!)).toBe('Platform | Directory\nmacOS | ~/Library');
  });

  it('leaves a list a fence interrupts on its own', () => {
    const blocks = parseMarkdown('- one\n\n```\ncode\n```\n');
    expect(blocks.map((block) => block.kind)).toEqual(['list', 'code']);
  });
});
