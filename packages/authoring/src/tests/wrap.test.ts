import { overlongLines, wrapWarning, WRAP_COLUMNS } from '../wrap.js';

const long = (n: number): string => Array.from({ length: n }, () => 'word').join(' ');

describe('overlongLines', () => {
  it('says nothing about prose already inside the limit', () => {
    expect(overlongLines('a short line\nand another\n')).toEqual([]);
  });

  it('names the line, 1-based, when prose runs over', () => {
    expect(overlongLines(`ok\n${long(40)}\nok`)).toEqual([2]);
  });

  it('leaves a fenced code block alone, and resumes after it', () => {
    const text = ['```ts', long(40), '```', long(40)].join('\n');
    expect(overlongLines(text)).toEqual([4]);
  });

  it('leaves a table row alone — one row per line is what a table is', () => {
    expect(overlongLines(`| ${long(40)} |`)).toEqual([]);
  });

  it('leaves a line held long by one unbreakable word — there is nowhere to break it', () => {
    expect(overlongLines(`See https://example.com/${'x'.repeat(120)}`)).toEqual([]);
  });
});

describe('wrapWarning', () => {
  it('is empty for a file that wrapped', () => {
    expect(wrapWarning('fine\n')).toBe('');
  });

  it('names the lines and the limit', () => {
    const warning = wrapWarning(`${long(40)}\n${long(40)}`);
    expect(warning).toContain('2 line(s)');
    expect(warning).toContain(String(WRAP_COLUMNS));
    expect(warning).toContain('line 1, 2');
  });

  it('counts the rest rather than listing every line of a whole bad file', () => {
    expect(wrapWarning(Array.from({ length: 12 }, () => long(40)).join('\n'))).toContain(
      'and 4 more',
    );
  });
});
