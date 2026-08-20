import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openBible, terms } from '../index.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vn-bible-'));
}

async function write(root: string, rel: string, text: string): Promise<void> {
  const abs = join(root, rel);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
}

describe('terms', () => {
  it('drops stopwords, single characters, and duplicates', () => {
    expect(terms('Who is the Warden of the tower?')).toEqual(['warden', 'tower']);
  });

  it('is empty for a query with no signal', () => {
    expect(terms('what is it')).toEqual([]);
  });
});

describe('openBible', () => {
  let root: string;

  beforeEach(async () => {
    root = await tempRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is empty — not an error — when the root does not exist', async () => {
    const bible = await openBible(join(root, 'wiki'));
    expect(bible.files()).toEqual([]);
    expect(await bible.query('warden')).toEqual([]);
  });

  it('indexes a tree, taking the title from front matter then the first heading', async () => {
    await write(
      root,
      'places/tower.md',
      '---\ntitle: The Iron Tower\ntags: [place]\n---\n\n# Tower\n',
    );
    await write(root, 'cast/ren.md', '# Ren Ishida\n\nA courier.\n');
    await write(root, 'notes.txt', 'not markdown');

    const bible = await openBible(root);
    expect(bible.files().map((f) => [f.file, f.title, f.tags])).toEqual([
      ['cast/ren.md', 'Ren Ishida', []],
      ['places/tower.md', 'The Iron Tower', ['place']],
    ]);
  });

  it('ranks a file whose title and heading match above one that only mentions the term', async () => {
    await write(
      root,
      'a-passing-mention.md',
      '# Ledger\n\nThe warden signed the ledger and left.\n',
    );
    await write(
      root,
      'warden.md',
      '---\ntitle: The Warden\ntags: [warden, office]\n---\n\n# The Warden\n\nKeeper of the tower keys.\n',
    );

    const bible = await openBible(root);
    const hits = await bible.query('warden');
    expect(hits[0]!.file).toBe('warden.md');
    expect(hits.map((h) => h.file)).toContain('a-passing-mention.md');
  });

  it('attributes an excerpt to its nearest enclosing heading', async () => {
    await write(
      root,
      'tower.md',
      ['# Tower', '', 'Stone.', '', '## The Bell', '', 'It has not rung in nine years.', ''].join(
        '\n',
      ),
    );

    const bible = await openBible(root);
    const [hit] = await bible.query('rung');
    expect(hit?.heading).toBe('The Bell');
    // 1-based, and counted over the whole file so it matches what an editor shows
    expect(hit?.line).toBe(5);
  });

  it('returns nothing for a query that matches no file', async () => {
    await write(root, 'tower.md', '# Tower\n\nStone and rain.\n');

    const bible = await openBible(root);
    expect(await bible.query('submarine')).toEqual([]);
  });

  it('never returns more characters than the budget', async () => {
    const paragraph = Array.from(
      { length: 12 },
      (_, i) => `The warden walked the ${i} corridor, counting warden things.`,
    );
    await write(root, 'a.md', `# Warden A\n\n${paragraph.join('\n\n')}\n`);
    await write(root, 'b.md', `# Warden B\n\n${paragraph.join('\n\n')}\n`);

    const bible = await openBible(root);
    const unbounded = await bible.query('warden');
    const total = (hits: { text: string }[]): number => hits.reduce((n, h) => n + h.text.length, 0);
    expect(total(unbounded)).toBeGreaterThan(300);

    const bounded = await bible.query('warden', { budget: 300 });
    expect(total(bounded)).toBeLessThanOrEqual(300);
    expect(bounded.length).toBeGreaterThan(0);
  });

  it('honours the excerpt limit', async () => {
    await write(root, 'a.md', Array.from({ length: 40 }, (_, i) => `warden ${i}\n\n`).join(''));
    await write(root, 'b.md', Array.from({ length: 40 }, (_, i) => `warden ${i}\n\n`).join(''));

    const bible = await openBible(root);
    expect((await bible.query('warden', { limit: 2 })).length).toBe(2);
  });

  it('picks up a file added after the bible was opened', async () => {
    const bible = await openBible(root);
    expect(await bible.query('warden')).toEqual([]);

    await write(root, 'warden.md', '# The Warden\n\nKeeper of the keys.\n');
    expect((await bible.query('warden')).map((h) => h.file)).toEqual(['warden.md']);
  });

  it('indexes a note whose front matter is broken as the text it is', async () => {
    await write(root, 'broken.md', '---\ntitle: [unclosed\n---\n\nThe warden is still here.\n');

    const bible = await openBible(root);
    expect((await bible.query('warden')).map((h) => h.file)).toEqual(['broken.md']);
  });
});
