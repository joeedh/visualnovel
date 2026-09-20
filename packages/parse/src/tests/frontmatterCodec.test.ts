import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  frontmatterCodec as codec,
  parseFrontMatter,
  splitFrontMatter,
  type JsonValue,
} from '../index.js';

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

  it('appends a new top-level key as YAML and removes a dropped one whole', () => {
    const before = codec.read(BLOCK) as Record<string, unknown>;
    const { unknown: _dropped, ...rest } = before;
    const patched = codec.patch(BLOCK, { ...rest, seed: 7 });
    expect(patched).toBe(
      BLOCK.replace('unknown: [one, two]\n', '').replace('\n---', '\nseed: 7\n---'),
    );
    expect(codec.read(patched)).toEqual({ ...rest, seed: 7 });
  });

  it('removes a dropped item from a block sequence rather than rewriting it', () => {
    const before = codec.read(BLOCK) as Record<string, unknown>;
    const patched = codec.patch(BLOCK, { ...before, palette: ['#e8c8b0'] });
    expect(patched).toBe(BLOCK.replace('  - "#a02828"\n', ''));
    expect(codec.read(patched)).toEqual({ ...before, palette: ['#e8c8b0'] });
  });

  it('refuses a commented collection it would have to rewrite', () => {
    const commented = '---\nlist:\n  # why\n  - a\n---';
    expect(() => codec.patch(commented, { list: 'a' })).toThrow(/raw source editing/);
  });

  describe('structural edits', () => {
    const SHEET = [
      '---',
      'name: Ada',
      'outfits:',
      '  uniform: Navy blazer # the everyday one',
      '  gala: Emerald gown',
      'palette:',
      '  - "#a02828"',
      '  - "#e8c8b0"',
      'tags: [day, night]',
      'bio: |',
      '  Two lines',
      '  of prose.',
      'variants:',
      '  - dawn',
      '  - id: dusk',
      '    art_notes: warm light',
      '---',
    ].join('\n');
    type Sheet = {
      [key: string]: JsonValue;
      outfits: Record<string, JsonValue>;
      palette: string[];
      tags: string[];
      bio: string;
      variants: JsonValue[];
    };
    const base = () => codec.read(SHEET) as Sheet;

    it('appends a key to a block map after a commented entry, at its indent', () => {
      const values = base();
      values.outfits = { ...values.outfits, track: 'Red shorts' };
      const patched = codec.patch(SHEET, values);
      expect(patched).toBe(
        SHEET.replace('  gala: Emerald gown\n', '  gala: Emerald gown\n  track: Red shorts\n'),
      );
      expect(codec.read(patched)).toEqual(values);
    });

    it('appends a nested entry as block YAML', () => {
      const values = base();
      values.outfits = { ...values.outfits, track: { description: 'Red shorts', seed: 3 } };
      const patched = codec.patch(SHEET, values);
      expect(patched).toContain(
        '  gala: Emerald gown\n  track:\n    description: Red shorts\n    seed: 3\n',
      );
      expect(codec.read(patched)).toEqual(values);
    });

    it('removes a key from the middle of a block map with its lines', () => {
      const values = base();
      const { uniform: _gone, ...rest } = values.outfits;
      values.outfits = rest;
      expect(() => codec.patch(SHEET, values)).toThrow(/Removing this field requires raw source/);
      const plain = SHEET.replace(' # the everyday one', '');
      const patched = codec.patch(plain, values);
      expect(patched).toBe(plain.replace('  uniform: Navy blazer\n', ''));
    });

    it('renames a key at the same position and keeps its lines byte for byte', () => {
      const values = base();
      values.outfits = { uniform: values.outfits.uniform!, formal: values.outfits.gala! };
      const patched = codec.patch(SHEET, values);
      expect(patched).toBe(SHEET.replace('  gala: Emerald gown', '  formal: Emerald gown'));
      expect(codec.read(patched)).toEqual(values);
    });

    it('refuses to rename an entry that carries a comment', () => {
      const values = base();
      values.outfits = { everyday: values.outfits.uniform!, gala: values.outfits.gala! };
      expect(() => codec.patch(SHEET, values)).toThrow(/Renaming this field requires raw source/);
    });

    it('treats a rename with a changed value as a removal and an addition', () => {
      const values = base();
      values.outfits = { uniform: values.outfits.uniform!, formal: 'Silver gown' };
      const patched = codec.patch(SHEET, values);
      expect(patched).toBe(SHEET.replace('  gala: Emerald gown\n', '  formal: Silver gown\n'));
    });

    it('appends to and removes from a block sequence', () => {
      const values = base();
      values.palette = ['#a02828', '#e8c8b0', '#102030'];
      let patched = codec.patch(SHEET, values);
      expect(patched).toBe(SHEET.replace('  - "#e8c8b0"\n', '  - "#e8c8b0"\n  - "#102030"\n'));
      values.palette = ['#e8c8b0', '#102030'];
      patched = codec.patch(patched, values);
      expect(patched).toBe(
        SHEET.replace('  - "#a02828"\n  - "#e8c8b0"\n', '  - "#e8c8b0"\n  - "#102030"\n'),
      );
      expect(codec.read(patched)).toEqual(values);
    });

    it('inserts an item before the next kept one and patches a replaced one in place', () => {
      const values = base();
      values.palette = ['#a02828', '#ffffff', '#e8c8b0'];
      expect(codec.patch(SHEET, values)).toBe(
        SHEET.replace('  - "#a02828"\n', '  - "#a02828"\n  - "#ffffff"\n'),
      );
      values.palette = ['#000000', '#e8c8b0', '#ffffff'];
      expect(codec.patch(SHEET, values)).toBe(
        SHEET.replace('"#a02828"', '"#000000"').replace(
          '  - "#e8c8b0"\n',
          '  - "#e8c8b0"\n  - "#ffffff"\n',
        ),
      );
    });

    it('adds a map item to a block sequence as block YAML and edits one entry by entry', () => {
      const values = base();
      values.variants = [...values.variants, { id: 'noon', art_notes: 'flat light' }];
      let patched = codec.patch(SHEET, values);
      expect(patched).toContain(
        '    art_notes: warm light\n  - id: noon\n    art_notes: flat light\n',
      );
      values.variants = ['dawn', { id: 'dusk', art_notes: 'warm light', seed: 9 }];
      patched = codec.patch(SHEET, values);
      expect(patched).toBe(
        SHEET.replace('    art_notes: warm light\n', '    art_notes: warm light\n    seed: 9\n'),
      );
      expect(codec.read(patched)).toEqual(values);
    });

    it('rewrites a flow sequence of scalars as a flow sequence', () => {
      const values = base();
      values.tags = ['day', 'night', 'dusk'];
      expect(codec.patch(SHEET, values)).toBe(SHEET.replace('[day, night]', '[day, night, dusk]'));
      values.tags = ['day', 'a: b'];
      expect(codec.patch(SHEET, values)).toBe(SHEET.replace('[day, night]', '[day, "a: b"]'));
    });

    it('rewrites a block scalar at its own indent, and as a quoted line when it has one', () => {
      const values = base();
      values.bio = 'Three\nlines\nnow.\n';
      let patched = codec.patch(SHEET, values);
      expect(patched).toBe(
        SHEET.replace('bio: |\n  Two lines\n  of prose.\n', 'bio: |\n  Three\n  lines\n  now.\n'),
      );
      expect(codec.read(patched)).toEqual(values);
      values.bio = 'One line';
      patched = codec.patch(SHEET, values);
      expect(patched).toBe(
        SHEET.replace('bio: |\n  Two lines\n  of prose.\n', 'bio: "One line"\n'),
      );
    });

    it('keeps Windows line endings through a structural edit', () => {
      const crlf = SHEET.replaceAll('\n', '\r\n');
      const values = codec.read(crlf) as Sheet;
      values.outfits = { ...values.outfits, track: 'Red shorts' };
      values.palette = ['#e8c8b0'];
      const patched = codec.patch(crlf, values);
      expect(patched).toBe(
        crlf
          .replace('  gala: Emerald gown\r\n', '  gala: Emerald gown\r\n  track: Red shorts\r\n')
          .replace('  - "#a02828"\r\n', ''),
      );
      expect(patched).not.toMatch(/[^\r]\n/);
    });

    it('empties a collection inline and refuses a commented removal', () => {
      const values = base();
      values.palette = [];
      expect(codec.patch(SHEET, values)).toBe(
        SHEET.replace('  - "#a02828"\n  - "#e8c8b0"', '  []'),
      );
      const commented = '---\nlist:\n  - a\n  - b # keep\n---';
      expect(() => codec.patch(commented, { list: ['a'] })).toThrow(
        /Removing this item requires raw source/,
      );
    });
  });

  it('round-trips every template sheet through an identity patch', () => {
    for (const { block } of sheets()) {
      expect(codec.patch(block, codec.read(block))).toBe(block);
    }
  });
});
