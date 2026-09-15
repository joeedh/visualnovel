/** The Refresh models button, drawn beside both image-model pickers. */
import { refuse, type Offer } from './anchors.js';

/**
 * Fetch OpenRouter's image-model listing again. The tooltip says how old the cached list is, or
 * that there is none, since that is what decides whether a refresh is worth the wait. The list is
 * per user, but the command runs in a workspace session, so it is refused with no project open.
 */
export function refreshModelsAction(opened: boolean, catalogAsOf: string | undefined): Offer {
  const control = {
    id     : 'models.refresh',
    label  : 'Refresh models',
    tooltip: catalogAsOf
      ? `Fetch the image models OpenRouter routes to again; the cached list is from ${catalogAsOf}`
      : 'Fetch the image models OpenRouter routes to; none are cached yet, so the pickers list only the shipped ids',
  };
  if (!opened) return { ...refuse('No project is open.'), ...control };
  return { ok: true, props: {}, ...control };
}
