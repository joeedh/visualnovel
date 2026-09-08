/**
 * The mesh's half of routing: which editors are on screen, read from the panes, handed to the
 * pure `routeFor` in `rules/route.ts`. Kept apart so the rule modules can call the same function
 * with a situation's `visible` list and never read a screen.
 */
import type { EditorId } from '../../../src/shared/editors.js';
import { EDITOR_IDS } from '../../../src/shared/editors.js';
import { routeFor as routeVisible, type Route } from '../../rules/route.js';
import type { DocNode } from '../../../src/shared/ipc.js';
import { NO_PANE, paneShowing, type Pane } from './panes.js';

export { SUBJECT_OF, type Route } from '../../rules/route.js';

export interface RouteRequest {
  node: DocNode;
  panes: readonly Pane[];
}

/** The editors some pane is showing. Floating popups count, as `paneShowing` reads them. */
export function visibleEditors(panes: readonly Pane[]): EditorId[] {
  return EDITOR_IDS.filter((editor) => paneShowing(panes, editor) !== NO_PANE);
}

/** Where a click on this node lands, given the mesh as it stands. */
export function routeFor(req: RouteRequest): Route {
  return routeVisible({ node: req.node, visible: visibleEditors(req.panes) });
}
