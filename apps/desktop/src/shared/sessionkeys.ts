/**
 * The session-store keys that describe a window rather than the install, and the rule for which
 * of the two session files a key belongs in.
 *
 * A `pathux.` key is the project's and lands in `<root>/.vnstudio/session.json`; everything else
 * is the install's. `<n>` is load-bearing because two windows of one project must not share one
 * mesh, one selection, or one layout template — the template is the one that fails loudly, since
 * `view.applyLayout` in window A writes it and `view.resetLayout` in window B would then
 * re-apply window A's template to B.
 *
 * A project key carries no scope segment. The digest below is still needed for two things: the
 * one-time migration reads the install file's old `pathux.<workspace>.` keys, and a window
 * stamps its writes with the scope it was loaded for, so a renderer that has not been reloaded
 * yet cannot write into a project opened after it.
 *
 * `vn.notifications.filter`, `agent.budget` and the recents list stay in the install file: they
 * are install preferences, not project facts.
 *
 * This module is in the browser bundle, so it must stay node-free — hence a hand-rolled digest
 * rather than `node:crypto`. It is a namespace tag, not a security boundary.
 */

/** The scope segment for a project root. Case-normalized, because Windows paths are. */
export function workspaceScope(root: string): string {
  const canonical = root
    .replace(/[\\/]+$/, '')
    .toLowerCase()
    .replace(/\\/g, '/');
  // FNV-1a, 32 bits, twice over with different offsets — wide enough that two open projects are
  // very unlikely to collide, short enough to read in a session.json
  const fnv = (offset: number): string => {
    let hash = offset;
    for (let i = 0; i < canonical.length; i++) {
      hash ^= canonical.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(7, '0');
  };
  return `${fnv(0x811c9dc5)}${fnv(0x9e3779b9)}`;
}

/** `pathux.window.<n>.` — everything a window remembers hangs off this. */
export function windowKeyPrefix(window: number): string {
  return `pathux.window.${window}.`;
}

export function layoutKey(window: number): string {
  return `${windowKeyPrefix(window)}layout`;
}

export function selectionKey(window: number): string {
  return `${windowKeyPrefix(window)}selection`;
}

export function templateKey(window: number): string {
  return `${windowKeyPrefix(window)}template`;
}

/** The list of open windows and their bounds, so a launch restores the arrangement. */
export const WINDOWS_KEY = 'pathux.windows';

/**
 * The keys an install written before windows were plural still holds. They are read once, as
 * window 0 of whichever workspace opens first, and then left alone — an existing install must not
 * open to a default screen, and nothing needs them after the first save writes the current key.
 */
export const LEGACY_KEYS = {
  layout: 'pathux.layout',
  selection: 'pathux.selection',
  template: 'pathux.template',
} as const;

const LEGACY_KEY_SET = new Set<string>(Object.values(LEGACY_KEYS));

/**
 * Whether a key belongs to the open project's session file rather than the install's.
 *
 * Tested by prefix rather than by listing the keys, so a `pathux.` key added later routes
 * correctly without being registered anywhere. The three legacy flat keys are the exception:
 * they were written into the install file before there were two, and they are still read from
 * there.
 */
export function isProjectKey(key: string): boolean {
  return key.startsWith('pathux.') && !LEGACY_KEY_SET.has(key);
}

/**
 * One workspace's window keys as they were written before this file existed, rewritten to their
 * unscoped names — what seeds a project's session file the first time it is opened.
 */
export function scopedWindowKeys<T>(snapshot: Record<string, T>, scope: string): Record<string, T> {
  const prefix = `pathux.${scope}.`;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key.startsWith(prefix)) out[`pathux.${key.slice(prefix.length)}`] = value;
  }
  return out;
}

/** Which window a renderer is, and which project it belongs to, as read from its own url. */
export interface WindowIdentity {
  window: number;
  /** Stamped onto every project-key write, so main can drop one made for the previous project. */
  scope: string;
}

/**
 * Read a renderer's identity off `location.search`.
 *
 * It has to arrive this way rather than over IPC: the layout and the selection are restored
 * before the first paint, and `workspace.index()` is a round trip that has not come back yet.
 * Main puts both on the url when it loads the window (`?window=<n>&ws=<scope>`), which is also
 * what makes a CDP target selectable by window.
 *
 * A missing or malformed pair is window 0 with an empty scope, which is exactly what an older
 * build's url looks like.
 */
export function windowIdentity(search: string): WindowIdentity {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const index = Number(params.get('window'));
  return {
    window: Number.isInteger(index) && index >= 0 ? index : 0,
    scope: params.get('ws') ?? '',
  };
}
