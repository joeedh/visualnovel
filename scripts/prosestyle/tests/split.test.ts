import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { isProse, reassemble, splitBlocks, structure } from '../split.js';
import { rewrap, shapeOf, wrapWidth } from '../rewrap.js';

const REPO = join(__dirname, '..', '..', '..');

async function markdownUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdownUnder(path)));
    else if (entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}

const kindsOf = (md: string) => splitBlocks(md).map((b) => b.kind);

describe('splitBlocks', () => {
  it('passes a fenced block through, including one indented inside a list item', () => {
    const md = ['- a bullet', '', '  ```sh', '  pnpm check', '  ```', '', '  more text'].join('\n');
    expect(kindsOf(md)).toEqual(['prose', 'gap', 'fence', 'gap', 'prose']);
  });

  it('passes a generated table of contents through as one block', () => {
    const md = ['<!-- toc -->', '', '- [A](#a)', '- [B](#b)', '', '<!-- tocstop -->', ''].join(
      '\n',
    );
    expect(kindsOf(md)).toEqual(['toc']);
  });

  it('passes headings and tables through', () => {
    const md = ['## Heading', '', '| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    expect(kindsOf(md)).toEqual(['heading', 'gap', 'table']);
  });

  it('passes a checkbox item through and treats a plain item as prose', () => {
    const md = ['- [ ] not yet done', '- an ordinary bullet'].join('\n');
    expect(kindsOf(md)).toEqual(['checkbox', 'prose']);
  });

  it('treats a blockquote as prose', () => {
    expect(kindsOf('> a quoted claim\n> continued')).toEqual(['prose']);
  });

  it('passes a link reference definition through', () => {
    expect(kindsOf('[label]: https://example.test/page')).toEqual(['link']);
  });
});

describe('the round trip over the whole corpus', () => {
  it('reproduces every file under docs/ byte for byte', async () => {
    const files = await markdownUnder(join(REPO, 'docs'));
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      const rebuilt = reassemble(splitBlocks(source), new Map());
      expect([file, rebuilt === source]).toEqual([file, true]);
    }
  });

  /** A nested bullet states its own rule, so the rules file must not come out as one block. */
  it('gives each nested bullet in the rules file its own block', async () => {
    const source = await fs.readFile(join(REPO, 'docs/reference/proseStyle.md'), 'utf8');
    expect(splitBlocks(source).filter(isProse).length).toBeGreaterThan(15);
  });
});

describe('reassemble', () => {
  it('substitutes a prose block and leaves the rest alone', () => {
    const source = '# Title\n\nold text\n';
    const blocks = splitBlocks(source);
    const at = blocks.findIndex(isProse);
    expect(reassemble(blocks, new Map([[at, 'new text\n']]))).toBe('# Title\n\nnew text\n');
  });

  it('ignores a revision aimed at a block that is not prose', () => {
    const source = '# Title\n\ntext\n';
    const blocks = splitBlocks(source);
    expect(reassemble(blocks, new Map([[0, '# Rewritten\n']]))).toBe(source);
  });
});

describe('rewrap', () => {
  it('keeps a list marker on the first line and indents the rest under it', () => {
    const original = '- one two three four\n  five six\n';
    const shape = shapeOf(original, 20);
    expect(rewrap('one two three four five six seven', shape)).toBe(
      '- one two three four\n  five six seven\n',
    );
  });

  it('never breaks a word longer than the room left', () => {
    const shape = shapeOf('short\n', 10);
    expect(rewrap('a https://example.test/a/very/long/path b', shape)).toBe(
      'a\nhttps://example.test/a/very/long/path\nb\n',
    );
  });

  it('keeps CRLF when the original had it', () => {
    expect(rewrap('a b', shapeOf('x\r\ny\r\n', 40))).toBe('a b\r\n');
  });

  /** A bare `+` at the head of a wrapped line reads as a list marker and splits the block in two. */
  it('overflows rather than opening a line with a token that starts a block', () => {
    const shape = shapeOf('- x\n  y\n', 20);
    const wrapped = rewrap('alpha beta gammas + delta', shape);
    expect(wrapped).toBe('- alpha beta gammas +\n  delta\n');
    expect(splitBlocks(wrapped)).toHaveLength(1);
  });

  it('does the same for a table pipe and a heading hash', () => {
    const shape = shapeOf('- x\n  y\n', 20);
    expect(splitBlocks(rewrap('alpha beta gammas | delta', shape))).toHaveLength(1);
    expect(splitBlocks(rewrap('alpha beta gammas # delta', shape))).toHaveLength(1);
  });
});

describe('wrapWidth', () => {
  it('reads the width from lines the author broke, not from the last line of a block', () => {
    const md = `${'w '.repeat(40).trim()}\nshort tail\n`;
    expect(wrapWidth(md)).toBe(79);
  });

  /** Checks that a line which overran because it could not be broken is left out of the width. */
  it('ignores a final line that overran because it could not be broken', () => {
    const wrapped = 'w '.repeat(35).trim();
    const md = `${wrapped}\n${'x'.repeat(140)}\n`;
    expect(wrapWidth(md)).toBe(69);
  });

  it('falls back when nothing in the document was ever wrapped', () => {
    expect(wrapWidth('# H\n\nshort.\n')).toBe(95);
  });
});

describe('structure', () => {
  it('counts what a guard has to compare', () => {
    const md = ['# H', '', '- [ ] task', '- bullet', '', '| a |', '| - |', '', 'para'].join('\n');
    expect(structure(md)).toMatchObject({
      headings: 1,
      checkboxes: 1,
      bullets: 1,
      tables: 1,
      tableRows: 2,
    });
  });
});
