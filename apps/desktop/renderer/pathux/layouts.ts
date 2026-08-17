/**
 * Which layout template the window is showing, and noticing when the file behind it moves.
 *
 * The screen itself is remembered per install (`persist.ts`); a *template* is a file in the
 * project, so it can be edited by hand, pulled from a collaborator, or restored by an undo —
 * none of which pass through this window. The fingerprint is how those are noticed: main
 * reports one with every template it lists, and an arrangement whose fingerprint moved is one
 * the window is no longer honestly showing.
 *
 * This is what makes `view.resetLayout` undoable in the sense the author means. The command's
 * own effect covers the reset; undo restores the files and nothing pushes an effect at all —
 * only the fingerprint says the arrangement came back, and this re-applies it.
 */
import { editorTitle, type EditorId } from '../../src/shared/editors.js';
import { LAYOUT_FORMAT, type LayoutFile, type LayoutSummary } from '../../src/shared/layouts.js';
import { exec, onInvalidate } from './bridge.js';
import type { ShellApp } from './context.js';
import { currentScreen } from './persist.js';

/** What the window is showing, and the bytes it was built from. */
let active = '';
let applied = '';

/** One at a time: `exec` is async, and an invalidate can land while a check is in flight. */
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
 * The arrangement on screen, as the file `view.saveLayout` files — a serialized mesh rather than
 * a recipe, because an author drags borders into shapes no split grammar describes and the
 * per-pane state (the Documents editor's mode) has no recipe representation at all.
 *
 * The slug and the title are left empty: main derives both from the name the author gives, and
 * a second answer here is how a file starts disagreeing with what it is called.
 */
export function currentLayoutFile(shell: ShellApp, editors: EditorId[]): LayoutFile | undefined {
  const screen = currentScreen(shell);
  if (screen === undefined) return undefined;

  return {
    vnstudio: LAYOUT_FORMAT,
    slug: '',
    title: '',
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
 * `view.*`: the writes that matter here — an undo, a pull, another window's reset — are exactly
 * the ones no command in this session ran.
 */
export function installLayoutWatch(): () => void {
  void seed();
  return onInvalidate(() => void recheck());
}

/**
 * Take the fingerprint of whatever main says is active, without applying anything. At boot the
 * window is the mesh the session remembered, which *is* the template as far as the author is
 * concerned — re-applying it here would throw away a border they dragged last session.
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
    // Adopt the fingerprint first: one moved file is one attempt, whether or not the apply
    // takes. Re-trying it on every subsequent invalidate would be a loop nothing breaks.
    applied = mine.fingerprint;
    await exec('view.applyLayout', { name: active });
  } finally {
    checking = false;
  }
}
