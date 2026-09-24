/**
 * `doc.mkdir` and `doc.newFile` over a real directory and a real `CommandStack` with an undo
 * journal, because what these commands promise about undo is filesystem behaviour: an empty folder
 * is in no snapshot, and an empty file is.
 */
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
  const host = {
    session: new WorkspaceSession(root, true, deps),
    ui     : (effect: UiEffect) => void effects.push(effect),
    uiAll  : (effect: UiEffect) => void effects.push(effect),
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
  return { dir: root, stack, effects, run: (id, props) => stack.exec(id, props, 'ui') };
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
});
