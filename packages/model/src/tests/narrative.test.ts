import type { Scene } from '@vn/types';
import { parseFountain } from '@vn/parse';
import { branchingNarrative } from '../branching.js';
import { buildModel, errors, type BuildInputs } from '../build.js';
import { linearNarrative } from '../linear.js';
import { scriptFromScenes } from '../screenplay.js';

const scene = (id: string, edges: { next?: string; choices?: string[] } = {}): Scene => ({
  id,
  location  : 'classroom',
  characters: [],
  lines     : [],
  choices   : (edges.choices ?? []).map((goto) => ({ label: goto, goto })),
  ...(edges.next === undefined ? {} : { next: edges.next }),
});

const scenesOf = (...list: Scene[]): Map<string, Scene> => new Map(list.map((s) => [s.id, s]));
const codes = (n: { diagnostics(): readonly { code: string }[] }): string[] =>
  n.diagnostics().map((d) => d.code);

describe('branchingNarrative', () => {
  const story = scenesOf(
    scene('ending'),
    scene('start', { choices: ['left', 'right'] }),
    scene('left', { next: 'ending' }),
    scene('right', { next: 'ending' }),
    scene('orphan'),
  );

  it('makes live exactly what the entry reaches', () => {
    const n = branchingNarrative(story, { start: 'start' });
    expect(n.engine).toBe('branching');
    expect(n.entry).toBe('start');
    expect(['start', 'left', 'right', 'ending'].every((id) => n.live(id))).toBe(true);
    expect(n.live('orphan')).toBe(false);
    expect(codes(n)).toEqual(['unreachable_scene']);
  });

  it('lists the reachable scenes in topological order, then the rest in map order', () => {
    expect(branchingNarrative(story, { start: 'start' }).scenes()).toEqual([
      'start',
      'left',
      'right',
      'ending',
      'orphan',
    ]);
  });

  it("answers a scene's own markers as its exits", () => {
    const n = branchingNarrative(story, { start: 'start' });
    expect(n.exits('start').choices.map((c) => c.goto)).toEqual(['left', 'right']);
    expect(n.exits('left')).toEqual({ choices: [], next: 'ending' });
    expect(n.exits('missing')).toEqual({ choices: [] });
  });

  it('reports a dangling goto and a start that names no scene', () => {
    const n = branchingNarrative(scenesOf(scene('a', { next: 'nowhere' })), { start: 'b' });
    expect(codes(n).sort()).toEqual(['dangling_goto', 'unknown_start', 'unreachable_scene']);
    expect(n.entry).toBeUndefined();
  });

  it('wants start: for scenes with no document order, and falls back to the first one with it', () => {
    const two = scenesOf(scene('a', { next: 'b' }), scene('b'));
    expect(codes(branchingNarrative(two))).toContain('missing_start');
    expect(branchingNarrative(two, { ordered: true }).entry).toBe('a');
  });
});

describe('linearNarrative', () => {
  // Map order is the directory's, by id; the list is the story's
  const story = scenesOf(scene('dusk'), scene('lunch'), scene('morning'));

  it('plays the listed scenes in list order, each continuing to the next', () => {
    const n = linearNarrative(story, { scenes: ['morning', 'lunch', 'dusk'] });
    expect(n.engine).toBe('linear');
    expect(n.entry).toBe('morning');
    expect(n.scenes()).toEqual(['morning', 'lunch', 'dusk']);
    expect(['morning', 'lunch', 'dusk'].every((id) => n.live(id))).toBe(true);
    expect(n.exits('morning')).toEqual({ choices: [], next: 'lunch' });
    expect(n.exits('lunch')).toEqual({ choices: [], next: 'dusk' });
    expect(n.exits('dusk')).toEqual({ choices: [] });
    expect(n.diagnostics()).toEqual([]);
  });

  it('leaves an unlisted scene out of the story, last in the order, with a warning', () => {
    const n = linearNarrative(story, { scenes: ['morning', 'dusk'] });
    expect(n.live('lunch')).toBe(false);
    expect(n.scenes()).toEqual(['morning', 'dusk', 'lunch']);
    expect(n.exits('morning').next).toBe('dusk');
    expect(n.exits('lunch')).toEqual({ choices: [] });
    expect(n.diagnostics()).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'unlisted_scene', where: 'lunch' }),
    ]);
  });

  it('refuses a listed id with no scene, and a repeated one', () => {
    const n = linearNarrative(story, { scenes: ['morning', 'ghost', 'lunch', 'morning', 'dusk'] });
    expect(n.scenes()).toEqual(['morning', 'lunch', 'dusk']);
    expect(n.exits('morning').next).toBe('lunch');
    expect(n.diagnostics().map((d) => [d.severity, d.code, d.where])).toEqual([
      ['error', 'unknown_listed_scene', 'ghost'],
      ['error', 'duplicate_listed_scene', 'morning'],
    ]);
  });

  it('refuses branch markers without following them', () => {
    const marked = scenesOf(scene('a', { choices: ['b'] }), scene('b', { next: 'a' }));
    const n = linearNarrative(marked, { scenes: ['b', 'a'] });
    expect(n.exits('b')).toEqual({ choices: [], next: 'a' });
    expect(n.exits('a')).toEqual({ choices: [] });
    expect(n.diagnostics().map((d) => [d.severity, d.code, d.where])).toEqual([
      ['error', 'linear_branch_marker', 'a'],
      ['error', 'linear_branch_marker', 'b'],
    ]);
  });

  it('accepts start: only when it names the first listed scene', () => {
    const order = ['morning', 'lunch', 'dusk'];
    expect(linearNarrative(story, { scenes: order, start: 'morning' }).diagnostics()).toEqual([]);
    const n = linearNarrative(story, { scenes: order, start: 'lunch' });
    expect(n.entry).toBe('morning');
    expect(codes(n)).toEqual(['linear_start']);
  });

  it('wants a list, naming the scenes it could hold', () => {
    const n = linearNarrative(story);
    expect(n.entry).toBeUndefined();
    expect(n.scenes()).toEqual(['dusk', 'lunch', 'morning']);
    expect([...story.keys()].some((id) => n.live(id))).toBe(false);
    expect(n.diagnostics()).toEqual([
      expect.objectContaining({ severity: 'error', code: 'missing_scene_list' }),
    ]);
    expect(n.diagnostics()[0]!.message).toContain('dusk, lunch, morning');
  });

  it('has nothing to report for a project with no scenes yet', () => {
    expect(linearNarrative(new Map()).diagnostics()).toEqual([]);
  });
});

describe('buildModel — the engine project.yaml selects', () => {
  const SCRIPT = `INT. DORM - MORNING

[[scene: morning]]

The alarm goes off twice.

INT. CAFE - DAY

[[scene: lunch]]

Lunch.

EXT. RIVER - EVENING

[[scene: dusk]]

Dusk.
`;
  const inputs = (more: Partial<BuildInputs>): BuildInputs => ({
    title        : 'T',
    characterDocs: [],
    locationDocs : [],
    script       : parseFountain(SCRIPT),
    ...more,
  });

  it('is branching when narrative: is absent', () => {
    const model = buildModel(inputs({}));
    expect(model.narrative.engine).toBe('branching');
    expect([...model.reachable]).toEqual(['morning']);
  });

  it('fills reachable and entry from a linear structure', () => {
    const model = buildModel(inputs({ narrative: 'linear', sceneOrder: ['lunch', 'morning'] }));
    expect(model.narrative.engine).toBe('linear');
    expect(model.entry).toBe('lunch');
    expect(model.reachable).toEqual(new Set(['lunch', 'morning']));
    expect(model.diagnostics.map((d) => [d.code, d.where])).toEqual([['unlisted_scene', 'dusk']]);
  });

  it('exports the screenplay in list order, the unlisted scene under # Unreachable', () => {
    const model = buildModel(inputs({ narrative: 'linear', sceneOrder: ['lunch', 'morning'] }));
    const text = scriptFromScenes(model);
    const at = (id: string): number => text.indexOf(`[[scene: ${id}]]`);
    expect(at('lunch')).toBeLessThan(at('morning'));
    expect(text.indexOf('# Unreachable')).toBeGreaterThan(at('morning'));
    expect(at('dusk')).toBeGreaterThan(text.indexOf('# Unreachable'));
  });

  it('reports a scenes: list under branching rather than ignoring it', () => {
    const model = buildModel(inputs({ sceneOrder: ['morning', 'lunch', 'dusk'] }));
    expect(model.narrative.engine).toBe('branching');
    expect(errors(model).map((d) => d.code)).toEqual(['scenes_without_linear']);
  });
});
