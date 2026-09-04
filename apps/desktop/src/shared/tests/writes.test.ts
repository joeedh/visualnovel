import {
  graphDocPath,
  graphGroupPath,
  normalizePath,
  touches,
  touchesGraph,
  touchesInputs,
  touchesScene,
} from '../writes.js';

describe('normalizePath', () => {
  it('forward-slashes and drops a ./ prefix', () => {
    expect(normalizePath('wiki\\lore\\houses.md')).toBe('wiki/lore/houses.md');
    expect(normalizePath('./characters/aiko/character.md')).toBe('characters/aiko/character.md');
  });
});

describe('touches', () => {
  it('matches a written path however it was spelled', () => {
    expect(touches(['wiki/lore/houses.md'], 'wiki/lore/houses.md')).toBe(true);
    expect(touches(['wiki\\lore\\houses.md'], 'wiki/lore/houses.md')).toBe(true);
    expect(touches(['./wiki/lore/houses.md'], 'wiki/lore/houses.md')).toBe(true);
  });

  it('does not match a different file, a prefix of one, or nothing open', () => {
    expect(touches(['wiki/lore/houses.md'], 'wiki/lore/house.md')).toBe(false);
    expect(touches(['wiki/lore/houses.md.bak'], 'wiki/lore/houses.md')).toBe(false);
    expect(touches(['wiki/lore/houses.md'], '')).toBe(false);
    expect(touches([], 'wiki/lore/houses.md')).toBe(false);
  });
});

describe('touchesScene', () => {
  it('derives the scene file from the id', () => {
    expect(touchesScene(['scenes/rooftop.md'], 'rooftop')).toBe(true);
    expect(touchesScene(['scenes\\rooftop.md'], 'rooftop')).toBe(true);
  });

  it('ignores another scene, another file, and no scene open', () => {
    expect(touchesScene(['scenes/hallway.md'], 'rooftop')).toBe(false);
    expect(touchesScene(['characters/aiko/character.md'], 'rooftop')).toBe(false);
    expect(touchesScene(['scenes/rooftop.md'], '')).toBe(false);
  });
});

describe('graphDocPath', () => {
  // Pinned against the path a write actually reports, which is what `writeGraphDoc` returns from
  // `graphPath`. A bare `work/graphs/...` here matched nothing the app ever wrote.
  it('is under vngen/, the way ProjectPaths.work is', () => {
    expect(graphDocPath('portrait')).toBe('vngen/work/graphs/portrait.json');
  });
});

describe('touchesGraph', () => {
  it('derives the graph file from the slug', () => {
    expect(touchesGraph(['vngen/work/graphs/portrait.json'], 'portrait')).toBe(true);
    expect(touchesGraph(['vngen\\work\\graphs\\portrait.json'], 'portrait')).toBe(true);
  });

  it('ignores another graph, another file, and no graph open', () => {
    expect(touchesGraph(['vngen/work/graphs/backdrop.json'], 'portrait')).toBe(false);
    expect(touchesGraph(['characters/aiko/character.md'], 'portrait')).toBe(false);
    expect(touchesGraph(['vngen/work/graphs/portrait.json'], '')).toBe(false);
  });

  it('counts the definition file of a group the graph instances, and no other', () => {
    expect(touchesGraph(['vngen/work/graphs/lib/inkwash.json'], 'portrait', ['inkwash'])).toBe(
      true,
    );
    expect(touchesGraph(['vngen/work/graphs/lib/inkwash.json'], 'portrait', ['other'])).toBe(false);
    expect(touchesGraph(['vngen/work/graphs/lib/inkwash.json'], 'portrait')).toBe(false);
  });
});

describe('graphGroupPath', () => {
  it('is the lib/ file beside the graphs', () => {
    expect(graphGroupPath('inkwash')).toBe('vngen/work/graphs/lib/inkwash.json');
  });
});

/**
 * The question every pane showing derived state asks, and the one main asks before re-reading the
 * project. What it lets through is what `loadInputs` reads; what it turns away is everything
 * generated, which is most of what the app writes.
 */
describe('touchesInputs', () => {
  it.each([
    'characters/aiko/character.md',
    'locations/rooftop.md',
    'scenes/arrival.md',
    'screenplay/story.fountain',
    'project.yaml',
  ])('lets %s through', (path) => {
    expect(touchesInputs([path])).toBe(true);
  });

  // An entity sheet is found by its `type:` tag across three surfaces and the bible is the third,
  // so a wiki note can be a character sheet. Which one it is cannot be told from the path.
  it('lets a wiki note through, because one of them may be an entity sheet', () => {
    expect(touchesInputs(['wiki/lore/houses.md'])).toBe(true);
  });

  it.each([
    'vngen/work/graphs/portrait.json',
    'vngen/build/manifest.json',
    'vngen/state/commands.jsonl',
    'assets/objects/ab12.png',
    '.aiagent/skills/branching/SKILL.md',
  ])('turns %s away', (path) => {
    expect(touchesInputs([path])).toBe(false);
  });

  it('reads a windows path the same as a posix one', () => {
    expect(touchesInputs(['characters\\aiko\\character.md'])).toBe(true);
    expect(touchesInputs(['.\\scenes\\arrival.md'])).toBe(true);
  });

  it('answers for the whole list, not just its first entry', () => {
    expect(touchesInputs(['vngen/build/manifest.json', 'scenes/arrival.md'])).toBe(true);
    expect(touchesInputs(['vngen/build/manifest.json', 'assets/objects/ab12.png'])).toBe(false);
    expect(touchesInputs([])).toBe(false);
  });

  // `project.yaml` is matched whole. A directory that starts with the same letters is not an
  // input, and neither is a file that merely ends with the name.
  it('does not match a path that only begins or ends like an input', () => {
    expect(touchesInputs(['characters.md'])).toBe(false);
    expect(touchesInputs(['project.yaml.bak'])).toBe(false);
    expect(touchesInputs(['vngen/work/project.yaml'])).toBe(false);
  });
});
