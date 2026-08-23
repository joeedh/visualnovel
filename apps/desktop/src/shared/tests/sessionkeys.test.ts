/**
 * The per-window session keys, and which of the two session files each one lands in. The shape of
 * these strings is what keeps two windows from sharing one mesh, and a key routed to the wrong
 * file raises no error at runtime, so both are pinned here.
 */
import {
  LEGACY_KEYS,
  WINDOWS_KEY,
  isProjectKey,
  layoutKey,
  scopedWindowKeys,
  selectionKey,
  templateKey,
  windowIdentity,
  windowKeyPrefix,
  workspaceScope,
} from '../sessionkeys.js';

describe('workspaceScope', () => {
  it('is stable, and the same for two spellings of one directory', () => {
    expect(workspaceScope('C:/dev/story')).toBe(workspaceScope('C:/dev/story'));
    expect(workspaceScope('C:/dev/story')).toBe(workspaceScope('C:\\Dev\\Story\\'));
  });

  it('separates two projects', () => {
    expect(workspaceScope('C:/dev/story')).not.toBe(workspaceScope('C:/dev/other'));
  });

  it('is a bare token, so a key built from it stays readable in session.json', () => {
    expect(workspaceScope('C:/dev/story')).toMatch(/^[0-9a-z]+$/);
  });
});

describe('the keys a window owns', () => {
  it('hang off one prefix, per window and with no scope segment', () => {
    expect(windowKeyPrefix(2)).toBe('pathux.window.2.');
    expect(layoutKey(2)).toBe('pathux.window.2.layout');
    expect(selectionKey(2)).toBe('pathux.window.2.selection');
    expect(templateKey(2)).toBe('pathux.window.2.template');
  });

  it('never collide across windows', () => {
    const keys = [layoutKey(0), layoutKey(1), templateKey(0), selectionKey(0), WINDOWS_KEY];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the window list per project but not per window', () => {
    expect(WINDOWS_KEY).toBe('pathux.windows');
  });

  it('is none of the flat keys an older install wrote', () => {
    const legacy = new Set<string>(Object.values(LEGACY_KEYS));
    expect(legacy.has(layoutKey(0))).toBe(false);
    expect(legacy.has(templateKey(0))).toBe(false);
  });
});

describe('isProjectKey', () => {
  it('claims every pathux key, including one no version has written yet', () => {
    expect(isProjectKey(layoutKey(0))).toBe(true);
    expect(isProjectKey(WINDOWS_KEY)).toBe(true);
    expect(isProjectKey('pathux.approvalOrder')).toBe(true);
  });

  it('leaves the install preferences alone', () => {
    expect(isProjectKey('agent.budget')).toBe(false);
    expect(isProjectKey('vn.notifications.filter')).toBe(false);
    expect(isProjectKey('workspace.recent')).toBe(false);
  });

  it('leaves the flat legacy keys in the install file, where they were written', () => {
    for (const key of Object.values(LEGACY_KEYS)) expect(isProjectKey(key)).toBe(false);
  });
});

describe('scopedWindowKeys', () => {
  const scope = workspaceScope('C:/dev/story');
  const other = workspaceScope('C:/dev/other');

  it('takes one workspace out of the install file, unscoped', () => {
    const snapshot = {
      [`pathux.${scope}.window.0.layout`]: 'mine',
      [`pathux.${scope}.windows`]: 'list',
      [`pathux.${other}.window.0.layout`]: 'theirs',
      'agent.budget': 'medium',
    };
    expect(scopedWindowKeys(snapshot, scope)).toEqual({
      'pathux.window.0.layout': 'mine',
      'pathux.windows': 'list',
    });
  });

  it('answers nothing for a workspace the install file never held', () => {
    expect(scopedWindowKeys({ 'agent.budget': 'medium' }, scope)).toEqual({});
  });
});

describe('windowIdentity', () => {
  it('reads the pair main put on the url', () => {
    expect(windowIdentity('?window=3&ws=abc123')).toEqual({ window: 3, scope: 'abc123' });
    expect(windowIdentity('window=1&ws=x')).toEqual({ window: 1, scope: 'x' });
  });

  it('falls back to window 0 of an unscoped install, which is what an older url looks like', () => {
    expect(windowIdentity('')).toEqual({ window: 0, scope: '' });
    expect(windowIdentity('?mock=1')).toEqual({ window: 0, scope: '' });
    expect(windowIdentity('?window=notanumber&ws=x')).toEqual({ window: 0, scope: 'x' });
    expect(windowIdentity('?window=-2')).toEqual({ window: 0, scope: '' });
  });
});
