import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatterCodec as codec, parseFrontMatter, splitFrontMatter } from '../index.js';

const TEMPLATE = join(__dirname, '..', '..', '..', '..', 'templates', 'basic');

/** Every sheet the template ships, as the front-matter block a rich editor would hand the codec. */
function sheets(): { path: string; block: string; text: string }[] {
  const out: { path: string; block: string; text: string }[] = [];
  for (const dir of ['characters/aiko', 'characters/haruki', 'locations']) {
    for (const name of readdirSync(join(TEMPLATE, dir)).filter((n) => n.endsWith('.md'))) {
      const path = `${dir}/${name}`;
      const text = readFileSync(join(TEMPLATE, path), 'utf8');
      out.push({ path, block: splitFrontMatter(text).prefix.trimEnd(), text });
    }
  }
  return out;
}

const BLOCK = [
  '---',
  '# Keep this comment',
  "name: 'Ada' # inline",
  'status: draft',
  'unknown: [one, two]',
  'palette:',
  '  - "#a02828"',
  '  - "#e8c8b0"',
  '---',
].join('\n');

describe('frontmatterCodec.read', () => {
  it('reads every template sheet the way parseFrontMatter does', () => {
    const all = sheets();
    expect(all.length).toBeGreaterThan(0);
    for (const { block, text } of all) {
      expect(codec.read(block)).toEqual(parseFrontMatter(text).data);
    }
  });

  it('refuses a block whose fence is not on the first line, as parseFrontMatter would', () => {
    expect(() => codec.read(`\n${BLOCK}`)).toThrow(/first line/);
    expect(() => codec.read('# Just prose\n')).toThrow(/first line/);
  });

  it.each([
    ['a non-mapping root', '---\n- one\n- two\n---', /mapping/],
    ['a duplicate key', '---\nname: a\nname: b\n---', /Malformed/],
    ['an anchor', '---\nbase: &b 1\nnext: *b\n---', /aliases, anchors and tags/],
    ['a tag', '---\nwhen: !!str 2020\n---', /aliases, anchors and tags/],
    ['a non-finite number', '---\nx: .inf\n---', /non-finite/],
    ['a block past 64 KiB', `---\nx: ${'a'.repeat(70_000)}\n---`, /64 KiB/],
  ])('refuses %s by name', (_what, block, reason) => {
    expect(() => codec.read(block)).toThrow(reason);
  });

  it('refuses YAML deeper than 32 levels', () => {
    const deep = `---\n${Array.from({ length: 40 }, (_, i) => `${' '.repeat(i)}k${i}:`).join('\n')} 1\n---`;
    expect(() => codec.read(deep)).toThrow(/depth or node/);
  });
});

describe('frontmatterCodec.patch', () => {
  it('replaces a scalar in place and keeps comments, quoting, order and unknown keys', () => {
    const patched = codec.patch(BLOCK, { ...(codec.read(BLOCK) as object), name: 'Ada L' });
    expect(patched).toBe(BLOCK.replace("'Ada'", "'Ada L'"));
    expect(codec.read(patched)).toEqual({ ...(codec.read(BLOCK) as object), name: 'Ada L' });
  });

  it('keeps CRLF line endings', () => {
    const crlf = BLOCK.replaceAll('\n', '\r\n');
    const patched = codec.patch(crlf, { ...(codec.read(crlf) as object), status: 'final' });
    expect(patched).toBe(crlf.replace('status: draft', 'status: final'));
  });

  it('patches an equal-length sequence element by element', () => {
    const values = { ...(codec.read(BLOCK) as object), palette: ['#000000', '#e8c8b0'] };
    expect(codec.patch(BLOCK, values)).toBe(BLOCK.replace('"#a02828"', '"#000000"'));
  });

  it('appends a new top-level key and removes a dropped one whole', () => {
    const before = codec.read(BLOCK) as Record<string, unknown>;
    const { unknown: _dropped, ...rest } = before;
    const patched = codec.patch(BLOCK, { ...rest, seed: 7 });
    expect(patched).toBe(
      BLOCK.replace('unknown: [one, two]\n', '').replace('\n---', '\n"seed": 7\n---'),
    );
    expect(codec.read(patched)).toEqual({ ...rest, seed: 7 });
  });

  it('rewrites a reshaped collection whole, as flow YAML, when nothing in it is a comment', () => {
    const before = codec.read(BLOCK) as Record<string, unknown>;
    const patched = codec.patch(BLOCK, { ...before, palette: ['#000000'] });
    expect(patched).toBe(BLOCK.replace('- "#a02828"\n  - "#e8c8b0"', '["#000000"]'));
    expect(codec.read(patched)).toEqual({ ...before, palette: ['#000000'] });
  });

  it('refuses a block scalar and a commented collection', () => {
    const literal = '---\nbio: |\n  two\n  lines\n---';
    expect(() => codec.patch(literal, { bio: 'one line' })).toThrow(/block scalar/);
    const commented = '---\nlist:\n  # why\n  - a\n---';
    expect(() => codec.patch(commented, { list: 'a' })).toThrow(/raw source editing/);
  });

  it('round-trips every template sheet through an identity patch', () => {
    for (const { block } of sheets()) {
      expect(codec.patch(block, codec.read(block))).toBe(block);
    }
  });
});
