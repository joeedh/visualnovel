/**
 * The assets that reference something, as a strip any editor can draw under itself.
 *
 * It takes groups rather than a subject: a host that knows how to find the art for the thing it is
 * showing supplies them, and this file knows nothing about characters, scenes or the manifest.
 *
 * It is read-only on purpose. Accept, regenerate and delete belong to the asset editor and the
 * context menu; a cross-reference view that also mutated would need `stack.check` plumbing in
 * every host.
 */
import type { EntityLinks } from '../../src/shared/ipc.js';
import type { AssetGroup } from './doctree.js';
import ASSETSTRIP_CSS from '../styles/assetstrip.css?inline';

export { ASSETSTRIP_CSS };

export interface AssetStripHandlers {
  /** A cell was clicked. The host decides what that means; every host routes. */
  onPick(hash: string): void;
}

/**
 * Draw `groups` into `root`, replacing whatever was there. An empty group list draws `empty`, the
 * host's own sentence, so an author can see that nothing is generated from this page. A host with
 * a better place to say that passes `''` and gets nothing drawn.
 */
export function renderAssetStrip(
  root: HTMLElement,
  groups: readonly AssetGroup[],
  empty: string,
  handlers: AssetStripHandlers,
): void {
  root.textContent = '';
  const drawn = groups.filter((g) => g.assets.length > 0);
  if (drawn.length === 0) {
    if (empty !== '') root.appendChild(el('div', 'as-empty', empty));
    return;
  }
  for (const group of drawn) {
    root.appendChild(el('div', 'as-section', group.title));
    const row = el('div', 'as-row');
    for (const asset of group.assets) row.appendChild(cell(asset, handlers));
    root.appendChild(row);
  }
}

/**
 * One stored image, by hash. Portraits and model sheets are base art, so the `vnasset://` handler
 * consults both asset roots. Without the second root this strip draws empty frames.
 */
function cell(asset: EntityLinks['assets'][number], handlers: AssetStripHandlers): HTMLElement {
  const box = el('div', `as-cell${asset.accepted ? ' accepted' : ''}`);
  box.title = `${asset.label}${asset.accepted ? ' · accepted' : ''} — open it in the asset editor`;
  const img = document.createElement('img');
  img.src = `vnasset://${asset.hash}.${asset.ext}`;
  img.alt = asset.kind;
  box.appendChild(img);
  box.addEventListener('click', () => handlers.onPick(asset.hash));
  return box;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
