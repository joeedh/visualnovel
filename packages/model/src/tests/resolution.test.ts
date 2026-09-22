import { sceneTextProblem } from '../entities.js';
import { resolutionProblem, sceneLoadProblem } from '../resolution.js';

const SCENE = (body: string): string => `---\nscene: rooftop\n---\n\nINT. ROOF - NIGHT\n\n${body}`;

const SHEET = `---
id: aiko
name: Aiko
status: draft
default_outfit: uniform
palette:
  - '#a02828'
traits:
  - curious
---
Aiko, a fixture character.
`;

const MARKERS = '<<<<<<< HEAD\none\n=======\ntwo\n>>>>>>> 1234567 (Mine)\n';

describe('sceneLoadProblem', () => {
  it('passes a scene that loads cleanly, and one that still holds markers', () => {
    expect(sceneLoadProblem('rooftop', SCENE('[[line: L1]]\nShe waits.\n'))).toBeUndefined();
    expect(sceneLoadProblem('rooftop', SCENE(MARKERS))).toBeUndefined();
  });

  it('refuses what sceneTextProblem refuses', () => {
    const wrong = '---\nscene: hall\n---\n\nINT. ROOF - NIGHT\n\nShe waits.\n';
    expect(sceneTextProblem('rooftop', wrong)).toMatch(/declares scene "hall"/);
    expect(sceneLoadProblem('rooftop', wrong)).toBe(sceneTextProblem('rooftop', wrong));
  });

  it('refuses a line id marked twice, which sceneTextProblem lets through', () => {
    const doubled = SCENE('[[line: L1]]\nShe waits.\n\n[[line: L1]]\nShe leaves.\n');
    expect(sceneTextProblem('rooftop', doubled)).toBeUndefined();
    expect(sceneLoadProblem('rooftop', doubled)).toMatch(/marks 2 lines with line id "L1"/);
  });
});

describe('resolutionProblem', () => {
  it('holds a scene to sceneLoadProblem, naming the path', () => {
    expect(resolutionProblem('scenes/rooftop.md', SCENE('She waits.\n'))).toBeUndefined();
    const doubled = SCENE('[[line: L1]]\nShe waits.\n\n[[line: L1]]\nShe leaves.\n');
    expect(resolutionProblem('scenes/rooftop.md', doubled)).toMatch(
      /^scenes\/rooftop\.md would not load: /,
    );
  });

  it('holds a sheet to its schema, and refuses markers anywhere in it', () => {
    expect(resolutionProblem('characters/aiko/character.md', SHEET)).toBeUndefined();
    expect(
      resolutionProblem('characters/aiko/character.md', SHEET.replace('name: Aiko\n', '')),
    ).toMatch(/would not load/);
    const marked = SHEET.replace(
      'name: Aiko\n',
      '<<<<<<< HEAD\nname: Aiko\n=======\nname: Aiko S.\n>>>>>>> theirs\n',
    );
    expect(resolutionProblem('characters/aiko/character.md', marked)).toBe(
      'characters/aiko/character.md still holds conflict markers.',
    );
    expect(resolutionProblem('locations/roof.md', `---\nid: roof\n---\n${MARKERS}`)).toBe(
      'locations/roof.md still holds conflict markers.',
    );
    expect(
      resolutionProblem('locations/roof.md', '---\nid: roof\nname: 3\n---\nA roof.\n'),
    ).toMatch(/would not load/);
  });

  it('holds JSON and YAML to parsing, and refuses markers, which YAML would read as text', () => {
    expect(resolutionProblem('vngen/work/shots/rooftop.json', '{"shots":[]}\n')).toBeUndefined();
    expect(resolutionProblem('vngen/work/shots/rooftop.json', '{"shots":[}\n')).toMatch(
      /^vngen\/work\/shots\/rooftop\.json is not valid JSON: /,
    );
    expect(resolutionProblem('vngen/work/shots/rooftop.json', `{\n${MARKERS}}`)).toBe(
      'vngen/work/shots/rooftop.json still holds conflict markers.',
    );
    expect(resolutionProblem('project.yaml', 'title: Rooftop\n')).toBeUndefined();
    expect(resolutionProblem('project.yaml', 'title: [Rooftop\n')).toMatch(
      /^project\.yaml is not valid YAML: /,
    );
    expect(resolutionProblem('project.yaml', `title: Rooftop\n${MARKERS}`)).toBe(
      'project.yaml still holds conflict markers.',
    );
  });

  it('takes a note with markers in its body, but not in its front matter, and any other text as it is', () => {
    expect(
      resolutionProblem('wiki/notes.md', `---\ntitle: Notes\n---\n${MARKERS}`),
    ).toBeUndefined();
    expect(resolutionProblem('wiki/notes.md', `---\ntitle: Notes\n${MARKERS}---\nbody\n`)).toBe(
      'wiki/notes.md still holds conflict markers in its front matter.',
    );
    expect(resolutionProblem('wiki/notes.md', '---\ntitle: [Notes\n---\nbody\n')).toMatch(
      /front matter will not parse/,
    );
    expect(resolutionProblem('README.txt', MARKERS)).toBeUndefined();
  });
});
