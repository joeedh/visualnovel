/**
 * The model dropdowns several surfaces draw: the text-model menu of the header, the Convo pane
 * and the Project pane, and the image-model menu of a shot, a rung and a wardrobe entry. The
 * rows are the curated or shipped ids plus whatever the cached listing holds, sorted by id,
 * rebuilt each time the menu opens so a refreshed listing is in the next menu without a rebuild
 * of the surface, and opened in search mode because the listing runs to hundreds of rows.
 */
import { imageModelChoices, modelCatalog } from '@vn/gengraph';
import { textModelChoices } from '@vn/types';
import {
  UIBase,
  type Container,
  type ContextLike,
  type DropBox,
  type MenuTemplate,
  type RowFrame,
} from 'pathux';

/** The rows a text-model menu draws for the model in use. */
export function textModelRows(current: string, onPick: (id: string) => void): MenuTemplate {
  // Rows carry their own tooltip, so the last slot has to be an explicit id: `createMenu` reads
  // `item[5]` for any row longer than four and would otherwise file the callback under undefined
  return textModelChoices(modelCatalog()?.text, current).map((row) => [
    row.label,
    () => onPick(row.id),
    undefined,
    undefined,
    row.tooltip,
    row.id,
  ]) as MenuTemplate;
}

/** A text-model dropdown in `into`, titled `title`, with its rows read afresh on every open. */
export function textModelMenu(
  into: Container,
  title: string,
  current: () => string,
  onPick: (id: string) => void,
): DropBox {
  const menu = into.menu({ title, template: [], autoSearchMode: true });
  menu.template = (() => textModelRows(current(), onPick)) as unknown as MenuTemplate;
  return menu;
}

/** What the inherit row of an image-model menu says: the project's model, when it is known. */
function inheritLabel(project: string | undefined): string {
  return project ? `inherit (${project})` : 'inherit';
}

/**
 * The rows an image-model menu draws for one target: the catalog the Project pane's picker
 * draws with an inherit row first, the current row ticked, and a model not in the catalog still
 * listed so it is shown rather than silently reset.
 */
export function imageModelRows(
  current: string,
  project: string | undefined,
  onPick: (id: string) => void,
): MenuTemplate {
  // Rows carry their own tooltip, so the last slot has to be an explicit id: `createMenu` reads
  // `item[5]` for any row longer than four and would otherwise file the callback under undefined
  return imageModelChoices(modelCatalog(), current, { inherit: true }).map((row) => {
    const label = row.id === '' ? inheritLabel(project) : row.label;
    return [
      row.id === current ? `✓ ${label}` : label,
      () => onPick(row.id),
      undefined,
      undefined,
      row.tooltip,
      row.id,
    ];
  }) as MenuTemplate;
}

/**
 * An image-model dropdown for a surface built of raw DOM, which has no container to hang a
 * menu on: one path.ux row frame holding the menu, appended where a `<select>` would go. The
 * button names the current model, and a pick runs `onPick` for the row's id (empty for inherit).
 */
export function imageModelMenu(
  ctx: ContextLike,
  current: string,
  project: string | undefined,
  onPick: (id: string) => void,
): { frame: RowFrame; menu: DropBox } {
  const frame = UIBase.constructElement<RowFrame>('rowframe-x', ctx);
  frame.ctx = ctx;
  frame.classList.add('vn-model-menu');
  const title = current === '' ? inheritLabel(project) : current;
  const menu = frame.menu({ title, template: [], autoSearchMode: true });
  menu.template = (() => imageModelRows(current, project, onPick)) as unknown as MenuTemplate;
  frame.flushUpdate();
  return { frame, menu };
}
