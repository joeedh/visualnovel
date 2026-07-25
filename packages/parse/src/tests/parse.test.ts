import {
  parseBranchMarker,
  parseFountain,
  parseFrontMatter,
  stringifyFrontMatter,
} from '../index.js';

const SAMPLE = `Title: The Long Afternoon
Author: Jane Doe

# Act One

= Aiko waits for someone who may not come.

INT. CLASSROOM - AFTERNOON #s12#

[[scene: s12_classroom]]

Empty desks. Late light through tall windows. AIKO sits alone.

AIKO
(to herself)
Five more minutes.

The door slides open.

REN
Sorry. The train was late.

[[choice: "Tell her the truth" -> s13_truth]]
[[choice: "Stay silent" -> s13_silent]]

CUT TO:

.FLASHBACK

The city spreads out below.

===
`;

describe('parseFountain', () => {
  const script = parseFountain(SAMPLE);

  it('reads the title page', () => {
    expect(script.title['title']).toBe('The Long Afternoon');
    expect(script.title['author']).toBe('Jane Doe');
  });

  it('detects scene headings with scene numbers and forced headings', () => {
    const headings = script.elements.filter((e) => e.type === 'scene_heading');
    expect(headings).toHaveLength(2);
    expect(headings[0]).toMatchObject({ text: 'INT. CLASSROOM - AFTERNOON', sceneNumber: 's12' });
    expect(headings[1]).toMatchObject({ text: 'FLASHBACK' });
  });

  it('detects character cues and their dialogue', () => {
    const chars = script.elements.filter((e) => e.type === 'character').map((e) => e.name);
    expect(chars).toEqual(['AIKO', 'REN']);
    const paren = script.elements.find((e) => e.type === 'parenthetical');
    expect(paren).toMatchObject({ text: 'to herself' });
  });

  it('detects a transition', () => {
    expect(script.elements.some((e) => e.type === 'transition' && e.text === 'CUT TO:')).toBe(true);
  });

  it('preserves notes (branch markers) as note elements', () => {
    const notes = script.elements.filter((e) => e.type === 'note').map((e) => e.text);
    expect(notes).toContain('scene: s12_classroom');
    expect(notes).toContain('choice: "Tell her the truth" -> s13_truth');
  });

  it('emits a section and a synopsis', () => {
    expect(script.elements.some((e) => e.type === 'section' && e.text === 'Act One')).toBe(true);
    expect(script.elements.some((e) => e.type === 'synopsis')).toBe(true);
  });
});

describe('parseBranchMarker', () => {
  it('parses scene ids', () => {
    expect(parseBranchMarker('scene: s12_classroom')).toEqual({
      kind: 'scene',
      id: 's12_classroom',
    });
  });
  it('parses labeled choices', () => {
    expect(parseBranchMarker('choice: "Tell the truth" -> s13')).toEqual({
      kind: 'choice',
      label: 'Tell the truth',
      goto: 's13',
    });
  });
  it('parses next/goto', () => {
    expect(parseBranchMarker('next: s13')).toEqual({ kind: 'next', goto: 's13' });
    expect(parseBranchMarker('goto: s99')).toEqual({ kind: 'next', goto: 's99' });
  });
  it('ignores plain notes', () => {
    expect(parseBranchMarker('is this too on-the-nose?')).toBeNull();
  });
});

describe('front-matter', () => {
  it('round-trips data and body', () => {
    const text = '---\nid: aiko\nstatus: approved\n---\n\n# Aiko\n\nbody text\n';
    const doc = parseFrontMatter(text);
    expect(doc.data).toMatchObject({ id: 'aiko', status: 'approved' });
    expect(doc.body.trim()).toBe('# Aiko\n\nbody text');
    const reparsed = parseFrontMatter(stringifyFrontMatter(doc.data, doc.body));
    expect(reparsed.data).toEqual(doc.data);
  });

  it('treats a file without front-matter as all body', () => {
    const doc = parseFrontMatter('# Just markdown\n');
    expect(doc.data).toEqual({});
    expect(doc.body).toBe('# Just markdown\n');
  });
});
