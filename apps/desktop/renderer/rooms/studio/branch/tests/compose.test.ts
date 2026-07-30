import {
  asInvocation,
  deleteSceneIntent,
  freeSceneId,
  newSceneIntent,
  proposeScene,
  selectionAfterDelete,
} from '../compose.js';
import type { StoryGraph } from '../../../../../src/shared/ipc';

const graph = (ids: string[]): StoryGraph => ({
  scenes: ids.map((id) => ({ id, location: id, characters: [], lines: 0, reachable: true })),
  edges: [],
  diagnostics: [],
});

describe('freeSceneId', () => {
  it('starts at one and takes the first id nothing holds', () => {
    expect(freeSceneId([])).toBe('scene_1');
    expect(freeSceneId(['scene_1', 'scene_2'])).toBe('scene_3');
  });

  it('fills a hole rather than counting past it', () => {
    expect(freeSceneId(['scene_1', 'scene_3'])).toBe('scene_2');
  });
});

describe('proposeScene', () => {
  it('prefills both props off the graph, and works with no graph yet', () => {
    expect(proposeScene(graph(['scene_1']))).toEqual({
      scene: 'scene_2',
      heading: 'INT. SOMEWHERE - DAY',
    });
    expect(proposeScene(null).scene).toBe('scene_1');
  });
});

describe('selectionAfterDelete', () => {
  it('lands on the entry scene, which is the one place always worth being', () => {
    const story = { ...graph(['a', 'b', 'c']), start: 'a' };
    expect(selectionAfterDelete(story, 'b')).toBe('a');
  });

  it('takes whatever is left when the entry scene is the one deleted', () => {
    const story = { ...graph(['a', 'b']), start: 'a' };
    expect(selectionAfterDelete(story, 'a')).toBe('b');
  });

  it('has nowhere to go once the last scene is gone — the surfaces invite instead', () => {
    expect(selectionAfterDelete({ ...graph(['a']), start: 'a' }, 'a')).toBeNull();
    expect(selectionAfterDelete(null, 'a')).toBeNull();
  });
});

describe('the two structural invocations', () => {
  it('makes a scene without wiring it — the canvas is where it gets wired', () => {
    const intent = newSceneIntent({ scene: 'b', heading: 'INT. HALL - DAY' });
    expect(intent.id).toBe('story.newScene');
    expect(intent.props).toEqual({ scene: 'b', heading: 'INT. HALL - DAY' });
  });

  it('drops the note for a check: `command:check` takes an invocation, not an intent', () => {
    const intent = deleteSceneIntent('b');
    expect(intent.id).toBe('story.deleteScene');
    expect(asInvocation(intent)).toEqual({ id: 'story.deleteScene', props: { scene: 'b' } });
  });
});
