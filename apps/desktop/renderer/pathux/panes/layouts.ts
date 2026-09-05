/**
 * Which layout template the window is showing, and noticing when the file behind it moves.
 *
 * The screen itself is remembered per install (`persist.ts`). A template is a file in the
 * project, so it can be edited by hand, pulled from a collaborator, or restored by an undo, none
 * of which pass through this window. Main reports a fingerprint with every template it lists, and
 * a fingerprint that has moved means the window is showing an arrangement the file no longer has.
 *
 * That is what makes undoing `view.resetLayout` visible here. The command's own effect covers the
 * reset; an undo restores the files and pushes no effect at all, so only the fingerprint reports
 * that the arrangement came back, and this re-applies it.
 */
import { editorTitle, type EditorId } from '../../../src/shared/editors.js';
import { LAYOUT_FORMAT, type LayoutFile, type LayoutSummary } from '../../../src/shared/layouts.js';
import { exec, onInvalidate } from '../app/bridge.js';
import type { ShellApp } from '../app/context.js';
import { currentScreen } from '../app/persist.js';

/** What the window is showing, and the bytes it was built from. */
let active = '';
let applied = '';

/** Only one check runs at a time, since an invalidate can land while `exec` is in flight. */
let checking = false;

/** The template the window is showing, or `''` before one has been applied. */
export function activeLayout(): string {
  return active;
}

/**
 * Record what the window is now showing. Called from the effect that applied it, so a template
 * applied from the palette, the menu or CDP is followed the same way.
 */
export function markApplied(slug: string, fingerprint: string): void {
  active = slug;
  applied = fingerprint;
}

/**
 * The arrangement on screen, in the form `view.saveLayout` writes. It is a serialized mesh rather
 * than a recipe, because an author drags borders into shapes no split grammar describes and the
 * per-pane state (the Documents editor's mode) has no recipe representation at all.
 *
 * The slug and the title are left empty. Main derives both from the name the author gives, and
 * answering here as well would let the file disagree with what it is called.
 */
export function currentLayoutFile(shell: ShellApp, editors: EditorId[]): LayoutFile | undefined {
  const screen = currentScreen(shell);
  if (screen === undefined) return undefined;

  return {
    vnstudio   : LAYOUT_FORMAT,
    slug       : '',
    title      : '',
    description: editors.map(editorTitle).join(', '),
    editors,
    source: 'saved',
    screen,
  };
}

/** Every template the project has, or an empty list if main could not say. */
export async function fetchLayouts(): Promise<{ active: string; layouts: LayoutSummary[] }> {
  const outcome = await exec('view.layouts');
  if (!outcome.ok) return { active: '', layouts: [] };
  const data = outcome.data as { active?: string; layouts?: LayoutSummary[] } | undefined;
  return { active: data?.active ?? '', layouts: data?.layouts ?? [] };
}

/**
 * Follow the file the window was built from. Subscribed to the coarse invalidate rather than to
 * `view.*`, because the writes that matter here (an undo, a pull, another window's reset) are
 * exactly the ones no command in this session ran.
 */
export function installLayoutWatch(): () => void {
  void seed();
  return onInvalidate(() => void recheck());
}

/**
 * Take the fingerprint of whatever main says is active, without applying anything. At boot the
 * window shows the mesh the session remembered, which the author regards as the template, so
 * re-applying it here would throw away a border they dragged last session.
 */
async function seed(): Promise<void> {
  const { active: slug, layouts } = await fetchLayouts();
  if (!slug) return;
  const mine = layouts.find((entry) => entry.slug === slug);
  if (mine) markApplied(slug, mine.fingerprint);
}

async function recheck(): Promise<void> {
  if (!active || checking) return;
  checking = true;
  try {
    const { layouts } = await fetchLayouts();
    const mine = layouts.find((entry) => entry.slug === active);
    if (!mine || mine.problem || mine.fingerprint === applied) return;
    // The fingerprint is adopted before the apply, so a moved file is attempted once whether or
    // not the apply takes; retrying on every later invalidate would loop with nothing to stop it
    applied = mine.fingerprint;
    await exec('view.applyLayout', { name: active });
  } finally {
    checking = false;
  }
}
