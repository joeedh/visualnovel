/**
 * The session-store keys that describe **a window** rather than the install.
 *
 * Three of them used to be flat — `pathux.layout`, `pathux.selection`, `pathux.template` — and
 * all three were single-window in the same way the main process was. Both halves of the new key
 * are load-bearing:
 *
 * - `<n>` because two windows of one project must not share one mesh, one selection, or one
 *   layout template. The template is the one that fails loudly: `view.applyLayout` in window A
 *   writes it, and `view.resetLayout` in window B would then re-apply **A's** template to B.
 * - `<workspace>` because `session.json` is install-global (`../main/sessionstore.ts`), so two
 *   instances on two repos would otherwise both write `pathux.window.0.layout` and open into
 *   each other's arrangement — and even within one instance, a `switchWorkspace` would carry a
 *   selection made of the previous project's scene ids into a project that has none of them.
 *
 * `vn.notifications.filter` and the recents list stay flat: they are install preferences, not
 * window facts.
 *
 * **This module is in the browser bundle**, so it must stay node-free — hence a hand-rolled
 * digest rather than `node:crypto`. It is a namespace tag, not a security boundary.
 */

/** The scope segment for a project root. Case-normalized, because Windows paths are. */
export function workspaceScope(root: string): string {
  const canonical = root
    .replace(/[\\/]+$/, '')
    .toLowerCase()
    .replace(/\\/g, '/');
  // FNV-1a, 32 bits, twice over with different offsets — long enough that two open projects
  // colliding is not a thing that happens, short enough to read in a session.json.
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

/** `pathux.<workspace>.window.<n>.` — everything a window remembers hangs off this. */
export function windowKeyPrefix(scope: string, window: number): string {
  return `pathux.${scope}.window.${window}.`;
}

export function layoutKey(scope: string, window: number): string {
  return `${windowKeyPrefix(scope, window)}layout`;
}

export function selectionKey(scope: string, window: number): string {
  return `${windowKeyPrefix(scope, window)}selection`;
}

export function templateKey(scope: string, window: number): string {
  return `${windowKeyPrefix(scope, window)}template`;
}

/** The list of open windows and their bounds, so a launch restores the arrangement. */
export function windowsKey(scope: string): string {
  return `pathux.${scope}.windows`;
}

/**
 * The keys an install written before windows were plural still holds. Read **once**, as window 0
 * of whichever workspace opens first, and then left alone — an existing install must not open to
 * a default screen, and nothing needs them after the first save writes the scoped key.
 */
export const LEGACY_KEYS = {
  layout: 'pathux.layout',
  selection: 'pathux.selection',
  template: 'pathux.template',
} as const;

/** Which window a renderer is, and whose project — as its own url told it. */
export interface WindowIdentity {
  window: number;
  scope: string;
}

/**
 * Read a renderer's identity off `location.search`.
 *
 * It has to arrive this way rather than over IPC: the layout and the selection are restored
 * *before the first paint*, and `workspace.index()` is a round trip that has not come back yet.
 * Main puts both on the url when it loads the window (`?window=<n>&ws=<scope>`), which is also
 * what makes a CDP target selectable by window - one string, two readers.
 *
 * A missing or malformed pair is window 0 of an unscoped install, which is exactly what an
 * older build's url looks like.
 */
export function windowIdentity(search: string): WindowIdentity {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const index = Number(params.get('window'));
  return {
    window: Number.isInteger(index) && index >= 0 ? index : 0,
    scope: params.get('ws') ?? '',
  };
}
