/**
 * `doc.mkdir`, `doc.newFile`, `doc.move` and `doc.copy` over a real directory and a real
 * `CommandStack` with an undo journal, because what these commands promise about undo is
 * filesystem behaviour: an empty folder is in no snapshot, an empty file is, and a move is two
 * snapshots holding the same bytes at different paths.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandStack, type CommandOutcome } from '@vn/commands';
import { UndoJournal } from '@vn/commands/snapshot';
import { openGit } from '@vn/git';
import { UNDO_EXCLUDES } from '../../shared/affects.js';
import type { UiEffect } from '../../shared/ipc.js';
import { createDesktopRegistry, type CommandHost } from '../commands/index.js';
import { WorkspaceSession, type SessionDeps } from '../session.js';

const deps: SessionDeps = {
  emitEvent     : () => {},
  emitReport    : () => {},
  requestPlan   : () => Promise.resolve({ approved: false }),
  requestAnswer : () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy      : () => {},
};

interface Rig {
  dir: string;
  session: WorkspaceSession;
  stack: CommandStack<CommandHost>;
  effects: UiEffect[];
  run(id: string, props: Record<string, unknown>): Promise<CommandOutcome>;
}

/**
 * A project with the four file roots, and a stack over it that can undo. `wiki/` holds a page
 * from the start, because undoing the only write into an empty folder removes the folder too.
 */
async function rig(dir?: string): Promise<Rig> {
  const root = dir ?? (await realpath(await mkdtemp(join(tmpdir(), 'vn-files-'))));
  for (const folder of ['wiki', 'characters', 'locations', 'archive', 'scenes']) {
    await mkdir(join(root, folder), { recursive: true });
  }
  if (!dir) await writeFile(join(root, 'wiki', 'index.md'), '# Index\n');
  const effects: UiEffect[] = [];
  const session = new WorkspaceSession(root, true, deps);
  const host = {
    session,
    ui   : (effect: UiEffect) => void effects.push(effect),
    uiAll: (effect: UiEffect) => void effects.push(effect),
  } as unknown as CommandHost;
  const stack = new CommandStack<CommandHost>({
    registry: createDesktopRegistry(),
    context: {
      root,
      git: openGit(root),
      host,
      log    : () => {},
      confirm: () => Promise.resolve(true),
    },
    journal : new UndoJournal({ root, exclude: UNDO_EXCLUDES }),
  });
  return { dir: root, session, stack, effects, run: (id, props) => stack.exec(id, props, 'ui') };
}

const isDir = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => null))?.isDirectory() === true;

const gone = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => null)) === null;

/** The error a refused run gave, or a marker that it ran. */
const errorOf = (outcome: CommandOutcome): string => (outcome.ok ? '(ran)' : outcome.error);

describe('doc.mkdir', () => {
  let r: Rig;

  beforeEach(async () => {
    r = await rig();
  });

  afterEach(async () => {
    await rm(r.dir, { recursive: true, force: true });
  });

  it('creates the folder and asks the window that ran it to reveal it', async () => {
    const outcome = await r.run('doc.mkdir', { parent: 'wiki', name: 'lore' });
    expect(errorOf(outcome)).toBe('(ran)');
    expect(await isDir(join(r.dir, 'wiki', 'lore'))).toBe(true);
    expect(r.effects).toContainEqual({ type: 'docs', action: 'reveal', paths: ['wiki/lore'] });
  });

  it('leaves no undo point, so undo reaches the command before it and the folder stays', async () => {
    await r.run('doc.write', { path: 'wiki/a.md', text: '# A\n', seenHash: '' });
    const made = await r.run('doc.mkdir', { parent: 'wiki', name: 'lore' });
    expect(made.ok && made.record.undo?.changed).toBe(false);

    const undone = await r.stack.undo();
    expect(errorOf(undone)).toBe('(ran)');
    expect(await gone(join(r.dir, 'wiki', 'a.md'))).toBe(true);
    expect(await isDir(join(r.dir, 'wiki', 'lore'))).toBe(true);
  });

  it('clears the redo stack, as every mutating command does', async () => {
    await r.run('doc.write', { path: 'wiki/a.md', text: '# A\n', seenHash: '' });
    await r.stack.undo();
    expect(r.stack.canRedo()).toBe(true);
    await r.run('doc.mkdir', { parent: 'wiki', name: 'lore' });
    expect(r.stack.canRedo()).toBe(false);
  });

  it('refuses outside the four roots, a taken name, and a parent that is not there', async () => {
    await mkdir(join(r.dir, 'wiki', 'lore'));
    expect(errorOf(await r.run('doc.mkdir', { parent: 'scenes', name: 'x' }))).toMatch(
      /^Files can be created, moved and renamed only under wiki\//,
    );
    expect(errorOf(await r.run('doc.mkdir', { parent: '', name: 'extra' }))).toMatch(
      /^Files can be created/,
    );
    expect(errorOf(await r.run('doc.mkdir', { parent: 'wiki', name: 'lore' }))).toBe(
      'wiki already holds lore.',
    );
    expect(errorOf(await r.run('doc.mkdir', { parent: 'wiki/nope', name: 'x' }))).toBe(
      'no such folder: wiki/nope',
    );
  });
});

describe('doc.newFile', () => {
  let r: Rig;

  beforeEach(async () => {
    r = await rig();
  });

  afterEach(async () => {
    await rm(r.dir, { recursive: true, force: true });
  });

  it('creates an empty file, reveals it and opens it', async () => {
    const outcome = await r.run('doc.newFile', { parent: 'archive', name: 'notes.txt' });
    expect(errorOf(outcome)).toBe('(ran)');
    expect(outcome.ok && outcome.record.written).toEqual(['archive/notes.txt']);
    expect(await readdir(join(r.dir, 'archive'))).toEqual(['notes.txt']);
    expect(r.effects).toEqual([
      { type: 'docs', action: 'reveal', paths: ['archive/notes.txt'] },
      {
        type   : 'view',
        action : 'open',
        editor : 'wiki',
        where  : 'elsewhere',
        subject: 'archive/notes.txt',
      },
    ]);
  });

  it('refuses a name already taken in the folder', async () => {
    await writeFile(join(r.dir, 'wiki', 'a.md'), '# A\n');
    expect(errorOf(await r.run('doc.newFile', { parent: 'wiki', name: 'a.md' }))).toBe(
      'wiki already holds a.md.',
    );
    // The same name on Windows and macOS, where A.md and a.md are one file
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(errorOf(await r.run('doc.newFile', { parent: 'wiki', name: 'A.md' }))).toBe(
        'wiki already holds a.md.',
      );
    }
  });

  it('refuses a media extension, which undo would leave behind', async () => {
    expect(errorOf(await r.run('doc.newFile', { parent: 'wiki', name: 'cafe.PNG' }))).toBe(
      'Undo does not keep .png files, so the app does not create one; an empty .png would not ' +
        'open as one anyway.',
    );
  });

  it('refuses a path discovery would read as a character or a location', async () => {
    await mkdir(join(r.dir, 'characters', 'x'));
    expect(
      errorOf(await r.run('doc.newFile', { parent: 'characters/x', name: 'character.md' })),
    ).toBe(
      'characters/x/character.md would be the sheet for character x, and an empty sheet is a ' +
        'character with no fields. Use New character sheet… instead.',
    );
    expect(errorOf(await r.run('doc.newFile', { parent: 'locations', name: 'x.md' }))).toBe(
      'locations/x.md would be the sheet for location x, and an empty sheet is a location with ' +
        'no fields. Use New location sheet… instead.',
    );
    // A note beside a sheet is not a sheet
    expect(errorOf(await r.run('doc.newFile', { parent: 'characters/x', name: 'notes.md' }))).toBe(
      '(ran)',
    );
  });

  it('is removed again by undo', async () => {
    await r.run('doc.newFile', { parent: 'wiki', name: 'a.md', open: false });
    expect(await readdir(join(r.dir, 'wiki'))).toEqual(['a.md', 'index.md']);
    expect(errorOf(await r.stack.undo())).toBe('(ran)');
    expect(await readdir(join(r.dir, 'wiki'))).toEqual(['index.md']);
  });

  it('says why before it runs, the way a menu asks', async () => {
    expect(await r.stack.check('doc.newFile', { parent: 'wiki', name: 'a.txt' })).toEqual({
      state  : 'accept',
      message:
        'Creates the empty file wiki/a.txt. a.txt is not markdown, so the Wiki branch will not list it.',
    });
  });
});

describe('a wiki submodule that is not checked out', () => {
  let r: Rig;

  beforeAll(async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'vn-files-git-')));
    const wiki = join(dir, 'wiki');
    await mkdir(wiki);
    for (const at of [dir, wiki]) {
      const git = openGit(at);
      await git.init();
      await git.config('user.email', 'test@example.com');
      await git.config('user.name', 'Test');
    }
    await writeFile(join(wiki, 'note.md'), 'note\n');
    await openGit(wiki).commit({ message: 'wiki', paths: ['-A'] });
    await openGit(dir).commit({ message: 'record the wiki', paths: ['-A'] });
    // What a clone without `--recurse-submodules` leaves: the gitlink, and an empty directory
    await rm(wiki, { recursive: true, force: true });
    r = await rig(dir);
  }, 60_000);

  afterAll(async () => {
    await rm(r.dir, { recursive: true, force: true });
  });

  it('refuses a folder or a file made inside it, and not one made beside it', async () => {
    const refusal =
      'wiki/ is a submodule that is not checked out, so nothing written there would be in any ' +
      'history. Run `git submodule update --init` first.';
    expect(errorOf(await r.run('doc.mkdir', { parent: 'wiki', name: 'lore' }))).toBe(refusal);
    expect(errorOf(await r.run('doc.newFile', { parent: 'wiki', name: 'a.md' }))).toBe(refusal);
    expect(errorOf(await r.run('doc.mkdir', { parent: 'archive', name: 'old' }))).toBe('(ran)');
  });

  it('refuses a move or a copy into it', async () => {
    const refusal =
      'wiki/ is a submodule that is not checked out, so nothing written there would be in any ' +
      'history. Run `git submodule update --init` first.';
    await writeFile(join(r.dir, 'archive', 'a.md'), '# A\n');
    expect(errorOf(await r.run('doc.move', { paths: ['archive/a.md'], into: 'wiki' }))).toBe(
      refusal,
    );
    expect(errorOf(await r.run('doc.copy', { paths: ['archive/a.md'], into: 'wiki' }))).toBe(
      refusal,
    );
  });
});

/** Every file and folder under `dir`, with each file's text, so two states can be compared whole. */
async function treeOf(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const inner = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        out[`${inner}/`] = '';
        await visit(inner);
      } else out[inner] = await readFile(join(dir, inner), 'utf8');
    }
  };
  await visit('');
  return out;
}

/** Writes `files` under `dir`, making the folders they need. */
async function lay(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

const sheet = (kind: 'character' | 'location', name: string): string =>
  `---\ntype: ${kind}\nname: ${name}\n---\n\n# ${name}\n`;

describe('doc.move', () => {
  let r: Rig;

  beforeEach(async () => {
    r = await rig();
  });

  afterEach(async () => {
    await rm(r.dir, { recursive: true, force: true });
  });

  it('moves a file and a folder, and undo and redo restore each tree exactly', async () => {
    await lay(r.dir, {
      'wiki/a.md'          : '# A\n',
      'wiki/cast/bo.md'    : '# Bo\n',
      'wiki/cast/deep/c.md': '# C\n',
      // Not empty, because undoing the first thing put into an empty folder removes the folder
      'archive/old/keep.md': 'kept\n',
    });
    const before = await treeOf(r.dir);

    const moved = await r.run('doc.move', {
      paths: ['wiki/a.md', 'wiki/cast'],
      into : 'archive/old',
    });
    expect(errorOf(moved)).toBe('(ran)');
    const after = await treeOf(r.dir);
    expect(after['archive/old/a.md']).toBe('# A\n');
    expect(after['archive/old/cast/deep/c.md']).toBe('# C\n');
    expect(after['wiki/a.md']).toBeUndefined();

    expect(errorOf(await r.stack.undo())).toBe('(ran)');
    expect(await treeOf(r.dir)).toEqual(before);
    expect(errorOf(await r.stack.redo())).toBe('(ran)');
    expect(await treeOf(r.dir)).toEqual(after);
  });

  it('tells every window what moved and reveals the new paths in the one that ran it', async () => {
    await lay(r.dir, { 'wiki/a.md': '# A\n' });
    await mkdir(join(r.dir, 'wiki', 'lore'));
    await r.run('doc.move', { paths: ['wiki/a.md'], into: 'wiki/lore' });
    expect(r.effects).toEqual([
      { type: 'docs', action: 'moved', moves: [{ from: 'wiki/a.md', to: 'wiki/lore/a.md' }] },
      { type: 'docs', action: 'reveal', paths: ['wiki/lore/a.md'] },
    ]);
  });

  it('renames a note, and a folder of tagged sheets, by name', async () => {
    await lay(r.dir, {
      'wiki/a.md'      : '# A\n',
      'wiki/cast/bo.md': sheet('character', 'Bo'),
    });
    expect(
      errorOf(await r.run('doc.move', { paths: ['wiki/a.md'], into: 'wiki', name: 'b.md' })),
    ).toBe('(ran)');
    expect(await readFile(join(r.dir, 'wiki', 'b.md'), 'utf8')).toBe('# A\n');
    expect(
      errorOf(await r.run('doc.move', { paths: ['wiki/cast'], into: 'wiki', name: 'people' })),
    ).toBe('(ran)');
    expect(await readFile(join(r.dir, 'wiki', 'people', 'bo.md'), 'utf8')).toBe(
      sheet('character', 'Bo'),
    );
  });

  it("refuses renaming a tagged sheet's file, whose name is the id", async () => {
    await lay(r.dir, { 'wiki/cast/aiko.md': sheet('character', 'Aiko') });
    expect(
      errorOf(
        await r.run('doc.move', { paths: ['wiki/cast/aiko.md'], into: 'wiki/cast', name: 'ai.md' }),
      ),
    ).toBe(
      'wiki/cast/aiko.md is the sheet for character aiko, and its file name is the id shots and ' +
        'cast lists use. Renaming the file would make a different character. Double-click it in ' +
        'the tree to change the name it is shown under.',
    );
  });

  it('refuses a name the folder already holds, ignoring case where the filesystem does', async () => {
    await lay(r.dir, {
      'wiki/a.md'     : '# A\n',
      'wiki/lore/a.md': 'other\n',
      'wiki/lore/B.md': 'b\n',
    });
    expect(errorOf(await r.run('doc.move', { paths: ['wiki/a.md'], into: 'wiki/lore' }))).toBe(
      'wiki/lore already holds a.md.',
    );
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(
        errorOf(await r.run('doc.move', { paths: ['wiki/a.md'], into: 'wiki/lore', name: 'b.md' })),
      ).toBe('wiki/lore already holds B.md.');
    }
  });

  it('refuses a rename that changes only letter case', async () => {
    await lay(r.dir, { 'wiki/a.md': '# A\n' });
    expect(
      errorOf(await r.run('doc.move', { paths: ['wiki/a.md'], into: 'wiki', name: 'A.md' })),
    ).toMatch(/^wiki\/a\.md and wiki\/A\.md differ only in letter case/);
  });

  it('refuses a source that is not there', async () => {
    expect(errorOf(await r.run('doc.move', { paths: ['wiki/gone.md'], into: 'archive' }))).toBe(
      'no such file: wiki/gone.md',
    );
  });

  it('into a folder made by doc.mkdir, is undone together with the folder', async () => {
    await lay(r.dir, { 'wiki/a.md': '# A\n' });
    await r.run('doc.mkdir', { parent: 'wiki', name: 'lore' });
    await r.run('doc.move', { paths: ['wiki/a.md'], into: 'wiki/lore' });
    expect(errorOf(await r.stack.undo())).toBe('(ran)');
    expect(await gone(join(r.dir, 'wiki', 'lore'))).toBe(true);
    expect(await readFile(join(r.dir, 'wiki', 'a.md'), 'utf8')).toBe('# A\n');
  });

  it('gives a moved file a fresh mtime, so a capture cannot reuse the hash of an older file there', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    await lay(r.dir, { 'wiki/b.md': 'AAAA' });
    await utimes(join(r.dir, 'wiki', 'b.md'), old, old);
    // A capture now records wiki/b.md's (mtime, size) and the hash of AAAA
    await r.run('doc.write', { path: 'wiki/other.md', text: 'x', seenHash: '' });
    await rm(join(r.dir, 'wiki', 'b.md'));
    await lay(r.dir, { 'wiki/lore/b.md': 'BBBB' });
    await utimes(join(r.dir, 'wiki', 'lore', 'b.md'), old, old);

    expect(errorOf(await r.run('doc.move', { paths: ['wiki/lore/b.md'], into: 'wiki' }))).toBe(
      '(ran)',
    );
    await r.stack.undo();
    await r.stack.redo();
    expect(await readFile(join(r.dir, 'wiki', 'b.md'), 'utf8')).toBe('BBBB');
  });
});

describe('doc.copy', () => {
  let r: Rig;

  beforeEach(async () => {
    r = await rig();
  });

  afterEach(async () => {
    await rm(r.dir, { recursive: true, force: true });
  });

  it('copies beside the original under a -copy name, and undo removes the copies', async () => {
    await lay(r.dir, { 'wiki/a.md': '# A\n', 'wiki/lore/b.md': '# B\n' });
    const before = await treeOf(r.dir);
    const copied = await r.run('doc.copy', { paths: ['wiki/a.md', 'wiki/lore'], into: 'wiki' });
    expect(errorOf(copied)).toBe('(ran)');
    expect(copied.ok && copied.record.message).toBe('Copied wiki/a.md and wiki/lore into wiki.');
    expect(await readFile(join(r.dir, 'wiki', 'a-copy.md'), 'utf8')).toBe('# A\n');
    expect(await readFile(join(r.dir, 'wiki', 'lore-copy', 'b.md'), 'utf8')).toBe('# B\n');
    expect(errorOf(await r.stack.undo())).toBe('(ran)');
    expect(await treeOf(r.dir)).toEqual(before);
  });

  it("rewrites a copy's own links so they still name the same files", async () => {
    await lay(r.dir, { 'wiki/a.md': '[W](world.md)\n', 'wiki/world.md': '# W\n' });
    await mkdir(join(r.dir, 'wiki', 'lore'));
    await r.run('doc.copy', { paths: ['wiki/a.md'], into: 'wiki/lore' });
    expect(await readFile(join(r.dir, 'wiki', 'lore', 'a.md'), 'utf8')).toBe('[W](../world.md)\n');
    expect(await readFile(join(r.dir, 'wiki', 'a.md'), 'utf8')).toBe('[W](world.md)\n');
  });

  it('refuses a character or location sheet, and a note that would become one', async () => {
    await lay(r.dir, {
      'wiki/cast/aiko.md': sheet('character', 'Aiko'),
      'locations/cafe.md': '# Cafe\n',
      'wiki/note.md'     : '# Note\n',
    });
    expect(errorOf(await r.run('doc.copy', { paths: ['wiki/cast/aiko.md'], into: 'wiki' }))).toBe(
      'wiki/cast/aiko.md is the sheet for character aiko, so a copy would be a second character ' +
        'sheet. Copy its text into a new sheet instead.',
    );
    expect(
      errorOf(await r.run('doc.copy', { paths: ['locations/cafe.md'], into: 'locations' })),
    ).toBe(
      'locations/cafe.md is the sheet for location cafe, so a copy would be a second location ' +
        'sheet. Copy its text into a new sheet instead.',
    );
    expect(errorOf(await r.run('doc.copy', { paths: ['wiki/note.md'], into: 'locations' }))).toBe(
      'A copy of wiki/note.md at locations/note.md would be the sheet for location note, a ' +
        'location the project does not have now.',
    );
  });
});

describe('what undo cannot hold', () => {
  let r: Rig;

  beforeEach(async () => {
    r = await rig();
  });

  afterEach(async () => {
    await rm(r.dir, { recursive: true, force: true });
  });

  it('refuses an image, and a folder holding one', async () => {
    await lay(r.dir, { 'wiki/places/cafe.png': 'png', 'wiki/places/cafe.md': '# Cafe\n' });
    const image =
      'wiki/places/cafe.png is an image. Undo does not keep images, so the app does not move or ' +
      'copy them; move it outside the app.';
    expect(
      errorOf(await r.run('doc.move', { paths: ['wiki/places/cafe.png'], into: 'archive' })),
    ).toBe(image);
    expect(errorOf(await r.run('doc.copy', { paths: ['wiki/places'], into: 'archive' }))).toBe(
      image,
    );
  });

  it('refuses other media by its extension', async () => {
    await lay(r.dir, { 'wiki/theme.mp3': 'mp3' });
    expect(errorOf(await r.run('doc.move', { paths: ['wiki/theme.mp3'], into: 'archive' }))).toBe(
      'wiki/theme.mp3 is a .mp3 file. Undo does not keep .mp3 files, so the app does not move or ' +
        'copy them; move it outside the app.',
    );
  });

  it('refuses a folder holding a .git entry', async () => {
    await lay(r.dir, {
      'wiki/sub/.git/HEAD': 'ref: refs/heads/master\n',
      'wiki/sub/a.md'     : '# A\n',
    });
    expect(errorOf(await r.run('doc.move', { paths: ['wiki/sub'], into: 'archive' }))).toMatch(
      /^wiki\/sub\/\.git is a git repository's own folder\. Undo does not keep repositories/,
    );
  });

  it('refuses a folder holding files and an empty folder, which undo would leave behind', async () => {
    await lay(r.dir, { 'wiki/lore/a.md': '# A\n' });
    await mkdir(join(r.dir, 'wiki', 'lore', 'empty', 'deeper'), { recursive: true });
    expect(errorOf(await r.run('doc.move', { paths: ['wiki/lore'], into: 'archive' }))).toBe(
      'wiki/lore/empty is an empty folder. Undo does not keep empty folders, so undoing this ' +
        'would leave it behind; put a file in it, or remove it outside the app, first.',
    );
  });

  it('refuses a symbolic link', async () => {
    await lay(r.dir, { 'wiki/a.md': '# A\n' });
    try {
      await symlink(join(r.dir, 'wiki', 'a.md'), join(r.dir, 'wiki', 'link.md'), 'file');
    } catch {
      // Windows refuses a symbolic link to an account without the privilege, so there is nothing to test
      return;
    }
    expect(errorOf(await r.run('doc.move', { paths: ['wiki/link.md'], into: 'archive' }))).toBe(
      'wiki/link.md is a symbolic link. Undo does not keep links, so the app does not move or ' +
        'copy them; move it outside the app.',
    );
  });
});

describe('entity identity across a move', () => {
  let r: Rig;

  beforeEach(async () => {
    r = await rig();
    await lay(r.dir, {
      'characters/aiko/character.md': '---\nname: Aiko\n---\n',
      'locations/cafe.md'           : '---\nname: Cafe\n---\n',
      'locations/park.md'           : sheet('location', 'Park'),
      'wiki/cast/bo.md'             : sheet('character', 'Bo'),
      'wiki/a/dup.md'               : sheet('character', 'Dup'),
      'wiki/b/dup.md'               : sheet('character', 'Dup'),
      'wiki/note.md'                : '# Note\n',
    });
    await mkdir(join(r.dir, 'wiki', 'places'));
  });

  afterEach(async () => {
    await rm(r.dir, { recursive: true, force: true });
  });

  const move = async (paths: string[], into: string, name = ''): Promise<string> =>
    errorOf(await r.run('doc.move', { paths, into, name }));

  it('refuses moving a character folder, which would change its id', async () => {
    expect(await move(['characters/aiko'], 'wiki')).toBe(
      "Moving characters/aiko would change character aiko's id, which shots and cast lists use.",
    );
  });

  it('refuses renaming a location sheet, and moving an untagged one out of locations/', async () => {
    expect(await move(['locations/cafe.md'], 'locations', 'coffee.md')).toMatch(
      /^locations\/cafe\.md is the sheet for location cafe, and its file name is the id/,
    );
    // A sheet renamed out of markdown stops being a sheet at all
    expect(await move(['locations/cafe.md'], 'locations', 'cafe.txt')).toMatch(
      /^locations\/cafe\.md is the sheet for location cafe/,
    );
    expect(await move(['locations/cafe.md'], 'wiki/places')).toBe(
      "Moving locations/cafe.md would change location cafe's id, which shots and cast lists use.",
    );
  });

  it('refuses a plain note moved into locations/, where it would become a location', async () => {
    expect(await move(['wiki/note.md'], 'locations')).toBe(
      'Moving wiki/note.md to locations/note.md would make it the sheet for location note, a ' +
        'location the project does not have now.',
    );
  });

  it('accepts a tagged sheet moved within wiki/, and a tagged location moved into it', async () => {
    expect(await move(['wiki/cast/bo.md'], 'wiki/places')).toBe('(ran)');
    expect(await move(['locations/park.md'], 'wiki/places')).toBe('(ran)');
  });

  it('accepts a move that changes which of two duplicates wins', async () => {
    expect(await move(['wiki/a/dup.md'], 'wiki/places')).toBe('(ran)');
  });
});

describe('links follow a move', () => {
  let r: Rig;

  beforeEach(async () => {
    r = await rig();
    await lay(r.dir, {
      'wiki/a.md'                   : '# A\n\nSee [the world](world.md).\n',
      'wiki/world.md'               : '# World\n',
      'wiki/index.md'               : '[A](a.md) and [W](world.md)\n',
      'characters/aiko/character.md': '---\nname: Aiko\n---\n\nKnows [A](../../wiki/a.md).\n',
      'wiki/broken.md'              : '---\nname: [unclosed\n---\n[A](a.md)\n',
      'scenes/arrival.md'           : '[A](../wiki/a.md)\n',
      'archive/old.md'              : '[A](../wiki/a.md)\n',
      'wiki/lore/other.md'          : '# Other\n',
    });
  });

  afterEach(async () => {
    await rm(r.dir, { recursive: true, force: true });
  });

  it('rewrites links into and out of the moved file, and one undo restores every text', async () => {
    const before = await treeOf(r.dir);
    const moved = await r.run('doc.move', { paths: ['wiki/a.md'], into: 'wiki/lore' });
    expect(errorOf(moved)).toBe('(ran)');
    expect(moved.ok && moved.record.message).toBe(
      'Moved wiki/a.md to wiki/lore/a.md; updated links in 4 documents.',
    );
    const after = await treeOf(r.dir);
    expect(after['wiki/lore/a.md']).toBe('# A\n\nSee [the world](../world.md).\n');
    expect(after['wiki/index.md']).toBe('[A](lore/a.md) and [W](world.md)\n');
    expect(after['characters/aiko/character.md']).toBe(
      '---\nname: Aiko\n---\n\nKnows [A](../../wiki/lore/a.md).\n',
    );
    // A note whose front-matter does not parse is rewritten like any other and blocks nothing
    expect(after['wiki/broken.md']).toBe('---\nname: [unclosed\n---\n[A](lore/a.md)\n');
    expect(after['scenes/arrival.md']).toBe(before['scenes/arrival.md']);
    expect(after['archive/old.md']).toBe(before['archive/old.md']);

    expect(moved.ok && [...moved.record.written!].sort()).toEqual(
      [
        'characters/aiko/character.md',
        'wiki/a.md',
        'wiki/broken.md',
        'wiki/index.md',
        'wiki/lore/a.md',
      ].sort(),
    );

    expect(errorOf(await r.stack.undo())).toBe('(ran)');
    expect(await treeOf(r.dir)).toEqual(before);
  });

  it('leaves a file moved into archive/ as it was', async () => {
    await r.run('doc.move', { paths: ['wiki/a.md'], into: 'archive' });
    expect(await readFile(join(r.dir, 'archive', 'a.md'), 'utf8')).toBe(
      '# A\n\nSee [the world](world.md).\n',
    );
  });
});

describe('a transfer that fails part way', () => {
  let r: Rig;

  beforeEach(async () => {
    r = await rig();
    await lay(r.dir, {
      'wiki/a.md'    : '# A\n',
      'wiki/b.md'    : '# B\n',
      'wiki/index.md': '[A](a.md) [B](b.md)\n',
      'wiki/more.md' : '[B](b.md)\n',
    });
    await mkdir(join(r.dir, 'wiki', 'lore'));
  });

  afterEach(async () => {
    await rm(r.dir, { recursive: true, force: true });
  });

  it('puts back what it moved when a rename fails, and leaves no undo point', async () => {
    const before = await treeOf(r.dir);
    r.session.filesPart.step = async (stage, path) => {
      if (stage === 'place' && path === 'wiki/lore/b.md') throw new Error('EPERM: b.md is open');
    };
    const outcome = await r.run('doc.move', {
      paths: ['wiki/a.md', 'wiki/b.md'],
      into : 'wiki/lore',
    });
    expect(errorOf(outcome)).toBe('EPERM: b.md is open');
    expect(await treeOf(r.dir)).toEqual(before);
    expect(r.stack.canUndo()).toBe(false);
  });

  it('puts back rewritten links when a later write fails', async () => {
    const before = await treeOf(r.dir);
    let writes = 0;
    r.session.filesPart.step = async (stage) => {
      if (stage === 'relink' && ++writes === 2) throw new Error('disk full');
    };
    const outcome = await r.run('doc.move', { paths: ['wiki/b.md'], into: 'wiki/lore' });
    expect(errorOf(outcome)).toBe('disk full');
    expect(await treeOf(r.dir)).toEqual(before);
  });

  it('refuses to overwrite a linking file that changed during the run, and puts everything back', async () => {
    const before = await treeOf(r.dir);
    r.session.filesPart.step = async (stage, path) => {
      if (stage === 'relink' && path === 'wiki/index.md') {
        await writeFile(join(r.dir, 'wiki', 'index.md'), 'edited elsewhere\n');
      }
    };
    const outcome = await r.run('doc.move', { paths: ['wiki/a.md'], into: 'wiki/lore' });
    expect(errorOf(outcome)).toBe(
      'wiki/index.md changed while its links were being rewritten, so nothing was moved.',
    );
    expect(await treeOf(r.dir)).toEqual({ ...before, 'wiki/index.md': 'edited elsewhere\n' });
  });
});

describe('repository boundaries', () => {
  let r: Rig;

  beforeAll(async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'vn-files-repos-')));
    const wiki = join(dir, 'wiki');
    await mkdir(join(wiki, 'lore'), { recursive: true });
    for (const at of [dir, wiki]) {
      const git = openGit(at);
      await git.init();
      await git.config('user.email', 'test@example.com');
      await git.config('user.name', 'Test');
    }
    await writeFile(join(wiki, 'a.md'), '# A\n');
    r = await rig(dir);
  }, 60_000);

  afterAll(async () => {
    await rm(r.dir, { recursive: true, force: true });
  });

  it('refuses a move out of a nested repository into the project, and allows one inside it', async () => {
    expect(errorOf(await r.run('doc.move', { paths: ['wiki/a.md'], into: 'archive' }))).toBe(
      'wiki/a.md and archive/ are in different git repositories (wiki/ is a repository of its ' +
        'own). Moving or copying between repositories is not supported in the app, because the ' +
        "file's history would stay in one and other projects sharing wiki/ would see it vanish.",
    );
    expect(errorOf(await r.run('doc.copy', { paths: ['wiki/a.md'], into: 'archive' }))).toMatch(
      /are in different git repositories/,
    );
    expect(errorOf(await r.run('doc.move', { paths: ['wiki/a.md'], into: 'wiki/lore' }))).toBe(
      '(ran)',
    );
  });
});
