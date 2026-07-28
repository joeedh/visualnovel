/**
 * The patcher's contract is "only marker lines change, and a patch that would not re-parse to
 * the intended graph does not land at all". Most of these assert on the *whole file text*
 * rather than on the re-parsed graph, because preserving untouched bytes is the point — a
 * graph assertion would pass on a file whose prose had been rewritten.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFountain } from '@vn/parse';
import { applySceneBranchEdit, type SceneBranchEdit } from '../branchpatch.js';
import { splitScenes } from '../scenes.js';

const SCRIPT = [
  'INT. DORM ROOM - DAY',
  '',
  '[[scene: arrival]]',
  '[[choice: "Introduce yourself" -> greet]]',
  '[[choice: "Stay quiet" -> rooftop]]',
  '',
  '= Aiko arrives.',
  '',
  'She sets down her bag.',
  '',
  'AIKO',
  'Um... hello.',
  '',
  'INT. ROOFTOP - NIGHT',
  '',
  '[[scene: rooftop]]',
  '[[next: greet]]',
  '',
  'The city hums below.',
  '',
  'INT. HALLWAY - DAY',
  '',
  '[[scene: greet]]',
  '',
  'Footsteps echo.',
  '',
].join('\n');

const scenesOf = (text: string) => splitScenes(parseFountain(text)).scenes;
const sceneNamed = (text: string, id: string) => scenesOf(text).find((s) => s.id === id);

describe('applySceneBranchEdit', () => {
  it('changes only the marker lines it was asked to change', () => {
    const { text, diagnostics } = applySceneBranchEdit(SCRIPT, [
      { sceneId: 'arrival', choices: [{ label: 'Introduce yourself', goto: 'greet' }] },
    ]);
    expect(diagnostics).toEqual([]);

    const before = SCRIPT.split('\n');
    const after = text.split('\n');
    const removed = before.filter((l) => !after.includes(l));
    expect(removed).toEqual(['[[choice: "Stay quiet" -> rooftop]]']);
    // Prose, synopsis, cues and blank-line structure are byte-identical.
    expect(after.filter((l) => !l.startsWith('[['))).toEqual(
      before.filter((l) => !l.startsWith('[[')),
    );
  });

  it('adds, relabels and removes choices', () => {
    const added = applySceneBranchEdit(SCRIPT, [
      {
        sceneId: 'arrival',
        choices: [
          { label: 'Introduce yourself', goto: 'greet' },
          { label: 'Stay quiet', goto: 'rooftop' },
          { label: 'Slip out', goto: 'greet' },
        ],
      },
    ]);
    expect(sceneNamed(added.text, 'arrival')?.choices).toEqual([
      { label: 'Introduce yourself', goto: 'greet' },
      { label: 'Stay quiet', goto: 'rooftop' },
      { label: 'Slip out', goto: 'greet' },
    ]);

    const relabelled = applySceneBranchEdit(SCRIPT, [
      { sceneId: 'arrival', choices: [{ label: 'Say something', goto: 'greet' }] },
    ]);
    expect(relabelled.text).toContain('[[choice: "Say something" -> greet]]');
    expect(relabelled.text).not.toContain('Introduce yourself');

    const cleared = applySceneBranchEdit(SCRIPT, [{ sceneId: 'arrival', choices: [] }]);
    expect(sceneNamed(cleared.text, 'arrival')?.choices).toEqual([]);
    expect(cleared.text).not.toContain('[[choice:');
  });

  it('sets and clears next', () => {
    const set = applySceneBranchEdit(SCRIPT, [{ sceneId: 'greet', next: 'rooftop' }]);
    expect(set.diagnostics).toEqual([]);
    expect(sceneNamed(set.text, 'greet')?.next).toBe('rooftop');

    const cleared = applySceneBranchEdit(SCRIPT, [{ sceneId: 'rooftop', next: null }]);
    expect(sceneNamed(cleared.text, 'rooftop')?.next).toBeUndefined();
    expect(cleared.text).not.toContain('[[next:');
  });

  it('writes new markers after the scene marker when the scene has none', () => {
    const { text } = applySceneBranchEdit(SCRIPT, [
      { sceneId: 'greet', choices: [{ label: 'Again', goto: 'arrival' }], next: 'rooftop' },
    ]);
    const lines = text.split('\n');
    const at = lines.indexOf('[[scene: greet]]');
    expect(lines.slice(at, at + 3)).toEqual([
      '[[scene: greet]]',
      '[[choice: "Again" -> arrival]]',
      '[[next: rooftop]]',
    ]);
  });

  it('places a fresh next after existing choices, not before them', () => {
    const { text } = applySceneBranchEdit(SCRIPT, [{ sceneId: 'arrival', next: 'rooftop' }]);
    const lines = text.split('\n');
    expect(lines.indexOf('[[next: rooftop]]')).toBeGreaterThan(
      lines.indexOf('[[choice: "Stay quiet" -> rooftop]]'),
    );
  });

  it('handles a scene with no markers at all, keyed by its derived id', () => {
    const bare = ['INT. GARDEN - DAY', '', 'Rain on the stones.', ''].join('\n');
    const id = scenesOf(bare)[0]?.id;
    expect(id).toBe('garden_1');

    const { text, diagnostics } = applySceneBranchEdit(bare, [
      { sceneId: 'garden_1', next: 'elsewhere' },
    ]);
    expect(diagnostics).toEqual([]);
    expect(text.split('\n').slice(0, 2)).toEqual(['INT. GARDEN - DAY', '[[next: elsewhere]]']);
    expect(scenesOf(text)[0]?.body).toBe('Rain on the stones.');
  });

  // The parser strips one leading and one trailing quote, and `->` splits at the *last*
  // viable arrow — so quoting is enough for both. `]]` is not recoverable at any quoting.
  it('round-trips a label containing quotes and an arrow, and rejects one containing ]]', () => {
    const tricky = 'He said "go" -> then left';
    const { text, diagnostics } = applySceneBranchEdit(SCRIPT, [
      { sceneId: 'arrival', choices: [{ label: tricky, goto: 'greet' }] },
    ]);
    expect(diagnostics).toEqual([]);
    expect(sceneNamed(text, 'arrival')?.choices).toEqual([{ label: tricky, goto: 'greet' }]);

    const bad = applySceneBranchEdit(SCRIPT, [
      { sceneId: 'arrival', choices: [{ label: 'oops ]] out', goto: 'greet' }] },
    ]);
    expect(bad.text).toBe(SCRIPT);
    expect(bad.diagnostics.map((d) => d.code)).toEqual(['branch_patch_label']);
  });

  it('rejects an unusable goto and an empty label without touching the file', () => {
    const spaced = applySceneBranchEdit(SCRIPT, [{ sceneId: 'arrival', next: 'two words' }]);
    expect(spaced.text).toBe(SCRIPT);
    expect(spaced.diagnostics.map((d) => d.code)).toEqual(['branch_patch_goto']);

    const empty = applySceneBranchEdit(SCRIPT, [
      { sceneId: 'arrival', choices: [{ label: '   ', goto: 'greet' }] },
    ]);
    expect(empty.text).toBe(SCRIPT);
    expect(empty.diagnostics.map((d) => d.code)).toEqual(['branch_patch_label']);
  });

  it('leaves the file byte-identical when a scene id does not exist', () => {
    const { text, diagnostics } = applySceneBranchEdit(SCRIPT, [
      { sceneId: 'nowhere', next: 'greet' },
    ]);
    expect(text).toBe(SCRIPT);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'branch_patch_scene',
        message: "no scene 'nowhere' in the screenplay",
        where: 'nowhere',
      },
    ]);
  });

  it('rejects two edits to the same scene rather than letting one win', () => {
    const { text, diagnostics } = applySceneBranchEdit(SCRIPT, [
      { sceneId: 'arrival', next: 'greet' },
      { sceneId: 'arrival', next: 'rooftop' },
    ]);
    expect(text).toBe(SCRIPT);
    expect(diagnostics.map((d) => d.code)).toEqual(['branch_patch_duplicate']);
  });

  it('keeps two scenes that share a heading apart by their marker ids', () => {
    const shared = [
      'INT. DORM ROOM - DAY',
      '',
      '[[scene: first]]',
      '[[next: second]]',
      '',
      'Morning.',
      '',
      'INT. DORM ROOM - DAY',
      '',
      '[[scene: second]]',
      '[[next: first]]',
      '',
      'Evening.',
      '',
    ].join('\n');

    const { text, diagnostics } = applySceneBranchEdit(shared, [{ sceneId: 'second', next: null }]);
    expect(diagnostics).toEqual([]);
    expect(sceneNamed(text, 'first')?.next).toBe('second');
    expect(sceneNamed(text, 'second')?.next).toBeUndefined();
  });

  it('applies a two-scene edit in one pass', () => {
    const { text, diagnostics } = applySceneBranchEdit(SCRIPT, [
      { sceneId: 'arrival', choices: [{ label: 'Introduce yourself', goto: 'rooftop' }] },
      { sceneId: 'rooftop', next: 'greet' },
    ]);
    expect(diagnostics).toEqual([]);
    expect(sceneNamed(text, 'arrival')?.choices).toEqual([
      { label: 'Introduce yourself', goto: 'rooftop' },
    ]);
    expect(sceneNamed(text, 'rooftop')?.next).toBe('greet');
  });

  it('leaves the file byte-identical when the second scene of a pair is missing', () => {
    const { text, diagnostics } = applySceneBranchEdit(SCRIPT, [
      { sceneId: 'arrival', choices: [{ label: 'Introduce yourself', goto: 'ghost' }] },
      { sceneId: 'ghost', next: 'greet' },
    ]);
    expect(text).toBe(SCRIPT);
    expect(diagnostics.map((d) => d.code)).toEqual(['branch_patch_scene']);
  });

  it('preserves boneyard, unknown notes and CRLF line endings', () => {
    const odd = [
      'INT. DORM ROOM - DAY',
      '',
      '[[scene: arrival]]',
      '[[next: greet]]',
      '[[todo: ask about the bag]]',
      '',
      '/* an editor note',
      '   spanning lines */',
      '',
      'She sets down her bag.',
      '',
      'INT. HALLWAY - DAY',
      '',
      '[[scene: greet]]',
      '',
      'Footsteps echo.',
      '',
    ].join('\r\n');

    const { text, diagnostics } = applySceneBranchEdit(odd, [
      { sceneId: 'arrival', next: 'greet', choices: [{ label: 'Wait', goto: 'greet' }] },
    ]);
    expect(diagnostics).toEqual([]);
    expect(text).toContain('[[todo: ask about the bag]]');
    expect(text).toContain('/* an editor note\r\n   spanning lines */');
    expect(text.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
  });

  // The two writers share a file. A rewire removes the wiring markers it replaces, and a
  // line-id mark is not one of them — eating one would silently re-point a shot's coverage.
  it('leaves line-id markers alone while rewiring around them', () => {
    const marked = [
      'INT. DORM ROOM - DAY',
      '',
      '[[scene: arrival]]',
      '[[nextline: 3]]',
      '[[next: greet]]',
      '',
      '[[line: L1]]',
      'She sets down her bag.',
      '',
      'INT. HALLWAY - DAY',
      '',
      '[[scene: greet]]',
      '[[nextline: 2]]',
      '',
      '[[line: L1]]',
      'Footsteps echo.',
      '',
    ].join('\n');

    const { text, diagnostics } = applySceneBranchEdit(marked, [
      { sceneId: 'arrival', next: null, choices: [{ label: 'Wait', goto: 'greet' }] },
    ]);
    expect(diagnostics).toEqual([]);
    expect(text.match(/\[\[line: L1\]\]/g)).toHaveLength(2);
    expect(text).toContain('[[nextline: 3]]');
    expect(scenesOf(text).map((s) => s.lines.map((l) => l.id))).toEqual([
      ['arrival:L1'],
      ['greet:L1'],
    ]);
  });

  it('does nothing, successfully, for an empty edit list', () => {
    expect(applySceneBranchEdit(SCRIPT, [])).toEqual({ text: SCRIPT, diagnostics: [] });
  });

  // The re-parse assertion's reason for existing: a heading needs a blank line above it, and a
  // note-only line is not blank — so deleting one can *create* a scene that wasn't there.
  it('refuses a patch that would conjure a scene out of a suppressed heading', () => {
    const fragile = [
      'INT. DORM ROOM - DAY',
      '',
      '[[scene: arrival]]',
      '',
      'Morning.',
      '',
      '[[next: greet]]',
      'INT. HALLWAY - DAY',
      '',
      'Footsteps echo.',
      '',
    ].join('\n');
    expect(scenesOf(fragile)).toHaveLength(1);

    const { text, diagnostics } = applySceneBranchEdit(fragile, [
      { sceneId: 'arrival', next: null },
    ]);
    expect(text).toBe(fragile);
    expect(diagnostics.map((d) => d.code)).toEqual(['branch_patch_verify']);
  });
});

/**
 * The re-parse assertion is the integration test — so drive it over the real sample screenplay
 * with a generated sweep rather than hand-picked edits, and require that every result either
 * lands the intended graph exactly or refuses and returns the file untouched.
 */
describe('applySceneBranchEdit over examples/sample', () => {
  const file = resolve(__dirname, '../../../../examples/sample/screenplay/script.fountain');
  const source = readFileSync(file, 'utf8');
  const ids = scenesOf(source).map((s) => s.id);

  it('has scenes to sweep', () => {
    expect(ids.length).toBeGreaterThan(2);
  });

  const edits: SceneBranchEdit[] = [];
  for (const [i, sceneId] of ids.entries()) {
    const a = ids[(i + 1) % ids.length] as string;
    const b = ids[(i + 2) % ids.length] as string;
    edits.push(
      { sceneId, next: a },
      { sceneId, next: null },
      { sceneId, choices: [] },
      { sceneId, choices: [{ label: `Go to ${a}`, goto: a }] },
      {
        sceneId,
        choices: [
          { label: 'One', goto: a },
          { label: 'Two', goto: b },
        ],
        next: null,
      },
      { sceneId, choices: [{ label: 'Only', goto: b }], next: a },
    );
  }

  it.each(edits.map((e) => [JSON.stringify(e), e] as const))('%s', (_name, edit) => {
    const { text, diagnostics } = applySceneBranchEdit(source, [edit]);
    // Nothing in the sweep is malformed, so a refusal here is a real bug, not a safe no-op.
    expect(diagnostics).toEqual([]);
    const scene = sceneNamed(text, edit.sceneId);
    expect(scene).toBeDefined();
    if (edit.choices) expect(scene?.choices ?? []).toEqual(edit.choices);
    if (edit.next !== undefined) expect(scene?.next).toBe(edit.next ?? undefined);
    // Untouched scenes keep their wiring, and no scene is created or lost.
    const before = scenesOf(source);
    const after = scenesOf(text);
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    for (const s of after) {
      if (s.id === edit.sceneId) continue;
      const was = before.find((p) => p.id === s.id);
      expect({ choices: s.choices, next: s.next }).toEqual({
        choices: was?.choices,
        next: was?.next,
      });
    }
  });
});
