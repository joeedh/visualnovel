/**
 * The per-window session keys. The shape of these strings is what keeps two windows from sharing
 * one mesh and two projects from sharing one window 0. Neither collision raises an error at
 * runtime, so the keys are pinned here instead.
 */
import {
  LEGACY_KEYS,
  layoutKey,
  selectionKey,
  templateKey,
  windowIdentity,
  windowKeyPrefix,
  windowsKey,
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
  const scope = workspaceScope('C:/dev/story');

  it('hang off one prefix, per workspace and per window', () => {
    expect(windowKeyPrefix(scope, 2)).toBe(`pathux.${scope}.window.2.`);
    expect(layoutKey(scope, 2)).toBe(`pathux.${scope}.window.2.layout`);
    expect(selectionKey(scope, 2)).toBe(`pathux.${scope}.window.2.selection`);
    expect(templateKey(scope, 2)).toBe(`pathux.${scope}.window.2.template`);
  });

  it('never collide across windows or across projects', () => {
    const other = workspaceScope('C:/dev/other');
    const keys = [
      layoutKey(scope, 0),
      layoutKey(scope, 1),
      layoutKey(other, 0),
      templateKey(scope, 0),
      selectionKey(scope, 0),
      windowsKey(scope),
      windowsKey(other),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the window list per workspace but not per window', () => {
    expect(windowsKey(scope)).toBe(`pathux.${scope}.windows`);
  });

  it('is none of the flat keys an older install wrote', () => {
    const legacy = new Set<string>(Object.values(LEGACY_KEYS));
    expect(legacy.has(layoutKey(scope, 0))).toBe(false);
    expect(legacy.has(templateKey(scope, 0))).toBe(false);
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
