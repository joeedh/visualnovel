import type { Character, Location, ProjectModel } from '@vn/types';
import { buildRedactor, sourcesFrom, type NamedEntity, type RedactionSources } from '../redact.js';

const titus: NamedEntity = { id: 'titus', name: 'Titus Vale', kind: 'character' };
const aiko: NamedEntity = { id: 'aiko', name: 'Aiko', kind: 'character' };
const mori: NamedEntity = { id: 'cafe-mori', name: 'Café Mori', kind: 'location' };

const redactor = (over: Partial<RedactionSources> = {}) =>
  buildRedactor({ entities: [titus, aiko, mori], ...over });

describe('replacing a name', () => {
  it('takes the longest match, so a full name is not half-replaced', () => {
    expect(redactor().apply('Titus Vale said so')).toBe('Character A said so');
  });

  it('gives an id and a display name the same pseudonym', () => {
    const one = redactor();
    expect(one.apply('Titus Vale')).toBe('Character A');
    expect(one.apply('the sheet at characters/titus.md')).toBe(
      'the sheet at characters/Character A.md',
    );
  });

  it('numbers in first appearance, so the transcript reads in its own order', () => {
    expect(redactor().apply('Aiko met Titus Vale')).toBe('Character A met Character B');
  });

  it('keeps a pseudonym for the life of one redactor and re-rolls it for the next', () => {
    const one = redactor();
    expect(one.apply('Aiko')).toBe('Character A');
    expect(one.apply('Titus Vale, then Aiko again')).toBe('Character B, then Character A again');
    expect(redactor().apply('Titus Vale')).toBe('Character A');
  });

  it('draws each kind from its own series, and numbers scenes', () => {
    const scenes = [{ id: 's1', name: 'The rooftop', kind: 'scene' as const }];
    const out = redactor({ entities: [titus, mori, ...scenes] }).apply(
      'Titus Vale at Café Mori in The rooftop',
    );
    expect(out).toBe('Character A at Location A in Scene 1');
  });

  it('leaves a name alone when it is only part of a longer word', () => {
    expect(redactor().apply('the Morison estate')).toBe('the Morison estate');
    expect(redactor().apply('Aikonaut')).toBe('Aikonaut');
  });

  it('matches whatever case it was written in, and answers in one', () => {
    expect(redactor().apply('titus vale and TITUS VALE')).toBe('Character A and Character A');
  });

  it('leaves a possessive possessive', () => {
    expect(redactor().apply("Titus Vale's jacket")).toBe("Character A's jacket");
    expect(redactor().apply('Titus Vale’s jacket')).toBe('Character A’s jacket');
  });

  it('reads a name through an apostrophe typed inside it', () => {
    const james = { id: 'james', name: 'James', kind: 'character' as const };
    const one = buildRedactor({ entities: [james] });
    expect(one.apply("jame's back modelsheet")).toBe('Character A back modelsheet');
    expect(one.apply('jame’s back modelsheet')).toBe('Character A back modelsheet');
    expect(one.apply("James' jacket")).toBe("Character A' jacket");
  });

  it('takes a name that is written with an apostrophe whether or not one is typed', () => {
    const house = { id: 'zims-house', name: "Zim's house", kind: 'location' as const };
    const one = buildRedactor({ entities: [house] });
    expect(one.apply("meet at Zim's house")).toBe('meet at Location A');
    expect(one.apply('meet at Zims house')).toBe('meet at Location A');
  });

  it('still refuses an alias whose letters are too few, apostrophe or not', () => {
    const initial = { id: 'a', name: "A'", kind: 'character' as const };
    expect(buildRedactor({ entities: [initial] }).apply("a bad a' answer")).toBe("a bad a' answer");
  });

  it('reads a name in a script that has no word boundaries', () => {
    const kanji = { id: 'ren', name: '蓮', kind: 'character' as const };
    expect(buildRedactor({ entities: [kanji] }).apply('蓮は言った')).toBe('Character Aは言った');
  });

  it('refuses an alias too short to mean anything, rather than shredding the text', () => {
    const initial = { id: 'a', name: 'A', kind: 'character' as const };
    expect(buildRedactor({ entities: [initial] }).apply('a bad answer')).toBe('a bad answer');
  });

  it('runs out of letters gracefully', () => {
    const many = Array.from({ length: 27 }, (_, n) => ({
      id: `person${String(n).padStart(2, '0')}`,
      kind: 'character' as const,
    }));
    const out = buildRedactor({ entities: many }).apply(many.map((e) => e.id).join(' '));
    expect(out.split(' ').at(-1)).toBe('AA');
  });
});

describe('replacing a path', () => {
  const sources = { projectRoot: 'C:\\dev\\proj', homeDir: 'C:\\Users\\joeed', username: 'joeed' };

  it('takes the root and keeps what was under it', () => {
    expect(redactor(sources).apply('read C:\\dev\\proj\\scenes\\s1.md')).toBe(
      'read <project>\\scenes\\s1.md',
    );
  });

  it('sees the same path through either separator, and through JSON escaping', () => {
    const one = redactor(sources);
    expect(one.apply('C:/dev/proj/scenes')).toBe('<project>/scenes');
    expect(one.apply('{"path":"C:\\\\dev\\\\proj\\\\a.md"}')).toBe('{"path":"<project>\\\\a.md"}');
  });

  it('does not take a sibling directory whose name starts the same way', () => {
    expect(redactor(sources).apply('C:\\dev\\project-notes')).toBe('C:\\dev\\project-notes');
  });

  it('hides the project before the home it sits in, not the other way round', () => {
    const nested = { projectRoot: 'C:\\Users\\joeed\\dev\\proj', homeDir: 'C:\\Users\\joeed' };
    const one = redactor(nested);
    expect(one.apply('C:\\Users\\joeed\\dev\\proj\\a.md')).toBe('<project>\\a.md');
    expect(one.apply('C:\\Users\\joeed\\Downloads\\a.md')).toBe('<author>\\Downloads\\a.md');
  });

  it('takes a posix root whole, leading slash and all', () => {
    const one = redactor({ projectRoot: '/home/joe/proj' });
    expect(one.apply('at /home/joe/proj/scenes/s1.md')).toBe('at <project>/scenes/s1.md');
  });

  it('replaces the account name wherever it is written', () => {
    expect(redactor(sources).apply('signed in as joeed')).toBe('signed in as <author>');
  });

  it('replaces the project title', () => {
    expect(redactor({ projectTitle: 'The Long Autumn' }).apply('“The Long Autumn” is stuck')).toBe(
      '“<project>” is stuck',
    );
  });
});

describe('applying twice changes nothing', () => {
  const sources = {
    projectRoot: 'C:\\dev\\proj',
    homeDir: 'C:\\Users\\joeed',
    username: 'joeed',
    projectTitle: 'The Long Autumn',
  };
  const text =
    'joeed asked about Titus Vale at Café Mori, in C:\\dev\\proj\\scenes\\s1.md, ' +
    'for The Long Autumn, from C:\\Users\\joeed\\Desktop.';

  it('is idempotent', () => {
    const one = redactor(sources);
    const once = one.apply(text);
    expect(one.apply(once)).toBe(once);
    expect(once).not.toMatch(/Titus|joeed|Autumn|Mori/);
  });
});

describe('leaks', () => {
  const sources = { projectRoot: 'C:\\dev\\proj', username: 'joeed' };

  it('finds exactly what apply would have replaced', () => {
    const one = redactor(sources);
    expect(one.leaks('Titus Vale walked into Café Mori')).toEqual(['Titus Vale', 'Café Mori']);
  });

  it('finds a path and an account name too', () => {
    expect(redactor(sources).leaks('joeed opened C:/dev/proj/a.md')).toEqual([
      'C:\\dev\\proj',
      'joeed',
    ]);
  });

  it('says nothing about a report that has been redacted', () => {
    const one = redactor(sources);
    expect(one.leaks(one.apply('Titus Vale at C:\\dev\\proj'))).toEqual([]);
  });

  it('sees a name through the same apostrophe apply would have', () => {
    const james = { id: 'james', name: 'James', kind: 'character' as const };
    expect(buildRedactor({ entities: [james] }).leaks("jame's back modelsheet")).toEqual(['James']);
  });

  it('names each leak once, however often it was written', () => {
    expect(redactor().leaks('Aiko, Aiko, Aiko')).toEqual(['Aiko']);
  });

  it('does not assign a pseudonym — a scan is a read', () => {
    const one = redactor();
    one.leaks('Titus Vale');
    expect(one.apply('Aiko')).toBe('Character A');
  });
});

describe('sourcesFrom', () => {
  const model = {
    title: 'The Long Autumn',
    characters: new Map([['titus', { id: 'titus', name: 'Titus Vale' } as Character]]),
    locations: new Map([['cafe-mori', { id: 'cafe-mori', name: 'Café Mori' } as Location]]),
    scenes: new Map([
      ['s1', {}],
      ['s2', {}],
    ]),
  } as unknown as ProjectModel;

  it('takes every name a loaded project holds, and the machine facts it does not', () => {
    const sources = sourcesFrom(model, { projectRoot: 'C:\\dev\\proj', username: 'joeed' });
    expect(sources.projectTitle).toBe('The Long Autumn');
    expect(sources.projectRoot).toBe('C:\\dev\\proj');
    expect(sources.entities).toEqual([
      { id: 'titus', name: 'Titus Vale', kind: 'character' },
      { id: 'cafe-mori', name: 'Café Mori', kind: 'location' },
      { id: 's1', kind: 'scene' },
      { id: 's2', kind: 'scene' },
    ]);
  });

  it('feeds a redactor that hides the whole project', () => {
    const one = buildRedactor(sourcesFrom(model, { username: 'joeed' }));
    expect(one.apply('joeed put Titus Vale in s1, at Café Mori, for The Long Autumn')).toBe(
      '<author> put Character A in Scene 1, at Location A, for <project>',
    );
  });
});

describe('a project with nothing to hide', () => {
  it('passes text through untouched', () => {
    const one = buildRedactor({ entities: [] });
    expect(one.apply('nothing personal here')).toBe('nothing personal here');
    expect(one.leaks('nothing personal here')).toEqual([]);
  });
});
