import { storyGraphOf } from '../../../../../src/main/storygraph.js';
import { edgeTarget, scenesOf } from '../../../../../src/shared/interactions.js';
import { branchGraph, CARD, STUB } from '../graph.js';
import type { ProjectModel, Scene } from '@vn/types';
import type { StoryEdge } from '../../../../../src/shared/ipc';

// The scenes go through the real `storyGraphOf`, so the round-trip below is against the
// projection the app actually draws. (`@vn/testkit`'s factories would be the usual way in, but
// it reaches the scheduler, and the renderer's typecheck deliberately can't see that far.)
const wired = (id: string, choices: Scene['choices'], next?: string): Scene => ({
  id,
  location: 'classroom',
  characters: [],
  body: 'They talk.',
  lines: [],
  shots: [],
  choices,
  ...(next !== undefined ? { next } : {}),
});

const scene = (id: string): Scene => wired(id, []);

const model = (scenes: Scene[]): ProjectModel => ({
  title: 'Test',
  characters: new Map(),
  locations: new Map(),
  scenes: new Map(scenes.map((s) => [s.id, s])),
  reachable: new Set(scenes.map((s) => s.id)),
  entry: scenes[0]?.id,
  diagnostics: [],
});

/** greet forks two ways; rooftop continues linearly; ending goes nowhere. */
const sample = () =>
  storyGraphOf(
    model([
      wired('greet', [
        { label: 'Say hello', goto: 'rooftop' },
        { label: 'Walk away', goto: 'ending' },
      ]),
      wired('rooftop', [], 'ending'),
      wired('ending', []),
    ]),
  );

describe('branchGraph', () => {
  it('gives every scene a card and nothing else a node', () => {
    const { graph, stubs } = branchGraph(sample());
    expect(graph.nodes.map((n) => n.id)).toEqual(['greet', 'rooftop', 'ending']);
    expect(graph.nodes[0]).toMatchObject(CARD);
    expect(stubs.size).toBe(0);
  });

  it('stands a stub in for a goto with no scene behind it', () => {
    const story = storyGraphOf(model([wired('greet', [{ label: 'Leave', goto: 'nowhere' }])]));
    const { graph, stubs } = branchGraph(story);
    expect([...stubs]).toEqual(['nowhere']);
    expect(graph.nodes.find((n) => n.id === 'nowhere')).toMatchObject(STUB);
  });

  it('re-kinds an inert next, so the wire can be drawn as one the runner ignores', () => {
    const story = storyGraphOf(
      model([wired('greet', [{ label: 'Say hello', goto: 'ending' }], 'ending'), scene('ending')]),
    );
    const { graph } = branchGraph(story);
    expect(graph.edges.find((e) => e.id === 'greet#next')?.kind).toBe('inert');
    expect(graph.edges.find((e) => e.id === 'greet#choice:0')?.kind).toBe('choice');
  });
});

// `scenesOf` and `edgeTarget` live in `src/shared/` — main needs them too — but they are still
// `StoryGraph` projections, so they are covered here with the projection they invert.
describe('scenesOf', () => {
  it('round-trips the branch structure the model was built from', () => {
    const story = sample();
    const scenes = scenesOf(story);
    expect(scenes.get('greet')?.choices).toEqual([
      { label: 'Say hello', goto: 'rooftop' },
      { label: 'Walk away', goto: 'ending' },
    ]);
    expect(scenes.get('greet')?.next).toBeUndefined();
    expect(scenes.get('rooftop')?.next).toBe('ending');
    expect(scenes.get('ending')).toEqual({ id: 'ending', choices: [] });
  });

  it('orders choices by the edge index, not by array position', () => {
    const story = sample();
    // The exporter emits them in order; the editor must not depend on that.
    story.edges.reverse();
    expect(
      scenesOf(story)
        .get('greet')
        ?.choices.map((c) => c.goto),
    ).toEqual(['rooftop', 'ending']);
  });

  it('ignores an edge leaving a scene that is not in the graph', () => {
    const story = sample();
    story.edges.push({
      id: 'ghost#next',
      from: 'ghost',
      to: 'greet',
      kind: 'next',
      dangling: true,
    });
    expect(scenesOf(story).has('ghost')).toBe(false);
  });
});

describe('edgeTarget', () => {
  const edge = (over: Partial<StoryEdge>): StoryEdge => ({
    id: 'x',
    from: 'greet',
    to: 'ending',
    kind: 'choice',
    dangling: false,
    ...over,
  });

  it('addresses a choice by its index', () => {
    expect(edgeTarget(edge({ index: 1 }))).toEqual({ from: 'greet', edge: 1 });
  });

  it('addresses a next by its scene alone', () => {
    expect(edgeTarget(edge({ kind: 'next' }))).toEqual({ from: 'greet' });
  });
});
