import { completeSlash, expandSlash, matchSkills, moveHighlight, slashQuery } from '../slash.js';
import type { SkillEntry } from '../../../src/shared/ipc.js';

const skill = (id: string, name: string): SkillEntry => ({
  id,
  name,
  description: `What ${name} does.`,
  file: `.aiagent/skills/${id}/SKILL.md`,
  script: false,
});

const SKILLS = [
  skill('continuity-pass', 'Continuity pass'),
  skill('cast-a-scene', 'Cast a scene'),
  skill('polish-prose', 'Polish prose'),
];

describe('which skill the author is naming', () => {
  test('a bare slash names none of them yet', () => {
    expect(slashQuery('/', 1)).toBe('');
  });

  test('the letters after the slash', () => {
    expect(slashQuery('/cont', 5)).toBe('cont');
  });

  test('nothing once the token has ended', () => {
    expect(slashQuery('/cont scene 3', 13)).toBeNull();
  });

  test('nothing when the slash is not the first character', () => {
    expect(slashQuery('read and/or skim', 10)).toBeNull();
  });

  test('nothing when the caret has left the token', () => {
    expect(slashQuery('/cont', 0)).toBeNull();
  });
});

describe('which skills a query offers', () => {
  test('everything, for a bare slash', () => {
    expect(matchSkills(SKILLS, '').map((s) => s.id)).toEqual([
      'continuity-pass',
      'cast-a-scene',
      'polish-prose',
    ]);
  });

  test('the ones that start with it, first', () => {
    expect(matchSkills(SKILLS, 'c').map((s) => s.id)).toEqual(['continuity-pass', 'cast-a-scene']);
  });

  test('a word from the middle of a name still finds it', () => {
    expect(matchSkills(SKILLS, 'scene').map((s) => s.id)).toEqual(['cast-a-scene']);
  });

  test('a prefix match outranks a mere containment', () => {
    expect(matchSkills(SKILLS, 'pass').map((s) => s.id)).toEqual(['continuity-pass']);
    expect(matchSkills(SKILLS, 'po').map((s) => s.id)).toEqual(['polish-prose']);
  });

  test('nothing, when nothing matches', () => {
    expect(matchSkills(SKILLS, 'zzz')).toEqual([]);
  });
});

describe('what picking a skill puts in the box', () => {
  test('the id and a space, with the caret after it', () => {
    expect(completeSlash('/cont', SKILLS[0]!)).toEqual({ text: '/continuity-pass ', caret: 17 });
  });

  test('whatever was already typed after the token is kept', () => {
    expect(completeSlash('/c scene 3', SKILLS[1]!)).toEqual({
      text: '/cast-a-scene scene 3',
      caret: 14,
    });
  });
});

describe('what the agent is sent', () => {
  test('a named skill becomes a request for it, with the file', () => {
    expect(expandSlash('/continuity-pass scene 3', SKILLS)).toBe(
      'Follow the “Continuity pass” skill (.aiagent/skills/continuity-pass/SKILL.md). scene 3',
    );
  });

  test('a skill named on its own is a request with nothing after it', () => {
    expect(expandSlash('/polish-prose', SKILLS)).toBe(
      'Follow the “Polish prose” skill (.aiagent/skills/polish-prose/SKILL.md).',
    );
  });

  test('a token naming no skill goes as typed', () => {
    expect(expandSlash('/nope do a thing', SKILLS)).toBe('/nope do a thing');
  });

  test('an ordinary sentence goes as typed', () => {
    expect(expandSlash('rewrite scene 3 and/or 4', SKILLS)).toBe('rewrite scene 3 and/or 4');
  });
});

describe('where a key moves the highlight', () => {
  test('down, and round the bottom', () => {
    expect(moveHighlight(0, 3, 1)).toBe(1);
    expect(moveHighlight(2, 3, 1)).toBe(0);
  });

  test('up, and round the top', () => {
    expect(moveHighlight(0, 3, -1)).toBe(2);
  });

  test('nowhere, in an empty list', () => {
    expect(moveHighlight(0, 0, 1)).toBe(0);
  });
});
