import { classify } from '../scene.js';
import { linesOf, withContext } from '../spans.js';
import type { DiffParagraph } from '../../../../../../src/shared/history.js';

const same = (text: string): DiffParagraph => ({ kind: 'same', spans: [{ kind: 'same', text }] });
const changed = (spans: DiffParagraph['spans']): DiffParagraph => ({ kind: 'changed', spans });

describe('withContext', () => {
  it('keeps two unchanged paragraphs either side of a change and folds a longer run', () => {
    const paragraphs = [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map(same),
      changed([{ kind: 'removed', text: 'x' }]),
      ...['g', 'h', 'i'].map(same),
    ];
    expect(
      withContext(paragraphs).map((s) =>
        s.kind === 'fold' ? `fold ${s.count}` : s.paragraph.spans[0]!.text,
      ),
    ).toEqual(['fold 4', 'e', 'f', 'x', 'g', 'h', 'i']);
  });

  it('shows a run too short to be worth folding', () => {
    const paragraphs = [
      changed([{ kind: 'added', text: 'x' }]),
      ...['a', 'b', 'c', 'd', 'e'].map(same),
      changed([{ kind: 'added', text: 'y' }]),
    ];
    expect(withContext(paragraphs).every((s) => s.kind === 'paragraph')).toBe(true);
  });

  it('shows a diff with no change whole', () => {
    expect(withContext(['a', 'b', 'c'].map(same))).toHaveLength(3);
  });
});

describe('linesOf', () => {
  it('splits spans at newlines, keeping each word’s mark on its line', () => {
    const lines = linesOf(
      changed([
        { kind: 'same', text: 'MARA\n' },
        { kind: 'removed', text: 'Not ' },
        { kind: 'added', text: 'Never ' },
        { kind: 'same', text: 'to you.\nNot out loud.' },
      ]),
    );
    expect(lines.map((l) => l.text)).toEqual(['MARA', 'Not Never to you.', 'Not out loud.']);
    expect(lines[1]!.spans.map((s) => s.kind)).toEqual(['removed', 'added', 'same']);
  });

  it('drops the blank line a trailing newline would make', () => {
    expect(linesOf(same('one\ntwo\n')).map((l) => l.text)).toEqual(['one', 'two']);
  });
});

describe('classify', () => {
  const lines = (text: string) => linesOf(same(text));

  it('reads a cue over its dialogue, with the line ids and a parenthetical', () => {
    expect(
      classify(lines('HEADMISTRESS COYLE\n[[line: L8]]\nWelcome, intake.\n(beat)\nSit.'), false),
    ).toEqual(['cue', 'marker', 'dialogue', 'parenthetical', 'dialogue']);
  });

  it('reads a lone uppercase line as action, since nothing is spoken under it', () => {
    expect(classify(lines('SILENCE.'), false)).toEqual(['action']);
    expect(classify(lines('[[line: L7]]\nThe gates of the college.'), false)).toEqual([
      'marker',
      'action',
    ]);
  });

  it('reads headings, transitions, markers and front matter', () => {
    expect(classify(lines('EXT. COG COLLEGE - DUSK'), false)).toEqual(['heading']);
    expect(classify(lines('CUT TO:'), false)).toEqual(['transition']);
    expect(classify(lines('[[next: c02]]\n[[nextline: 12]]'), false)).toEqual(['marker', 'marker']);
    expect(classify(lines('---\nscene: c01\n---'), true)).toEqual(['data', 'data', 'data']);
  });
});
