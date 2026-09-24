import { FILE_ROOTS, ROOTS_REFUSAL, fileNameProblem, planCreate, rootProblem } from '../fileops.js';

describe('fileNameProblem', () => {
  it('accepts an ordinary name, with or without an extension', () => {
    for (const name of ['lore', 'a.md', 'notes 2.txt', '.hidden', 'con-notes.md']) {
      expect([name, fileNameProblem(name)]).toEqual([name, undefined]);
    }
  });

  it('refuses an empty name, and the two relative names', () => {
    expect(fileNameProblem('')).toBe('Type a name for it.');
    expect(fileNameProblem('.')).toBe('"." is not a name a file or folder can have.');
    expect(fileNameProblem('..')).toBe('".." is not a name a file or folder can have.');
  });

  it('refuses every character Windows does not allow, naming the one it found', () => {
    for (const ch of ['/', '\\', '<', '>', ':', '"', '|', '?', '*']) {
      expect(fileNameProblem(`a${ch}b`)).toBe(
        `"a${ch}b" contains "${ch}", which Windows does not allow in a file name.`,
      );
    }
    expect(fileNameProblem('a\tb')).toBe(
      '"a\tb" contains a control character, which Windows does not allow in a file name.',
    );
  });

  it('refuses a name ending in a dot or a space', () => {
    expect(fileNameProblem('notes.')).toMatch(/ends in a dot or a space/);
    expect(fileNameProblem('notes ')).toMatch(/ends in a dot or a space/);
  });

  it('refuses the reserved device names in any case, with or without an extension', () => {
    for (const name of ['CON', 'prn', 'Aux', 'NUL.md', 'com1', 'COM9.txt', 'lpt1', 'LPT9.md']) {
      expect(fileNameProblem(name)).toBe(`"${name}" is a device name Windows reserves.`);
    }
    expect(fileNameProblem('com10')).toBeUndefined();
  });
});

describe('rootProblem', () => {
  it('accepts anything under the four roots', () => {
    for (const root of FILE_ROOTS) {
      expect(rootProblem(`${root}/a.md`)).toBeUndefined();
      expect(rootProblem(`${root}/deep/er`, 'folder')).toBeUndefined();
    }
  });

  it('refuses every other top-level folder, and the project root', () => {
    for (const path of ['scenes/a.md', 'vngen/work', '.aiagent/skills/x', 'keys', 'assets/x', '']) {
      expect([path, rootProblem(path)]).toEqual([path, ROOTS_REFUSAL]);
    }
    expect(rootProblem('', 'folder')).toBe(ROOTS_REFUSAL);
    expect(rootProblem('scenes', 'folder')).toBe(ROOTS_REFUSAL);
  });

  it('accepts a root as a folder to put something in, and refuses it as an item', () => {
    expect(rootProblem('wiki', 'folder')).toBeUndefined();
    expect(rootProblem('wiki/', 'folder')).toBeUndefined();
    expect(rootProblem('wiki')).toBe(
      "wiki/ is one of the project's own folders; it cannot be created, moved or renamed.",
    );
  });

  it('refuses a path that climbs out or is not relative', () => {
    expect(rootProblem('wiki/../scenes/a.md')).toBe(
      'wiki/../scenes/a.md is not a path inside the project.',
    );
    expect(rootProblem('C:/wiki/a.md')).toBe('C:/wiki/a.md is not a path inside the project.');
    expect(rootProblem('wiki//a.md')).toBe('wiki//a.md is not a path inside the project.');
  });

  it('reads a backslashed path the same as a forward-slashed one', () => {
    expect(rootProblem('wiki\\lore\\a.md')).toBeUndefined();
    expect(rootProblem('scenes\\a.md')).toBe(ROOTS_REFUSAL);
  });

  it('refuses a user or builtin skill path by naming the tier', () => {
    expect(rootProblem('<user>/skills/voice/SKILL.md')).toBe(
      '<user>/skills/voice/SKILL.md is in a user skill, which is edited in the Skills pane; clone it into the project to change a copy.',
    );
    expect(rootProblem('<builtin>/branching', 'folder')).toMatch(/is in a builtin skill/);
  });
});

describe('planCreate', () => {
  it('joins the folder and the name', () => {
    expect(planCreate('wiki/lore', 'a.md')).toEqual({
      ok    : true,
      parent: 'wiki/lore',
      path  : 'wiki/lore/a.md',
    });
    expect(planCreate('wiki/', 'lore')).toEqual({ ok: true, parent: 'wiki', path: 'wiki/lore' });
  });

  it('refuses the folder before the name', () => {
    expect(planCreate('scenes', 'a:b')).toEqual({ ok: false, reason: ROOTS_REFUSAL });
    expect(planCreate('wiki', 'a:b')).toEqual({
      ok    : false,
      reason: '"a:b" contains ":", which Windows does not allow in a file name.',
    });
  });
});
