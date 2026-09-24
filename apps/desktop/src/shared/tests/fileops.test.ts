import {
  FILE_ROOTS,
  ROOTS_REFUSAL,
  copyName,
  fileNameProblem,
  planCopy,
  planCreate,
  planMove,
  remapPath,
  rootProblem,
} from '../fileops.js';

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

describe('planMove', () => {
  const refusal = (paths: string[], into: string, name = ''): string => {
    const plan = planMove(paths, into, name);
    return plan.ok ? '(accepted)' : plan.reason;
  };

  it('puts each path into the folder under its own name', () => {
    expect(planMove(['wiki/a.md', 'wiki/lore/'], 'archive/')).toEqual({
      ok   : true,
      into : 'archive',
      moves: [
        { from: 'wiki/a.md', to: 'archive/a.md' },
        { from: 'wiki/lore', to: 'archive/lore' },
      ],
    });
  });

  it('renames one item with name, in its own folder or another', () => {
    expect(planMove(['wiki/a.md'], 'wiki', 'b.md')).toEqual({
      ok   : true,
      into : 'wiki',
      moves: [{ from: 'wiki/a.md', to: 'wiki/b.md' }],
    });
    expect(planMove(['wiki/a.md'], 'archive', 'old.md')).toMatchObject({
      moves: [{ from: 'wiki/a.md', to: 'archive/old.md' }],
    });
  });

  it('refuses a folder moved into itself or into a folder inside it', () => {
    expect(refusal(['wiki/lore'], 'wiki/lore')).toBe('wiki/lore cannot be put into itself.');
    expect(refusal(['wiki/lore'], 'wiki/lore/deep')).toBe(
      'wiki/lore cannot be put into wiki/lore/deep, which is inside it.',
    );
  });

  it('refuses a move into the folder the path is already in', () => {
    expect(refusal(['wiki/a.md'], 'wiki')).toBe('wiki/a.md is already in wiki.');
  });

  it('refuses a name with more than one path, and a name Windows would refuse', () => {
    expect(refusal(['wiki/a.md', 'wiki/b.md'], 'archive', 'c.md')).toBe(
      'A new name can be given only when one item is moved.',
    );
    expect(refusal(['wiki/a.md'], 'wiki', 'b?.md')).toBe(
      '"b?.md" contains "?", which Windows does not allow in a file name.',
    );
  });

  it('refuses a rename to the same name, and one that changes only letter case', () => {
    expect(refusal(['wiki/a.md'], 'wiki', 'a.md')).toBe('wiki/a.md is already called a.md.');
    expect(refusal(['wiki/a.md'], 'wiki', 'A.md')).toMatch(
      /^wiki\/a\.md and wiki\/A\.md differ only in letter case/,
    );
    expect(refusal(['wiki/lore/a.md'], 'wiki/Lore')).toMatch(/differ only in letter case/);
  });

  it('refuses two sources with one name, whatever their case', () => {
    expect(refusal(['wiki/a.md', 'archive/A.md'], 'wiki/lore')).toBe(
      'wiki/a.md and archive/A.md have the same name, so they cannot both go into wiki/lore.',
    );
  });

  it('drops a path inside a folder that is also moved', () => {
    expect(planMove(['wiki/lore/a.md', 'wiki/lore', 'wiki/lore/deep/b.md'], 'archive')).toEqual({
      ok   : true,
      into : 'archive',
      moves: [{ from: 'wiki/lore', to: 'archive/lore' }],
    });
  });

  it('refuses outside the four roots, a root itself, and nothing to move', () => {
    expect(refusal(['scenes/a.md'], 'wiki')).toBe(ROOTS_REFUSAL);
    expect(refusal(['wiki/a.md'], 'scenes')).toBe(ROOTS_REFUSAL);
    expect(refusal(['wiki'], 'archive')).toMatch(/^wiki\/ is one of the project's own folders/);
    expect(refusal([], 'wiki')).toBe('Name at least one file or folder to move.');
  });
});

describe('planCopy', () => {
  it('allows a copy into the folder the item is already in', () => {
    expect(planCopy(['wiki/a.md'], 'wiki')).toEqual({
      ok   : true,
      into : 'wiki',
      moves: [{ from: 'wiki/a.md', to: 'wiki/a.md' }],
    });
  });

  it('refuses a folder copied into itself, and drops nested paths', () => {
    expect(planCopy(['wiki/lore'], 'wiki/lore/deep')).toEqual({
      ok    : false,
      reason: 'wiki/lore cannot be put into wiki/lore/deep, which is inside it.',
    });
    expect(planCopy(['wiki/lore', 'wiki/lore/a.md'], 'archive')).toMatchObject({
      moves: [{ from: 'wiki/lore', to: 'archive/lore' }],
    });
  });
});

describe('copyName', () => {
  const holding =
    (...names: string[]) =>
    (name: string): boolean =>
      names.includes(name);

  it('keeps a free name', () => {
    expect(copyName('a.md', false, holding())).toBe('a.md');
  });

  it('adds -copy before a file extension, then -copy-2 and on', () => {
    expect(copyName('a.md', false, holding('a.md'))).toBe('a-copy.md');
    expect(copyName('a.md', false, holding('a.md', 'a-copy.md'))).toBe('a-copy-2.md');
    expect(copyName('a.md', false, holding('a.md', 'a-copy.md', 'a-copy-2.md'))).toBe(
      'a-copy-3.md',
    );
    expect(copyName('.env', false, holding('.env'))).toBe('.env-copy');
  });

  it('adds -copy to the end of a folder name, dots included', () => {
    expect(copyName('lore', true, holding('lore'))).toBe('lore-copy');
    expect(copyName('v1.2', true, holding('v1.2', 'v1.2-copy'))).toBe('v1.2-copy-2');
  });
});

describe('remapPath', () => {
  const moves = [
    { from: 'wiki/a.md', to: 'wiki/lore/a.md' },
    { from: 'wiki/cast', to: 'archive/cast' },
  ];

  it('maps a moved file, and a path under a moved folder', () => {
    expect(remapPath('wiki/a.md', moves)).toBe('wiki/lore/a.md');
    expect(remapPath('wiki/cast/aiko.md', moves)).toBe('archive/cast/aiko.md');
  });

  it('leaves everything else, including a name that only starts the same', () => {
    expect(remapPath('wiki/a.md.bak', moves)).toBe('wiki/a.md.bak');
    expect(remapPath('wiki/castle.md', moves)).toBe('wiki/castle.md');
  });
});
