import { parseFountain } from '@vn/parse';
import { sceneChunksFromScript } from '../screenplay.js';
import { splitScenes } from '../scenes.js';
import { sceneToDoc } from '../serialize.js';

/** One scene with whatever note the case is about sitting under the heading. */
const SCRIPT = (note: string): string => `INT. ROOF - NIGHT

[[scene: rooftop]]
${note}
She hesitates.
`;

const diagnose = (note: string) => splitScenes(parseFountain(SCRIPT(note))).diagnostics;

describe('a note no branch marker parses', () => {
  it('errors on a choice whose arrow is wrong, because the edge is lost in silence', () => {
    const [d, ...rest] = diagnose('[[choice: "Tell the truth" => s13]]');
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      severity: 'error',
      code: 'unparsed_branch_marker',
      where: 'rooftop',
    });
    expect(d?.message).toContain('"Tell the truth" => s13');
    // The half worth proving: the typo really does change the story graph.
    expect(splitScenes(parseFountain(SCRIPT('[[choice: "x" => s13]]'))).scenes[0]?.choices).toEqual(
      [],
    );
  });

  it('errors on a next or a line that does not parse', () => {
    expect(diagnose('[[next:]]')[0]).toMatchObject({
      severity: 'error',
      code: 'unparsed_branch_marker',
    });
    expect(diagnose('[[goto:]]')[0]).toMatchObject({
      severity: 'error',
      code: 'unparsed_branch_marker',
    });
    expect(diagnose('[[line: L 4]]')[0]).toMatchObject({
      severity: 'error',
      code: 'unparsed_branch_marker',
    });
  });

  it('warns on the three keys that document a fallback to a plain note', () => {
    for (const note of ['[[outfit: aiko]]', '[[nextline: soon]]', '[[scene:]]']) {
      expect(diagnose(note)[0]).toMatchObject({ severity: 'warning', code: 'unknown_marker' });
    }
  });

  it('warns on any other key: value note, which is what an invented notation looks like', () => {
    const [d] = diagnose('[[if: ember]]');
    expect(d).toMatchObject({ severity: 'warning', code: 'unknown_marker' });
    expect(d?.message).toContain('absent from the scene the next time it is written');
  });

  it('says nothing about a note with no colon', () => {
    expect(diagnose('[[fix the ending before the reread]]')).toEqual([]);
  });

  it('reports one stranded above the first heading, with no scene to blame', () => {
    const [d, ...rest] = splitScenes(
      parseFountain('[[if: ember]]\n\nINT. ROOF - NIGHT\n\nShe waits.\n'),
    ).diagnostics;
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ code: 'unknown_marker' });
    expect(d?.where).toBeUndefined();
  });

  it('names the scene the chunk is, not the [[scene:]] id it overrode', () => {
    const { diagnostics } = splitScenes(parseFountain(SCRIPT('[[if: ember]]')), {
      sceneId: 'rooftop_a',
    });
    const d = diagnostics.find((x) => x.code === 'unknown_marker');
    expect(d?.where).toBe('rooftop_a');
    expect(d?.message).toContain('scene rooftop_a');
  });

  it('is gone from the scene the next time it is written, which is what the message says', () => {
    const scene = splitScenes(parseFountain(SCRIPT('[[if: ember]]'))).scenes[0]!;
    expect(sceneToDoc(scene).body).not.toContain('ember');
  });

  it('reaches a screenplay import once, not twice', () => {
    const diagnostics = sceneChunksFromScript(parseFountain(SCRIPT('[[if: ember]]'))).diagnostics;
    expect(diagnostics.filter((d) => d.code === 'unknown_marker')).toHaveLength(1);
  });
});
