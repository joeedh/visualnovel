import {
  characterFrontMatter,
  docKind,
  ENTITY_TAG_KEY,
  ENTITY_TAGS,
  locationFrontMatter,
  taggedKind,
  projectConfig,
  sceneFrontMatter,
} from '../index.js';

describe('the entity tag', () => {
  it('is the key the reader and the author both name', () => {
    expect(ENTITY_TAG_KEY).toBe('type');
    expect(ENTITY_TAGS).toEqual({ character: 'character', location: 'location' });
  });

  it('is optional — a conventional directory carries it implicitly', () => {
    const parsed = characterFrontMatter.parse({ id: 'aiko', name: 'Aiko' });
    expect(parsed.type).toBeUndefined();
  });

  it.each([
    ['character', characterFrontMatter, ENTITY_TAGS.character, ENTITY_TAGS.location],
    ['location', locationFrontMatter, ENTITY_TAGS.location, ENTITY_TAGS.character],
  ])('lets a %s state its own tag and refuses the other one', (_kind, schema, own, other) => {
    expect(schema.safeParse({ id: 'x', name: 'X', [ENTITY_TAG_KEY]: own }).success).toBe(true);
    expect(schema.safeParse({ id: 'x', name: 'X', [ENTITY_TAG_KEY]: other }).success).toBe(false);
  });
});

describe('docKind', () => {
  it('reads a stated tag and ignores one it does not know', () => {
    expect(taggedKind({ [ENTITY_TAG_KEY]: 'location' })).toBe('location');
    expect(taggedKind({ [ENTITY_TAG_KEY]: 'prop' })).toBeUndefined();
    expect(taggedKind({})).toBeUndefined();
  });

  it('is a note when neither the location nor the tag says otherwise', () => {
    expect(docKind(undefined, {})).toEqual({ kind: 'note' });
    expect(docKind(undefined, { [ENTITY_TAG_KEY]: 'prop' })).toEqual({ kind: 'note' });
  });

  it('takes the kind from whichever of the two speaks', () => {
    expect(docKind('character', {})).toEqual({ kind: 'character' });
    expect(docKind(undefined, { [ENTITY_TAG_KEY]: 'location' })).toEqual({ kind: 'location' });
    expect(docKind('location', { [ENTITY_TAG_KEY]: 'location' })).toEqual({ kind: 'location' });
  });

  it('is a conflict when the tag contradicts the location, with the sentence to show', () => {
    const kind = docKind('character', { [ENTITY_TAG_KEY]: 'location' });
    expect(kind.kind).toBe('conflict');
    if (kind.kind !== 'conflict') return;
    expect(kind.reason).toBe(
      'is a character by its location but declares type: location; move the file or fix the tag',
    );
  });
});

describe('sceneFrontMatter', () => {
  it('accepts a chunk that declares only its id', () => {
    const parsed = sceneFrontMatter.parse({ scene: 'arrival' });
    expect(parsed).toEqual({ scene: 'arrival' });
  });

  it('rejects front-matter with no scene id', () => {
    expect(sceneFrontMatter.safeParse({}).success).toBe(false);
    expect(sceneFrontMatter.safeParse({ scene: '' }).success).toBe(false);
  });

  // The fields below all live in the Fountain body. Accepting a front-matter copy of one would
  // give that field two locations and two writers; scene-chunk-files.md picks the body
  it.each(['next', 'nextLineId', 'choices', 'location', 'heading', 'synopsis', 'characters'])(
    'refuses %s in front-matter — the body owns it',
    (key) => {
      const result = sceneFrontMatter.safeParse({ scene: 'arrival', [key]: 'rooftop' });
      expect(result.success).toBe(false);
    },
  );
});

describe('projectConfig start', () => {
  it('reads the entry scene when given', () => {
    expect(projectConfig.parse({ title: 'T', start: 'arrival' }).start).toBe('arrival');
  });

  it('leaves start undefined rather than guessing an entry scene', () => {
    expect(projectConfig.parse({ title: 'T' }).start).toBeUndefined();
  });

  it('rejects an empty start', () => {
    expect(projectConfig.safeParse({ title: 'T', start: '' }).success).toBe(false);
  });
});
