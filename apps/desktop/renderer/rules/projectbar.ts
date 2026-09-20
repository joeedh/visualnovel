/**
 * What the Project pane offers: its seven writes, the box one is typed in, reload, the refresh,
 * the shot-form picker, the bubble-names checkbox, and a checkbox per builtin skill.
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
import { SHOT_FORMS, type ShotForm } from '@vn/types';
import type { BuiltinSkillView } from '../../src/shared/ipc.js';

/** What the Project pane reads when it draws its bar. */
export interface ProjectBarState {
  opened: boolean;
  /** Whether the art-style box holds something `project.yaml` does not. */
  dirty: boolean;
  /** The image model `project.yaml` names, which the picker's button shows. */
  imageModel: string;
  /** The text model and the vision reviewers `project.yaml` names, which their pickers show. */
  textModel: string;
  visionModels: readonly string[];
  /** The day the cached OpenRouter listing was fetched; absent with none. */
  catalogAsOf?: string;
  /** `project.yaml`'s `shot_form`, which the picker's button shows. */
  shotForm: ShotForm;
  /** `project.yaml`'s `bubble_names`, which the checkbox shows. */
  bubbleNames: boolean;
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
 * The text-model picker's button. Each row runs `project.setTextModel` for its id; the pipeline's
 * text calls read the new model on the next run, so nothing is re-keyed and nothing confirms.
 */
export function textModelAction(opened: boolean, textModel: string): Offer {
  const control = {
    id      : 'project.setTextModel',
    label   : textModel || 'model…',
    tooltip:
      'Which text model the pipeline calls for decomposition, picture reviews and refine ' +
      'critiques. The authoring agent picks its own model per conversation.',
    supplies: ['model'],
  };
  if (!opened) return { ...refuse('No project is open.'), ...control };
  return { ok: true, props: {}, ...control };
}

/**
 * The vision-model picker's button. Each row runs `project.setVisionModels` with the whole list
 * the file will hold afterwards — this row's id added or removed — so a row is a toggle.
 */
export function visionModelsAction(opened: boolean, visionModels: readonly string[]): Offer {
  const control = {
    id      : 'project.setVisionModels',
    label   : visionModels.length ? `${visionModels.length} model(s)` : 'models…',
    tooltip:
      'Which models review a generated picture against its prompt, in order. Pick a row to add ' +
      'it or take it off the list; at least one stays.',
    supplies: ['models'],
  };
  if (!opened) return { ...refuse('No project is open.'), ...control };
  return { ok: true, props: {}, ...control };
}

/** The list `project.setVisionModels` gets when `id` is picked: the current list with it toggled. */
export function toggledVisionModels(visionModels: readonly string[], id: string): string[] {
  return visionModels.includes(id) ? visionModels.filter((m) => m !== id) : [...visionModels, id];
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

/** What the shot-form picker's rows say, and what each tells the author it does. */
export const SHOT_FORM_ROWS: readonly { id: ShotForm; label: string; tooltip: string }[] = [
  {
    id     : 'frames',
    label  : 'single frames',
    tooltip: 'Storyboard each new scene as single frames, one picture per shot.',
  },
  {
    id     : 'pages',
    label  : 'manga pages',
    tooltip: 'Storyboard each new scene as manga pages, each shot a page of panels.',
  },
];

/** The picker's label for a form. */
export function shotFormLabel(form: ShotForm): string {
  return SHOT_FORM_ROWS.find((row) => row.id === form)?.label ?? form;
}

/**
 * The shot-form picker's button. Each row runs `project.setShotForm` for its form; a storyboard
 * already written keeps its shape, so nothing is re-keyed and nothing confirms.
 */
export function shotFormAction(opened: boolean, form: ShotForm): Offer {
  const control = {
    id      : 'project.setShotForm',
    label   : shotFormLabel(form),
    tooltip:
      'Whether the decomposer and the agent storyboard a new scene as single frames or as ' +
      'manga pages of panels. The agent follows it unless you ask for the other form for one ' +
      'scene. A storyboard already written keeps its shape.',
    supplies: ['form'],
  };
  if (!opened) return { ...refuse('No project is open.'), ...control };
  if (!SHOT_FORMS.includes(form)) return { ...refuse(`"${form}" is not a shot form.`), ...control };
  return { ok: true, props: {}, ...control };
}

/**
 * The `bubble_names` checkbox: whether a speech bubble the runner draws names its speaker.
 * Ticking it runs `project.setBubbleNames` with the flag flipped.
 */
export function bubbleNamesAction(opened: boolean, on: boolean): Offer {
  const control = {
    id     : 'project.setBubbleNames',
    label  : 'Names in bubbles',
    tooltip: on
      ? 'Leave the speaker’s name out of the bubbles the runner draws; a bubble can still show it for itself in the Page editor.'
      : 'Write the speaker’s name above the line in every bubble the runner draws; narration never carries one, and a bubble can hide it for itself in the Page editor.',
  };
  if (!opened) return { ...refuse('No project is open.'), ...control };
  return { ok: true, props: { on: !on }, ...control };
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
 * Every offer the Project pane draws from this module: Apply, reload, the box, the three model
 * pickers, the refresh, the shot-form picker, the bubble-names checkbox, then a checkbox per
 * builtin skill.
 */
export function controls(state: ProjectBarState): readonly Offer[] {
  return [
    applyStyleAction(state.opened, state.dirty),
    reloadAction(),
    styleBox(state.opened),
    imageModelAction(state.opened, state.imageModel),
    textModelAction(state.opened, state.textModel),
    visionModelsAction(state.opened, state.visionModels),
    refreshModelsAction(state.opened, state.catalogAsOf),
    shotFormAction(state.opened, state.shotForm),
    bubbleNamesAction(state.opened, state.bubbleNames),
    ...state.builtinSkills.map((skill) =>
      builtinSkillAction(state.opened, skill, state.builtinSkills),
    ),
  ];
}
