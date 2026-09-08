/**
 * What the problems popup offers: which diagnostics can be clicked through to a scene, and what
 * the click does. The popup is an anchor home like the header, so its anchors are live while it
 * is up and gone when it closes.
 *
 * A diagnostic's `where` is an entity id rather than a scene id (a character sheet that failed to
 * parse carries one too) and a scene diagnostic can name a scene that does not exist, as a `start:`
 * pointing at nothing does. The popup therefore checks whether the id is a scene the workspace
 * lists, and only those rows become controls; the rest are labels.
 *
 * Named for the diagnostics rather than for the rail because `Rail.tsx` shares this directory and
 * a `rail.ts` beside it resolves to the same module on a case-insensitive filesystem.
 */
import type { Diagnostic } from '@vn/types';
import { diagnosticDetail } from '../../src/shared/diagnostics.js';
import type { EditorId } from '../../src/shared/editors.js';
import type { Action, Offer } from './anchors.js';
import { closePopup, publish } from './effects.js';
import { openOf, routeFor } from './route.js';

/** What the popup reads when it draws its rows. */
export interface DiagnosticsState {
  diagnostics: readonly Diagnostic[];
  /** Scene ids, so a row can tell whether its `where` names a scene the author can be taken to. */
  scenes: readonly string[];
  /** The editors some pane is showing, which is what decides where the scene opens. */
  visible: readonly EditorId[];
}

export function diagnosticScene(d: Diagnostic, scenes: Iterable<string>): string | null {
  if (!d.where) return null;
  for (const id of scenes) if (id === d.where) return d.where;
  return null;
}

/** A row's text: a mark for the severity, the message, and the entity it is about. */
export function rowText(d: Diagnostic): string {
  const mark = d.severity === 'error' ? '●' : '○';
  const where = d.where ? ` (${d.where})` : '';
  return `${mark} ${d.message}${where}`;
}

/**
 * What clicking a row about a scene does: select the scene (and no shot of it), open it where
 * the route says, then close the popup. Two rows about one scene do the same thing, so they share
 * a key and a tour rings the first.
 */
export function rowAction(d: Diagnostic, scene: string, visible: readonly EditorId[]): Offer {
  const open = openOf(
    routeFor({ node: { id: `scene:${scene}`, kind: 'scene', label: scene }, visible }),
  );
  const then: Action[] = [...(open ? [open] : []), closePopup('diagnostics')];
  return {
    ok: true,
    ...publish({ sceneId: scene, shotId: '' }),
    on     : `scene/${scene}`,
    label  : rowText(d),
    tooltip: `${diagnosticDetail(d)} · click to open ${scene}`,
    then,
  };
}

/** Every offer the popup draws from this module: the rows that name a scene, in list order. */
export function controls(state: DiagnosticsState): readonly Offer[] {
  const list: Offer[] = [];
  for (const d of state.diagnostics) {
    const scene = diagnosticScene(d, state.scenes);
    if (scene !== null) list.push(rowAction(d, scene, state.visible));
  }
  return list;
}
