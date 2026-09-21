import {
  parseChanges,
  parseCheckpoints,
  parseHistory,
  parseNumstat,
  parseStatusV2,
  parseTrailers,
  slugOf,
  uniqueSlug,
} from '../parse.js';

const U = '\x1f';
const R = '\x1e';

/** One log record as `HISTORY_FORMAT` prints it, followed by its numstat block. */
function record(
  fields: { sha: string; parents?: string; subject: string; body?: string; trailers?: string },
  numstat: string,
): string {
  const head = [
    fields.sha,
    fields.parents ?? '',
    'Mara',
    'mara@example.com',
    '2026-09-20T18:42:00-07:00',
    fields.subject,
    fields.body ?? '',
    fields.trailers ?? '',
  ].join(U);
  return `${R}${head}${U}\n\n${numstat}`;
}

describe('parseTrailers', () => {
  it('reads key-value lines and joins a folded continuation', () => {
    expect(parseTrailers('Vn-Command: doc.write\nVn-Invocation: doc.write(\n  path=x)\n')).toEqual({
      'Vn-Command'   : 'doc.write',
      'Vn-Invocation': 'doc.write( path=x)',
    });
  });

  it('keeps the last value of a repeated key', () => {
    expect(parseTrailers('K: a\nK: b')).toEqual({ K: 'b' });
  });
});

describe('parseNumstat', () => {
  it('counts lines, marks a binary with nulls, and reads both rename spellings', () => {
    expect(
      parseNumstat('3\t1\ta.md\n-\t-\tpic.png\n0\t0\tdir/{old.md => new.md}\n1\t0\tx => y\n'),
    ).toEqual([
      { path: 'a.md', added: 3, removed: 1 },
      { path: 'pic.png', added: null, removed: null },
      { path: 'dir/new.md', oldPath: 'dir/old.md', added: 0, removed: 0 },
      { path: 'y', oldPath: 'x', added: 1, removed: 0 },
    ]);
  });
});

describe('parseHistory', () => {
  it('splits records, subtracts the trailer block from the body, and attaches files', () => {
    const trailers = 'Vn-Command: doc.write\nVn-Seq: 3';
    const out = parseHistory(
      record(
        {
          sha    : 'b'.repeat(40),
          parents: 'a'.repeat(40),
          subject: 'Second',
          body   : `Body line.\n\n${trailers}\n`,
          trailers,
        },
        '0\t2\ta.txt\n4\t0\tdir with space/b.txt\n',
      ) + record({ sha: 'a'.repeat(40), subject: 'First' }, '2\t0\ta.txt\n-\t-\tbin.dat\n'),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      sha     : 'b'.repeat(40),
      parents : ['a'.repeat(40)],
      author  : 'Mara',
      email   : 'mara@example.com',
      subject : 'Second',
      body    : 'Body line.',
      trailers: { 'Vn-Command': 'doc.write', 'Vn-Seq': '3' },
    });
    expect(out[0]!.files.map((f) => f.path)).toEqual(['a.txt', 'dir with space/b.txt']);
    expect(out[1]).toMatchObject({ parents: [], body: '', trailers: {} });
    expect(out[1]!.files[1]).toEqual({ path: 'bin.dat', added: null, removed: null });
  });

  it('answers nothing for empty output', () => {
    expect(parseHistory('')).toEqual([]);
  });
});

describe('parseChanges', () => {
  it('joins raw lines to numstat lines by path, with null blobs for an absent side', () => {
    const zero = '0'.repeat(40);
    const one = '1'.repeat(40);
    const two = '2'.repeat(40);
    const out = parseChanges(
      `:100644 000000 ${one} ${zero} D\ta.txt\n` +
        `:000000 100644 ${zero} ${two} A\tdir with space/b.txt\n` +
        `:100644 100644 ${one} ${one} R100\told.md\tnew.md\n` +
        '0\t2\ta.txt\n4\t0\tdir with space/b.txt\n0\t0\t{old.md => new.md}\n',
    );
    expect(out).toEqual([
      { path: 'a.txt', status: 'D', oldBlob: one, newBlob: null, added: 0, removed: 2 },
      {
        path   : 'dir with space/b.txt',
        status : 'A',
        oldBlob: null,
        newBlob: two,
        added  : 4,
        removed: 0,
      },
      {
        path   : 'new.md',
        oldPath: 'old.md',
        status : 'R',
        oldBlob: one,
        newBlob: one,
        added  : 0,
        removed: 0,
      },
    ]);
  });
});

describe('parseStatusV2', () => {
  it('reads the branch header, an ordinary entry, a rename, a conflict and an untracked path', () => {
    const h = 'a'.repeat(40);
    const out = parseStatusV2(
      `# branch.oid ${h}\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +3 -1\n` +
        `1 .M N... 100644 100644 100644 ${h} ${h} dir with space/c.txt\n` +
        `2 R. N... 100644 100644 100644 ${h} ${h} R100 new.md\told.md\n` +
        `u DU N... 100644 000000 100644 100644 ${h} ${h} ${h} a.txt\n` +
        '? untracked.txt\n! ignored.txt\n',
    );
    expect(out).toEqual({
      oid     : h,
      head    : 'main',
      upstream: 'origin/main',
      ahead   : 3,
      behind  : 1,
      entries: [
        { x: '.', y: 'M', path: 'dir with space/c.txt', unmerged: false },
        { x: 'R', y: '.', path: 'new.md', origPath: 'old.md', unmerged: false },
        { x: 'D', y: 'U', path: 'a.txt', unmerged: true },
        { x: '?', y: '?', path: 'untracked.txt', unmerged: false },
      ],
    });
  });

  it('answers null for a detached head, an unborn branch and unknown counts', () => {
    expect(parseStatusV2('# branch.oid (initial)\n# branch.head (detached)\n')).toEqual({
      oid     : null,
      head    : null,
      upstream: null,
      ahead   : null,
      behind  : null,
      entries : [],
    });
  });
});

describe('parseCheckpoints', () => {
  it('splits the name from the note and skips refs outside the prefix', () => {
    const out = parseCheckpoints(
      `refs/tags/vn/checkpoint/before-rain${U}${'a'.repeat(40)}${U}${'b'.repeat(40)}${U}2026-09-20T18:42:00-07:00${U}before rain\n\nthe note\n${R}\n` +
        `refs/tags/v1${U}${U}${'c'.repeat(40)}${U}${U}v1\n${R}\n`,
    );
    expect(out).toEqual([
      {
        slug    : 'before-rain',
        name    : 'before rain',
        note    : 'the note',
        sha     : 'a'.repeat(40),
        tagSha  : 'b'.repeat(40),
        taggedAt: '2026-09-20T18:42:00-07:00',
      },
    ]);
  });
});

describe('slugOf', () => {
  it('lowercases, hyphenates, strips accents and what git refuses, and is never empty', () => {
    expect(slugOf('Before the rain pass')).toBe('before-the-rain-pass');
    expect(slugOf('Café ~^:?*[\\ scene')).toBe('cafe-scene');
    expect(slugOf('..lead..dots..')).toBe('lead.dots');
    expect(slugOf('final.lock')).toBe('final');
    expect(slugOf('@{weird}')).toBe('weird');
    expect(slugOf('   ')).toBe('checkpoint');
  });

  it('suffixes a taken slug', () => {
    expect(uniqueSlug('Act two', new Set(['act-two', 'act-two-2']))).toBe('act-two-3');
    expect(uniqueSlug('Act two', new Set())).toBe('act-two');
  });
});
