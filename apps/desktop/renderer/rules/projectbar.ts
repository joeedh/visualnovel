/**
 * What the Project pane offers: its three writes, the box one is typed in, reload, the refresh,
 * and a checkbox per builtin skill.
 */
import {
  imageModelChoices,
  modelCatalog,
  type ImageModelChoice,
  type ModelCatalog,
} from '@vn/gengraph';
import { refuse, type Offer } from './anchors.js';
import { view } from './effects.js';
import { refreshModelsAction } from './models.js';
import type { BuiltinSkillView } from '../../src/shared/ipc.js';

/** What the Project pane reads when it draws its bar. */
export interface ProjectBarState {
  opened: boolean;
  /** Whether the art-style box holds something `project.yaml` does not. */
  dirty: boolean;
  /** The image model `project.yaml` names, which the picker's button shows. */
  imageModel: string;
  /** The day the cached OpenRouter listing was fetched; absent with none. */
  catalogAsOf?: string;
  /** The builtin catalog with each skill's switch, as `project.yaml` has it. */
  builtinSkills: readonly BuiltinSkillView[];
}

/**
 * The image-model picker's rows: the shipped Gemini ids, the cached OpenRouter ids, then the
 * current value when it is none of them, so the button always names a row. Each row's tooltip
 * says which vendor draws it, since an OpenRouter row is a different key and a different privacy
 * posture. The catalog defaults to the snapshot the shell last set.
 */
export function imageModelRows(
  current: string,
  catalog: ModelCatalog | undefined = modelCatalog(),
): ImageModelChoice[] {
  return imageModelChoices(catalog, current);
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
      'with. Pictures already drawn stay; the next render uses it. A rung or a node that names ' +
      'a model overrides it.',
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

/**
 * One builtin skill's checkbox. Ticking it runs `project.setBuiltinSkills` with the whole list
 * the file will hold afterwards — the command takes the list rather than one toggle, so the
 * props here are that list with this skill added or removed.
 */
export function builtinSkillAction(
  opened: boolean,
  skill: BuiltinSkillView,
  enabled: readonly BuiltinSkillView[],
): Offer {
  const control = {
    id     : 'project.setBuiltinSkills',
    on     : skill.id,
    label  : skill.name,
    tooltip: skill.enabled
      ? `Turn ${skill.id} off — the agent stops seeing it. ${skill.description}`
      : `Turn ${skill.id} on — the agent can then follow it. ${skill.description}`,
  };
  if (!opened) return { ...refuse('No project is open.'), ...control };
  // Catalog order, so the file's list reads the same way the pane does whichever box was ticked
  const ids = enabled
    .filter((s) => (s.id === skill.id ? !skill.enabled : s.enabled))
    .map((s) => s.id);
  return { ok: true, props: { ids }, ...control };
}

/**
 * Every offer the Project pane draws from this module: Apply, reload, the box, the picker, the
 * refresh, then a checkbox per builtin skill.
 */
export function controls(state: ProjectBarState): readonly Offer[] {
  return [
    applyStyleAction(state.opened, state.dirty),
    reloadAction(),
    styleBox(state.opened),
    imageModelAction(state.opened, state.imageModel),
    refreshModelsAction(state.opened, state.catalogAsOf),
    ...state.builtinSkills.map((skill) =>
      builtinSkillAction(state.opened, skill, state.builtinSkills),
    ),
  ];
}
