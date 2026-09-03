/**
 * Reads the project's own ids over IPC and hands them to a command form as its `Choices`.
 *
 * `rules/vocabulary.ts` holds the rules for which prop takes which list; only the fetching lives
 * here. The snapshot is taken once when a form's surface opens rather than followed, matching the
 * asset picker: the author chooses among what exists at that moment, and both the palette and the
 * dialog are short-lived.
 */
import { api } from '../api.js';
import { exec, shell } from './bridge.js';
import { NO_VOCABULARY, vocabularyFor, type ProjectVocabulary } from '../rules/vocabulary.js';
import type { ThreadHeader } from '../../src/shared/convo.js';
import type { CatalogEntry } from '../../src/shared/ipc.js';
import type { Choices } from './commandform.js';

/**
 * What the project holds, for one opening of a form. A part that cannot be read is left empty
 * rather than reported: the fields it would have filled stay typeable, which is what they were
 * before any of this, so there is nothing for the author to do about it.
 */
export async function readVocabulary(): Promise<ProjectVocabulary> {
  const [index, threads] = await Promise.all([
    api.invoke('workspace:index').catch(() => undefined),
    readThreads(),
  ]);

  return {
    scenes: index?.scenes ?? [],
    characters: index?.characters ?? [],
    threads,
    boundModel: shell().ui.model,
  };
}

async function readThreads(): Promise<ThreadHeader[]> {
  const outcome = await exec('agent.threads');
  if (!outcome.ok) return [];
  return (outcome.data as { threads?: ThreadHeader[] } | undefined)?.threads ?? [];
}

/**
 * The lists one command's form should offer. `host` is what a caller supplies for a field only it
 * knows about, and it wins: a surface that has already decided what a field may hold is not
 * second-guessed by the project-wide answer.
 */
export function projectChoices(
  entry: CatalogEntry,
  project: ProjectVocabulary = NO_VOCABULARY,
  host?: Choices,
): Choices {
  return (values) => ({ ...vocabularyFor(entry, project, values), ...host?.(values) });
}
