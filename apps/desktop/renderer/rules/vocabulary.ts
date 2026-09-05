/**
 * Which of a command's string props name something the project already holds, and what each
 * choice is called.
 *
 * A command declares that `scene` is a string, because that is all it can declare: an enum's
 * values are baked into the JSON catalog at module load, and this project's scenes are not part
 * of any command's vocabulary. So the lists are assembled per opening, here, and handed to the
 * form as its `Choices`.
 *
 * A prop only appears here when every value the command accepts is in the list. `into` on
 * `story.splitScene` names a scene that does not exist yet, so it stays a field; `scene` names one
 * that must, so it becomes a dropdown. Wider than the accepted set is allowed — `character` offers
 * the whole cast where `story.setOutfit` takes one of the shot's subjects — because the form draws
 * the command's own refusal for the rest.
 */
import { TEXT_MODELS, effortChoicesFor, effortLabel } from '@vn/types';
import { threadDetail, threadLabel, type ThreadHeader } from '../../src/shared/convo.js';
import { adviseModel } from '../../src/shared/advice.js';
import type { ChoiceRow } from './catalog.js';
import type { CatalogEntry, CatalogProp, PropValue, WorkspaceIndex } from '../../src/shared/ipc';

/** The project as a form needs it: the ids its commands take, and what to call each one. */
export interface ProjectVocabulary {
  scenes: WorkspaceIndex['scenes'];
  characters: WorkspaceIndex['characters'];
  threads: ThreadHeader[];
  /** The model bound in the app, because a `model` prop left empty means that one. */
  boundModel: string;
}

export const NO_VOCABULARY: ProjectVocabulary = {
  scenes    : [],
  characters: [],
  threads   : [],
  boundModel: '',
};

/** The lists this module can build. */
type Kind = 'scene' | 'character' | 'thread' | 'model' | 'effort';

/** Prop names that name the same thing in every command that declares them. */
const BY_NAME: Record<string, Kind> = {
  scene      : 'scene',
  goto       : 'scene',
  character  : 'character',
  characterId: 'character',
  thread     : 'thread',
  model      : 'model',
  effort     : 'effort',
};

/**
 * Where a prop name means something other than it does elsewhere. `id` is a conversation to the
 * three thread commands and a notification to `notify.hide`, so it is never mapped by name.
 */
const BY_COMMAND: Record<string, Record<string, Kind>> = {
  'agent.openThread'  : { id: 'thread' },
  'agent.renameThread': { id: 'thread' },
  'agent.resumeThread': { id: 'thread' },
};

/**
 * Prop names whose value is a stored asset. Not a list like the ones above: the gallery is the
 * picker, and `doc.write`'s `seenHash` is a document's hash rather than an asset's, so the match
 * is by name and not by the word.
 */
const ASSET_PROPS = new Set(['hash', 'ref']);

/** Whether the form should offer the asset gallery beside this prop's field. */
export function picksAnAsset(prop: CatalogProp): boolean {
  return prop.kind === 'string' && !prop.digest && ASSET_PROPS.has(prop.name);
}

/**
 * The option lists for one command, keyed by prop name. A prop missing from the answer keeps its
 * text field; a prop present with no rows draws nothing at all, which is what an effort setting
 * the chosen model does not have has to do.
 */
export function vocabularyFor(
  entry: CatalogEntry,
  project: ProjectVocabulary,
  values: Record<string, PropValue>,
): Record<string, ChoiceRow[]> {
  const lists: Record<string, ChoiceRow[]> = {};
  for (const prop of entry.props) {
    if (prop.kind !== 'string' || prop.multiline || prop.digest) continue;
    const kind = BY_COMMAND[entry.id]?.[prop.name] ?? BY_NAME[prop.name];
    if (!kind) continue;
    const rows = rowsFor(kind, project, values);
    if (!rows) continue;
    lists[prop.name] = rows.length > 0 && allowsEmpty(prop) ? [emptyRow(prop), ...rows] : rows;
  }
  return lists;
}

/**
 * The rows for one kind. `undefined` means the project has nothing to offer, so the field stays
 * typeable rather than becoming a menu with nothing in it.
 */
function rowsFor(
  kind: Kind,
  project: ProjectVocabulary,
  values: Record<string, PropValue>,
): ChoiceRow[] | undefined {
  switch (kind) {
    case 'scene':
      return some(project.scenes.map(sceneRow));
    case 'character':
      return some(project.characters.map(characterRow));
    case 'thread':
      return some(project.threads.map(threadChoice));
    case 'model':
      return modelRows(Boolean(values['source']));
    case 'effort':
      // Empty rather than undefined: a model with no reasoning setting has no choice to make, and
      // the form leaves the row out instead of offering a field to type an unsupported value into.
      return effortRows(String(values['model'] ?? '') || project.boundModel);
  }
}

function some(rows: ChoiceRow[]): ChoiceRow[] | undefined {
  return rows.length > 0 ? rows : undefined;
}

/** Whether leaving the prop blank is a value the command takes, rather than an unfilled field. */
function allowsEmpty(prop: CatalogProp): boolean {
  return !prop.required && prop.default === '';
}

/**
 * The row that sends an empty value. Its tooltip is the prop's own description, which is where the
 * command says what leaving it empty does.
 */
function emptyRow(prop: CatalogProp): ChoiceRow {
  return { value: '', label: 'leave empty', tooltip: prop.hint ?? prop.description };
}

function sceneRow(scene: WorkspaceIndex['scenes'][number]): ChoiceRow {
  const cast = scene.characters.length > 0 ? scene.characters.join(', ') : 'nobody';
  const reach = scene.reachable ? '' : ', which nothing leads to';
  return {
    value  : scene.id,
    label  : scene.id,
    tooltip: `Set in ${scene.location}, with ${cast}${reach}.`,
  };
}

function characterRow(character: WorkspaceIndex['characters'][number]): ChoiceRow {
  return {
    value  : character.id,
    label  : character.name || character.id,
    tooltip: `${character.id} — ${character.status}`,
  };
}

function threadChoice(thread: ThreadHeader): ChoiceRow {
  return { value: thread.id, label: threadLabel(thread), tooltip: threadDetail(thread) };
}

/**
 * Every model, each carrying its advice as the row's own tooltip, so what a choice will cost is
 * readable before it is made rather than only afterwards in the verdict strip. The advice sharpens
 * when the source box is ticked, which is why the flag reaches this far.
 */
export function modelRows(withSource: boolean): ChoiceRow[] {
  return TEXT_MODELS.map((id) => {
    const advice = adviseModel(id, withSource);
    return {
      value  : id,
      label  : id,
      tooltip: advice.text || `Read the conversation with ${id}.`,
    };
  });
}

/** Only what this model takes. Empty means it has no reasoning setting, and no menu is drawn. */
export function effortRows(modelId: string): ChoiceRow[] {
  return effortChoicesFor(modelId).map((choice) => ({
    value  : choice,
    label  : effortLabel(choice),
    tooltip: `Ask ${modelId} to think ${effortLabel(choice)} about what went wrong.`,
  }));
}
