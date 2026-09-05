import {
  isGenerated,
  renderGeneratedContext,
  GENERATED_BANNER,
  type ProjectMap,
} from '../index.js';

function map(over: Partial<ProjectMap> = {}): ProjectMap {
  return {
    title     : 'Cafe Story',
    entry     : 'arrival',
    characters: [
      {
        id           : 'aiko',
        name         : 'Aiko',
        status       : 'draft',
        file         : 'characters/aiko/character.md',
        defaultOutfit: 'uniform',
        outfits      : ['uniform', 'track'],
      },
    ],
    locations: [
      {
        id      : 'classroom',
        name    : 'Classroom 2-B',
        mined   : false,
        file    : 'locations/classroom.md',
        variants: ['day', 'afternoon'],
      },
      { id: 'rooftop', name: 'Rooftop', mined: true, variants: ['night'] },
    ],
    scenes: [
      {
        id        : 'arrival',
        location  : 'classroom',
        characters: ['aiko'],
        edges: [
          { label: 'Greet', goto: 'greet' },
          { label: 'Observe', goto: 'observe' },
        ],
        reachable : true,
        file      : 'scenes/arrival.md',
      },
      {
        id        : 'greet',
        location  : 'classroom',
        characters: ['aiko'],
        edges     : [{ goto: 'ending' }],
        reachable : true,
        file      : 'scenes/greet.md',
      },
      {
        id        : 'orphan',
        location  : 'rooftop',
        characters: [],
        edges     : [],
        reachable : false,
        file      : 'scenes/orphan.md',
      },
    ],
    bible: [
      {
        file    : 'history/the-war.md',
        title   : 'The War',
        tags    : ['history'],
        headings: ['Causes', 'Casualties'],
        bytes   : 4200,
      },
    ],
    ...over,
  };
}

describe('renderGeneratedContext', () => {
  it('opens with a banner isGenerated recognizes', () => {
    const text = renderGeneratedContext(map());
    expect(text.startsWith(GENERATED_BANNER)).toBe(true);
    expect(isGenerated(text)).toBe(true);
    expect(isGenerated('# Hand-written\n')).toBe(false);
    // Recognition is by the mark rather than the whole banner, so a later banner still counts
    expect(isGenerated('<!-- vn:generated-context v9 — whatever -->\n')).toBe(true);
  });

  it('maps the cast, the wardrobe, and where each sheet lives', () => {
    const text = renderGeneratedContext(map());
    expect(text).toContain(
      '- aiko "Aiko" [draft] — characters/aiko/character.md — outfits: uniform (default), track',
    );
  });

  it('marks a mined location as having no sheet', () => {
    const text = renderGeneratedContext(map());
    expect(text).toContain(
      '- rooftop "Rooftop" — mined from a heading; no sheet — variants: night',
    );
  });

  it('renders the story graph: choices, a linear next, and unreachability', () => {
    const text = renderGeneratedContext(map());
    expect(text).toContain('## Scenes (3) — entry: arrival');
    expect(text).toContain('choices: "Greet" -> greet, "Observe" -> observe');
    expect(text).toContain('- greet @classroom — cast: aiko — next: ending — scenes/greet.md');
    expect(text).toContain('- orphan @rooftop — end — scenes/orphan.md [unreachable]');
  });

  it('lists the bible as a table of contents and never its text', () => {
    const text = renderGeneratedContext(map());
    expect(text).toContain('- history/the-war.md "The War" — [history] — Causes, Casualties');
  });

  it('omits the bible section entirely when there is no wiki', () => {
    const text = renderGeneratedContext(map({ bible: [] }));
    expect(text).not.toContain('Story bible');
    expect(text).toContain('0 bible note(s)');
  });

  it('spends the budget in section order and says what it dropped', () => {
    const bible = Array.from({ length: 40 }, (_, i) => ({
      file    : `notes/n${i}.md`,
      title   : `Note ${i}`,
      tags    : [],
      headings: [],
      bytes   : 10,
    }));
    const text = renderGeneratedContext(map({ bible }), { budget: 1200 });
    expect(text.length).toBeLessThan(1400); // the heading and the counted line are unbudgeted
    // The cast came first and survived; the bible is what got cut.
    expect(text).toContain('- aiko "Aiko" [draft]');
    expect(text).toContain('- notes/n0.md');
    expect(text).not.toContain('- notes/n39.md');
    expect(text).toMatch(/… and \d+ more note\(s\); use search_bible\./);
  });

  it('is a pure function of the map — same input, same bytes', () => {
    expect(renderGeneratedContext(map())).toBe(renderGeneratedContext(map()));
    expect(renderGeneratedContext(map())).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
