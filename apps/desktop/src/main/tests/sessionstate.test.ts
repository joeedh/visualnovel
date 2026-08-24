import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_STATE_DIR, SessionState } from '../sessionstate.js';
import { SessionStore } from '../sessionstore.js';
import {
  layoutKey,
  workspaceScope,
  APPROVAL_ORDER_KEY,
  WINDOWS_KEY,
} from '../../shared/sessionkeys.js';

const LAYOUT = layoutKey(0);

/** Where a project's own session file ends up, for reading it back. */
function sessionFile(root: string): string {
  return join(root, PROJECT_STATE_DIR, 'session.json');
}

describe('SessionState', () => {
  let home: string;
  let root: string;
  let install: SessionStore;
  let state: SessionState;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vn-install-'));
    root = await mkdtemp(join(tmpdir(), 'vn-project-'));
    install = await SessionStore.open(home);
    state = new SessionState(install);
  });

  afterEach(async () => {
    await state.close();
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('routes a window key to the project and a preference to the install', async () => {
    await state.openProject(root);
    state.set(LAYOUT, 'mesh');
    state.set('agent.budget', 'medium');
    await state.flush();

    expect(JSON.parse(await readFile(sessionFile(root), 'utf8'))).toEqual({ [LAYOUT]: 'mesh' });
    expect(JSON.parse(await readFile(join(home, 'session.json'), 'utf8'))).toEqual({
      'agent.budget': 'medium',
    });
  });

  it('answers both files as one snapshot', async () => {
    await state.openProject(root);
    state.set(LAYOUT, 'mesh');
    state.set('agent.budget', 'medium');

    expect(state.snapshot()).toEqual({ [LAYOUT]: 'mesh', 'agent.budget': 'medium' });
  });

  it('keeps each project to its own file', async () => {
    const other = await mkdtemp(join(tmpdir(), 'vn-other-'));
    try {
      await state.openProject(root);
      state.set(LAYOUT, 'first');
      await state.openProject(other);

      expect(state.get(LAYOUT, '')).toBe('');
      state.set(LAYOUT, 'second');
      await state.flush();

      expect(JSON.parse(await readFile(sessionFile(root), 'utf8'))[LAYOUT]).toBe('first');
      expect(JSON.parse(await readFile(sessionFile(other), 'utf8'))[LAYOUT]).toBe('second');
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('keeps the approval order with the project it was read from', async () => {
    const other = await mkdtemp(join(tmpdir(), 'vn-other-'));
    try {
      await state.openProject(root);
      state.set(APPROVAL_ORDER_KEY, ['a', 'b']);
      await state.flush();
      await state.openProject(other);

      expect(state.get<string[]>(APPROVAL_ORDER_KEY, [])).toEqual([]);
      expect(JSON.parse(await readFile(sessionFile(root), 'utf8'))[APPROVAL_ORDER_KEY]).toEqual([
        'a',
        'b',
      ]);
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('drops a write stamped with a project other than the open one', async () => {
    await state.openProject(root);

    state.set(LAYOUT, 'stale', workspaceScope('C:/dev/somewhere else'));
    expect(state.get(LAYOUT, '')).toBe('');

    // A window loaded for this project, and a caller with no stamp at all, both land.
    state.set(LAYOUT, 'mine', workspaceScope(root));
    expect(state.get(LAYOUT, '')).toBe('mine');
    state.set(LAYOUT, 'unstamped');
    expect(state.get(LAYOUT, '')).toBe('unstamped');
  });

  it('seeds a project that has no file of its own from the install file, once', async () => {
    const scope = workspaceScope(root);
    install.set(`pathux.${scope}.window.0.layout`, 'from the install');
    install.set(`pathux.${scope}.windows`, 'the list');
    install.set('agent.budget', 'medium');

    await state.openProject(root);
    expect(state.get(LAYOUT, '')).toBe('from the install');
    expect(state.get(WINDOWS_KEY, '')).toBe('the list');
    // The install's own copies stay put, so an older build still opens the project as it did.
    expect(install.get(`pathux.${scope}.window.0.layout`, '')).toBe('from the install');

    state.set(LAYOUT, 'rearranged');
    await state.flush();
    install.set(`pathux.${scope}.window.0.layout`, 'moved since');
    await state.openProject(root);
    expect(state.get(LAYOUT, '')).toBe('rearranged');
  });

  it('keeps no arrangement for a project it cannot write, and says so once', async () => {
    await writeFile(join(root, PROJECT_STATE_DIR), 'not a directory');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await state.openProject(root);

      state.set(LAYOUT, 'mesh');
      expect(state.get(LAYOUT, 'nothing')).toBe('nothing');
      // The install file is unaffected: a preference is not the project's to lose.
      state.set('agent.budget', 'medium');
      expect(state.get('agent.budget', '')).toBe('medium');
    } finally {
      warn.mockRestore();
    }
  });
});
