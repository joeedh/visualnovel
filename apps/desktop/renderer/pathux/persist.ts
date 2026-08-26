/**
 * Layout and selection, remembered across launches. Both land in the project's own
 * `.vnstudio/session.json` (`../../src/main/sessionstate.ts` routes them there), under one key
 * per window, because a mesh is the one thing every window has its own of.
 *
 * Which window this is arrives on the url rather than over IPC: restoring happens before the
 * first paint, and `workspace.index()` has not come back yet. The workspace digest arrives the
 * same way, and every write carries it so main can drop one made for a project that has since
 * been closed.
 *
 * The layout is nstructjs rather than hand-rolled JSON, through path.ux's own
 * `simple.saveFile`/`loadFile`: those stamp the struct schema into the blob, so a layout
 * written before path.ux changed a `STRUCT` still reads back instead of throwing. Nothing
 * here may block boot — a layout that will not load is discarded and the default screen
 * takes its place.
 */
import { DataPathWatcher, simple, type ContextLike } from 'pathux';
import { api } from '../api.js';
import {
  LEGACY_KEYS,
  layoutKey,
  selectionKey,
  windowIdentity,
} from '../../src/shared/sessionkeys.js';
import type { ShellApp } from './context.js';
import { knownAreaNames } from './editor.js';
import type { ShellState } from './state.js';

const ME = windowIdentity(location.search);

const LAYOUT_KEY = layoutKey(ME.window);
const SELECTION_KEY = selectionKey(ME.window);

/**
 * What an install written before windows were plural left behind, read as window 0.
 *
 * Only window 0 may inherit it, and only for a read — the first save writes the per-window key
 * and the flat one is never written again. Without this an existing install would open, once, to a
 * default screen with nothing selected, which reads as data loss even though nothing was lost.
 */
function stored(key: string, legacy: string): unknown {
  const session = api.session.initial();
  const own = session[key];
  if (own !== undefined) return own;
  return ME.window === 0 ? session[legacy] : undefined;
}

/** The header field is `static_string[4]`, so this is exactly four characters. */
const MAGIC = 'VNSC';
const FILE_ARGS = { magic: MAGIC, doScreen: true, useJSON: true, resetOnLoad: false };

const DEBOUNCE_MS = 400;

/**
 * Holds what the author is looking at, never anything that changes a document. A widget binds to
 * `ui.*` and dispatches a command rather than writing a document through the shell.
 *
 * `docPath` is a path rather than an id and is the one entry here that names a file. It has to be
 * a path, because `DocNode.path` and `EntityLinks.sheet` are paths and a free-form note under
 * `wiki/` has no id at all. It is still a selection rather than a buffer: the tree publishes it
 * and an editor reads it.
 *
 * The two hashes are saved as well, and both may name nothing by the next launch. `assetHash` is
 * repaired against `asset.info` once the first paint is up (`../rules/uistate.ts`); `taskHash` has
 * no repair rule, because a task hash is stable while its inputs are and the inspector already
 * answers a miss by fetching once and drawing nothing.
 */
export interface StoredSelection {
  [k: string]: string;
  sceneId: string;
  shotId: string;
  characterId: string;
  docPath: string;
  assetHash: string;
  taskHash: string;
  graphSlug: string;
}

/**
 * The watchers are kept alive here on purpose: `DataPathWatcher` registers itself with a
 * `FinalizationRegistry` and prunes on collection, so one held only by the call stack stops
 * firing at the first GC.
 */
const watchers: DataPathWatcher[] = [];

let timer: ReturnType<typeof setTimeout> | undefined;

/** The shell persistence was installed against, so a pane can report a change of its own. */
let host: ShellApp | undefined;

/**
 * Report that a pane changed a field it remembers — the documents editor's mode, for one.
 * `onLayoutChange` cannot see it: nothing about the screen's shape moved, only what is inside
 * a pane, and the field is part of the same saved blob.
 */
export function layoutChanged(): void {
  if (host) schedule(host);
}

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

/**
 * The mesh as it stands, in the form both the session and a saved template store it in.
 * `undefined` when it cannot be serialized, which a caller must treat as "nothing to save"
 * rather than as an empty layout.
 */
export function currentScreen(shell: ShellApp): unknown {
  if (!shell.screen) return undefined;
  try {
    return simple.saveFile(shell, FILE_ARGS, []);
  } catch (err) {
    console.warn('could not serialize the screen layout', err);
    return undefined;
  }
}

export function saveLayout(shell: ShellApp): void {
  const blob = currentScreen(shell);
  if (blob !== undefined) api.session.set(LAYOUT_KEY, blob as Record<string, never>, ME.scope);
}

/**
 * Install a serialized screen, returning whether it worked. Shared by the boot restore and by a
 * layout template, so both get the same `buildable` gate.
 *
 * The caller owns the screen being replaced: `loadFile` unlistens and removes the old one but
 * does not destroy it, and a screen that still holds its window listeners goes on answering the
 * pointer from underneath the new one.
 */
export function loadScreen(shell: ShellApp, blob: object): boolean {
  if (!buildable(blob)) return false;

  try {
    simple.loadFile(shell, FILE_ARGS, blob);
  } catch (err) {
    console.warn('discarding an unreadable screen layout', err);
    return false;
  }
  return Boolean(shell.screen);
}

/**
 * Rebuild the screen from the stored layout, returning whether it worked. On success the
 * screen is in the document and `shell.screen` points at it — `loadFile` does both.
 */
export function restoreLayout(shell: ShellApp): boolean {
  const blob = stored(LAYOUT_KEY, LEGACY_KEYS.layout);
  if (blob === undefined || blob === null || typeof blob !== 'object') return false;
  return loadScreen(shell, blob);
}

/**
 * Whether every editor the stored layout names still exists. A `ScreenArea` writes its active
 * editor as an area name, and `loadSTRUCT` answers one it cannot find by falling back to
 * the first registered area class rather than failing — so a layout saved before an editor was
 * removed or renamed comes back as some other editor entirely, in silence. Discarding the whole
 * layout loses a split; honouring it loses the truth about what is on screen.
 *
 * The walk is by shape rather than by path: `screen.sareas[].area` is path.ux's business, and a
 * scan for the field survives it moving.
 */
function buildable(blob: object): boolean {
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

  return walk(blob);
}

export function saveSelection(ui: ShellState): void {
  const selection: StoredSelection = {
    sceneId: ui.sceneId,
    shotId: ui.shotId,
    characterId: ui.characterId,
    docPath: ui.docPath,
    assetHash: ui.assetHash,
    taskHash: ui.taskHash,
    graphSlug: ui.graphSlug,
  };
  api.session.set(SELECTION_KEY, selection, ME.scope);
}

/**
 * Restore the selection before the screen is built, so the first paint is the saved one, and
 * answer what was written. The caller checks that against the project — see `settleSelection` in
 * `./shell.ts` — and clears only a field still holding what this put there.
 */
export function restoreSelection(ui: ShellState): StoredSelection {
  const saved = stored(SELECTION_KEY, LEGACY_KEYS.selection);
  if (saved !== undefined && saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
    const selection = saved as Partial<StoredSelection>;
    ui.sceneId = selection.sceneId ?? '';
    ui.shotId = selection.shotId ?? '';
    ui.characterId = selection.characterId ?? '';
    ui.docPath = selection.docPath ?? '';
    ui.assetHash = selection.assetHash ?? '';
    ui.taskHash = selection.taskHash ?? '';
    ui.graphSlug = selection.graphSlug ?? '';
  }
  return {
    sceneId: ui.sceneId,
    shotId: ui.shotId,
    characterId: ui.characterId,
    docPath: ui.docPath,
    assetHash: ui.assetHash,
    taskHash: ui.taskHash,
    graphSlug: ui.graphSlug,
  };
}

/**
 * Start persisting. The mesh reports through `VnScreen.onLayoutChange` (every split, join,
 * border drag and window resize passes through `regenBorders`); the selection reports through
 * the datapath watchers, which is the same push the widgets get.
 */
export function installPersistence(shell: ShellApp): void {
  host = shell;
  watchLayout(shell);

  // Every persisted field needs a watcher of its own: the debounce is scheduled from here, and
  // clicking an asset or a task moves nothing else.
  const paths = [
    'ui.sceneId',
    'ui.shotId',
    'ui.characterId',
    'ui.docPath',
    'ui.assetHash',
    'ui.taskHash',
    'ui.graphSlug',
  ];
  // `immediate` rather than the default `raf`: a hidden or minimized window runs no animation
  // frames, so a raf-coalesced watcher stays dirty and never fires. `schedule` has a debounce of
  // its own, so firing on the write costs nothing.
  for (const path of paths) {
    watchers.push(
      new DataPathWatcher(
        shell.api,
        shell.ctx as unknown as ContextLike,
        path,
        () => schedule(shell),
        { debounce: 'immediate' },
      ).subscribe(),
    );
  }

  // A quit skips the debounce, so this handler saves directly. Otherwise the last
  // `DEBOUNCE_MS` of a drag would go unsaved
  window.addEventListener('beforeunload', () => {
    if (timer !== undefined) clearTimeout(timer);
    saveLayout(shell);
    saveSelection(shell.ui);
  });
}
