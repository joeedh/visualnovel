import { lineDiff, unifiedDiff } from '../diff.js';

describe('lineDiff', () => {
  it('keeps the common lines and marks the rest by which text has them', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nx\nc\nd\n')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
  });

  it('treats an empty text as no lines, so a new file is all additions', () => {
    expect(lineDiff('', 'one\ntwo')).toEqual([
      { kind: 'added', text: 'one' },
      { kind: 'added', text: 'two' },
    ]);
    expect(lineDiff('one', '')).toEqual([{ kind: 'removed', text: 'one' }]);
  });
});

describe('unifiedDiff', () => {
  const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].join('\n');

  it('is empty for identical texts', () => {
    expect(unifiedDiff(before, before)).toBe('');
  });

  it('writes one hunk with three lines of context and git’s header', () => {
    const after = before.replace('\n6\n', '\nsix\n');
    expect(unifiedDiff(before, after)).toBe(
      ['@@ -3,7 +3,7 @@', ' 3', ' 4', ' 5', '-6', '+six', ' 7', ' 8', ' 9'].join('\n'),
    );
  });

  it('splits changes far apart into separate hunks and merges near ones', () => {
    const far = before.replace('\n2\n', '\ntwo\n').replace('\n11\n', '\neleven\n');
    const hunks = unifiedDiff(far, before)
      .split('\n')
      .filter((l) => l.startsWith('@@'));
    expect(hunks).toEqual(['@@ -1,5 +1,5 @@', '@@ -8,5 +8,5 @@']);

    const near = before.replace('\n5\n', '\nfive\n').replace('\n8\n', '\neight\n');
    expect(
      unifiedDiff(before, near)
        .split('\n')
        .filter((l) => l.startsWith('@@')),
    ).toHaveLength(1);
  });

  it('counts a new file from line one with nothing removed', () => {
    expect(unifiedDiff('', 'a\nb')).toBe('@@ -0,0 +1,2 @@\n+a\n+b');
  });
});
