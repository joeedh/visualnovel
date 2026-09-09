/**
 * What a cell of the asset strip offers. Three panes draw the strip (Documents, Script, Wiki), so
 * the offer lives here rather than in any one of their modules: a click selects the asset and then
 * opens the editor that claims it, with `where` from the route.
 */
import type { Offer } from './anchors.js';
import { publish } from './effects.js';
import { openOf, routeFor } from './route.js';
import type { EditorId } from '../../src/shared/editors.js';

/** The facts about a stored image that its cell reads. */
export interface StripAsset {
  hash: string;
  label: string;
  accepted: boolean;
}

/** One cell: select the asset and open it where the route says. Keyed `link/asset/<hash>`. */
export function cellAction(asset: StripAsset, visible: readonly EditorId[]): Offer {
  const node = { id: `asset:${asset.hash}`, kind: 'asset' as const, label: asset.hash };
  const open = openOf(routeFor({ node, visible }));
  return {
    ok: true,
    ...publish({ assetHash: asset.hash }),
    on     : `link/asset/${asset.hash}`,
    label  : asset.label,
    tooltip: `${asset.label}${asset.accepted ? ' · accepted' : ''} — open it in the asset editor`,
    ...(open ? { then: [open] } : {}),
  };
}
