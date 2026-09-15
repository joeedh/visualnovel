/** What the Project pane offers: its two writes, the box one is typed in, and reload. */
import { shippedImageModels } from '@vn/gengraph';
import { refuse, type Offer } from './anchors.js';
import { view } from './effects.js';

/** What the Project pane reads when it draws its bar. */
export interface ProjectBarState {
  opened: boolean;
  /** Whether the art-style box holds something `project.yaml` does not. */
  dirty: boolean;
  /** The image model `project.yaml` names, which the picker's button shows. */
  imageModel: string;
}

/** One row of the image-model picker: the id it writes, and what its tooltip says. */
export interface ImageModelRow {
  id: string;
  tooltip: string;
}

/**
 * The image-model picker's rows: the shipped Gemini ids, then the current value when it is none
 * of them, so the button always names a row. A `<vendor>/<model>` id draws through OpenRouter,
 * which the row says, since that is a different key and a different privacy posture.
 */
export function imageModelRows(current: string): ImageModelRow[] {
  const ids = shippedImageModels();
  if (current && !ids.includes(current)) ids.push(current);
  return ids.map((id) => ({
    id,
    tooltip: id.includes('/')
      ? `Draw every image task with ${id}, routed by OpenRouter; not zero-data-retention.`
      : `Draw every image task with ${id}, through Gemini.`,
  }));
}

/**
 * The image-model picker's button. Each row runs `project.setImageModel` for its id, which is
 * `confirm: true`, so the author is asked with the count of image tasks it re-keys before the
 * file moves.
 */
export function imageModelAction(opened: boolean, imageModel: string): Offer {
  const control = {
    id      : 'project.setImageModel',
    label   : imageModel || 'model…',
    tooltip:
      'Which image model every image task, and every graph node whose model is empty, draws ' +
      'with. Picking one re-keys every image task; a node that names a model overrides it.',
    supplies: ['model'],
  };
  if (!opened) return { ...refuse('No project is open.'), ...control };
  return { ok: true, props: {}, ...control };
}

/**
 * Write the art style back to `project.yaml`. `project.setArtStyle` is `confirm: true`, so the
 * author is asked — with the count of image tasks it re-keys — before the file moves. The style
 * itself is typed into the box the pane's body is, so the click supplies it.
 */
export function applyStyleAction(opened: boolean, dirty: boolean): Offer {
  const control = {
    id      : 'project.setArtStyle',
    label   : 'Apply',
    tooltip : 'Write these settings back to project.yaml',
    supplies: ['style'],
  };
  if (!opened) return { ...refuse('No project is open.'), ...control };
  if (!dirty) return { ...refuse('No changes'), ...control };
  return { ok: true, props: {}, ...control };
}

export function reloadAction(): Offer {
  return {
    ok: true,
    ...view('reload'),
    on     : 'reload',
    label  : '⟳',
    tooltip: 'Re-read project.yaml (discards an unapplied edit)',
  };
}

/** The art-style box, beside Apply: the same write, with the style as what the box supplies. */
export function styleBox(opened: boolean): Offer {
  const control = {
    id      : 'project.setArtStyle',
    on      : 'style',
    label   : 'Art style',
    tooltip : 'The sentence every image prompt opens with. Applying it re-keys every image task.',
    supplies: ['style'],
  };
  if (!opened) return { ...refuse('No project is open.'), ...control };
  return { ok: true, props: {}, ...control };
}

/** Every offer the Project pane draws from this module: Apply, reload, the box, then the picker. */
export function controls(state: ProjectBarState): readonly Offer[] {
  return [
    applyStyleAction(state.opened, state.dirty),
    reloadAction(),
    styleBox(state.opened),
    imageModelAction(state.opened, state.imageModel),
  ];
}
