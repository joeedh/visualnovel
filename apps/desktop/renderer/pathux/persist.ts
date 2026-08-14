/**
 * Layout and selection, remembered across launches. Both go into the same
 * `.vndesktop/session.json` the React rooms used, under two new keys — the flat
 * `panel.<id>.width` keys retire with the rooms that wrote them.
 *
 * The layout is nstructjs rather than hand-rolled JSON, through path.ux's own
 * `simple.saveFile`/`loadFile`: those stamp the struct schema into the blob, so a layout
 * written before path.ux changed a `STRUCT` still reads back instead of throwing. Nothing
 * here may block boot — a layout that will not load is discarded and the default screen
 * takes its place.
 */
import { DataPathWatcher, simple, type ContextLike } from 'pathux';
import { api } from '../api.js';
import type { ShellApp } from './context.js';
import { knownAreaNames } from './editor.js';
import type { ShellState } from './state.js';

const LAYOUT_KEY = 'pathux.layout';
const SELECTION_KEY = 'pathux.selection';

/** The header field is `static_string[4]`, so this is exactly four characters. */
const MAGIC = 'VNSC';
const FILE_ARGS = { magic: MAGIC, doScreen: true, useJSON: true, resetOnLoad: false };

const DEBOUNCE_MS = 400;

/** Selection is three ids and nothing else — a widget binds to `ui.*`, never to a document. */
interface StoredSelection {
  [k: string]: string;
  sceneId: string;
  shotId: string;
  characterId: string;
}

/**
 * The watchers are kept alive here on purpose: `DataPathWatcher` registers itself with a
 * `FinalizationRegistry` and prunes on collection, so one held only by the call stack stops
 * firing at the first GC.
 */
const watchers: DataPathWatcher[] = [];

let timer: ReturnType<typeof setTimeout> | undefined;

/** Coalesce the writes a drag or a resize produces into one flush. */
function schedule(shell: ShellApp): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    saveLayout(shell);
    saveSelection(shell.ui);
  }, DEBOUNCE_MS);
}

/**
 * Report this screen's shape. Called again after `view.layout` builds a new one — the hook is
 * not part of `STRUCT` and a screen that replaced another starts with none.
 */
export function watchLayout(shell: ShellApp): void {
  if (shell.screen) shell.screen.onLayoutChange = () => schedule(shell);
}

export function saveLayout(shell: ShellApp): void {
  if (!shell.screen) return;
  try {
    api.session.set(LAYOUT_KEY, simple.saveFile(shell, FILE_ARGS, []) as Record<string, never>);
  } catch (err) {
    console.warn('could not serialize the screen layout', err);
  }
}

/**
 * Rebuild the screen from the stored layout, returning whether it worked. On success the
 * screen is in the document and `shell.screen` points at it — `loadFile` does both.
 */
export function restoreLayout(shell: ShellApp): boolean {
  const stored = api.session.initial()[LAYOUT_KEY];
  if (stored === undefined || stored === null || typeof stored !== 'object') return false;
  if (!buildable(stored)) return false;

  try {
    simple.loadFile(shell, FILE_ARGS, stored);
  } catch (err) {
    console.warn('discarding an unreadable screen layout', err);
    return false;
  }
  return Boolean(shell.screen);
}

/**
 * Whether every editor the stored layout names still exists. A `ScreenArea` writes its active
 * editor as an area **name**, and `loadSTRUCT` answers one it cannot find by falling back to
 * the first registered area class rather than failing — so a layout saved before an editor was
 * removed or renamed comes back as some other editor entirely, in silence. Discarding the whole
 * layout loses a split; honouring it loses the truth about what is on screen.
 *
 * The walk is by shape rather than by path: `screen.sareas[].area` is path.ux's business, and a
 * scan for the field survives it moving.
 */
function buildable(stored: object): boolean {
  const known = knownAreaNames();
  const seen = new Set<unknown>();

  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object' || seen.has(node)) return true;
    seen.add(node);

    const areaname = (node as { area?: unknown }).area;
    if (typeof areaname === 'string' && areaname !== '' && !known.has(areaname)) {
      console.warn(`discarding a layout that wants a "${areaname}" editor this build has not got`);
      return false;
    }

    return Object.values(node).every(walk);
  };

  return walk(stored);
}

export function saveSelection(ui: ShellState): void {
  const selection: StoredSelection = {
    sceneId: ui.sceneId,
    shotId: ui.shotId,
    characterId: ui.characterId,
  };
  api.session.set(SELECTION_KEY, selection);
}

/** Restore the ids before the screen is built, so the first paint is the saved one. */
export function restoreSelection(ui: ShellState): void {
  const stored = api.session.initial()[SELECTION_KEY];
  if (
    stored === undefined ||
    stored === null ||
    typeof stored !== 'object' ||
    Array.isArray(stored)
  )
    return;

  const selection = stored as Partial<StoredSelection>;
  ui.sceneId = selection.sceneId ?? '';
  ui.shotId = selection.shotId ?? '';
  ui.characterId = selection.characterId ?? '';
}

/**
 * Start persisting. The mesh reports through `VnScreen.onLayoutChange` (every split, join,
 * border drag and window resize passes through `regenBorders`); the three selection ids
 * report through the datapath watchers, which is the same push the widgets get.
 */
export function installPersistence(shell: ShellApp): void {
  watchLayout(shell);

  for (const path of ['ui.sceneId', 'ui.shotId', 'ui.characterId']) {
    watchers.push(
      new DataPathWatcher(shell.api, shell.ctx as unknown as ContextLike, path, () =>
        schedule(shell),
      ).subscribe(),
    );
  }

  // A quit does not run the debounce, so the last few hundred milliseconds of a drag would
  // otherwise be the one thing not remembered.
  window.addEventListener('beforeunload', () => {
    if (timer !== undefined) clearTimeout(timer);
    saveLayout(shell);
    saveSelection(shell.ui);
  });
}
