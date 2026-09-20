/**
 * Points the author at the unsaved work that refused a quit. The quit guard in `docbuffer.ts`
 * knows only paths; this maps them onto the panes holding them, outlines those panes until the
 * OS dialog is answered, and makes the first of them the active pane. A draft whose pane was
 * closed is reopened in the editor that edits it, so the outline always has something to sit on.
 */
import type { ScreenArea } from 'pathux';
import type { ShellApp } from '../app/context.js';
import type { VnEditor } from '../app/editor.js';
import type { VnScreen } from '../app/screen.js';
import { exec } from '../app/bridge.js';
import { holdRect } from './flash.js';
import { NO_PANE, paneShowing } from './panes.js';
import { panesOf } from './view.js';

/** Which editor edits a document at `path`: skills under `skills/`, everything else the Wiki pane. */
export function editorForDoc(path: string): 'skills' | 'wiki' {
  return path.startsWith('skills/') ? 'skills' : 'wiki';
}

/** The indexes of the panes whose editor holds unsaved edits to one of `paths`. */
export function panesHolding(screen: VnScreen, paths: readonly string[]): number[] {
  const wanted = new Set(paths);
  const out: number[] = [];
  (screen.sareas as ScreenArea[]).forEach((sarea, index) => {
    const editor = sarea.area as VnEditor | undefined;
    const doc = editor?.unsavedDoc?.();
    if (doc !== undefined && wanted.has(doc)) out.push(index);
  });
  return out;
}

/** Outline `index` and make it the active pane. */
function point(screen: VnScreen, index: number, activate: boolean): void {
  const sarea = (screen.sareas as ScreenArea[])[index];
  if (!sarea) return;
  holdRect((sarea as unknown as HTMLElement).getBoundingClientRect());
  if (activate) screen.sareas.active = sarea;
}

export function showUnsavedPanes(app: ShellApp, paths: readonly string[]): void {
  const screen = app.screen as VnScreen | undefined;
  if (!screen || paths.length === 0) return;
  const holding = panesHolding(screen, paths);
  holding.forEach((index, i) => point(screen, index, i === 0));
  if (holding.length > 0) return;

  // The draft outlived its pane: reopen the document where it is edited, then outline that pane
  // once the mesh has it
  const path = paths[0]!;
  const editor = editorForDoc(path);
  void exec('view.open', { editor, where: 'elsewhere', subject: path }).then(() => {
    const index = paneShowing(panesOf(screen), editor);
    if (index !== NO_PANE) point(screen, index, true);
  });
}
