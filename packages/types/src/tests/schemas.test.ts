import { projectConfig, sceneFrontMatter } from '../index.js';

describe('sceneFrontMatter', () => {
  it('accepts a chunk that declares only its id', () => {
    const parsed = sceneFrontMatter.parse({ scene: 'arrival' });
    expect(parsed).toEqual({ scene: 'arrival' });
  });

  it('rejects front-matter with no scene id', () => {
    expect(sceneFrontMatter.safeParse({}).success).toBe(false);
    expect(sceneFrontMatter.safeParse({ scene: '' }).success).toBe(false);
  });

  // The fields below all live in the Fountain body. Accepting a front-matter copy of any of
  // them would give the field two homes and two writers; scene-chunk-files.md picks the body.
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
