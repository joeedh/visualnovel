import type { AssetBinding, Character, Location, ProjectModel } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { artClause, paletteClause, stylePreamble } from './prompts.js';

/** What a concept image depicts, when it depicts something the project knows about. */
export type ConceptSubject = { kind: 'location'; id: string } | { kind: 'character'; id: string };

/** Parse a `location:cafe` / `character:aiko` reference; `undefined` for anything else. */
export function parseSubject(ref: string): ConceptSubject | undefined {
  const [kind, id] = ref.split(':', 2);
  if (!id) return undefined;
  if (kind === 'location') return { kind: 'location', id };
  if (kind === 'character') return { kind: 'character', id };
  return undefined;
}

/** `location:cafe` — the same `kind:key` vocabulary the document tree and `art.setNotes` use. */
export function formatSubject(subject: ConceptSubject): string {
  return `${subject.kind}:${subject.id}`;
}

/**
 * Guess what a sentence is about by matching every location's and character's name or id against
 * it, longest match winning so "the high school gym" beats "the high school".
 *
 * This is a convenience rather than a contract. An author types prose rather than ids, and both
 * surfaces report what was picked and take an explicit override. No match is a legitimate result,
 * because an unbound concept is a legitimate thing to want.
 */
export function matchSubject(model: ProjectModel, sentence: string): ConceptSubject | undefined {
  const haystack = sentence.toLowerCase();
  let best: { subject: ConceptSubject; length: number } | undefined;
  const consider = (subject: ConceptSubject, ...terms: string[]): void => {
    for (const term of terms) {
      const needle = term.trim().toLowerCase();
      // Terms under three characters are skipped, because an id like "hs" matches ordinary prose
      if (needle.length < 3 || !haystack.includes(needle)) continue;
      if (!best || needle.length > best.length) best = { subject, length: needle.length };
    }
  };
  // Locations first so a tie goes to the place — `/makeimage` is asked for a setting far more
  // often than for a person, and a character has a portrait pipeline of its own.
  for (const l of model.locations.values()) consider({ kind: 'location', id: l.id }, l.name, l.id);
  for (const c of model.characters.values())
    consider({ kind: 'character', id: c.id }, c.name, c.id);
  return best?.subject;
}

/** The entity a subject names, or `undefined` when the model has no such id. */
export function subjectEntity(
  model: ProjectModel,
  subject: ConceptSubject,
): Location | Character | undefined {
  return subject.kind === 'location'
    ? model.locations.get(subject.id)
    : model.characters.get(subject.id);
}

/** What a concept asset binds to. An unbound one binds to nothing and is filed under its kind. */
export function subjectBinding(subject?: ConceptSubject): AssetBinding {
  if (!subject) return {};
  return subject.kind === 'location' ? { locationId: subject.id } : { characterId: subject.id };
}

/** What a recorded binding depicts, when it names something. Inverse of `subjectBinding`. */
export function bindingSubject(binding: AssetBinding | undefined): ConceptSubject | undefined {
  if (binding?.locationId) return { kind: 'location', id: binding.locationId };
  if (binding?.characterId) return { kind: 'character', id: binding.characterId };
  return undefined;
}

/**
 * The prompt for one concept image.
 *
 * Built in the same shape as every builder in `prompts.ts`. The style preamble and the closing
 * framing sentence are what make the result look like this project rather than like stock art. The
 * subject's own sheet grounds it, so that a sketch of the café is a sketch of this project's café,
 * and the author's sentence goes last, where the model reads it strongest.
 */
export function conceptPrompt(
  sentence: string,
  subject: ConceptSubject | undefined,
  model: ProjectModel,
  config: ProjectConfig,
): string {
  const entity = subject && subjectEntity(model, subject);
  const location = subject?.kind === 'location' ? (entity as Location | undefined) : undefined;
  return [
    stylePreamble(config),
    entity ? `Subject: ${entity.name}.` : '',
    entity?.description ?? '',
    location?.mood ? `Mood: ${location.mood}.` : '',
    entity ? paletteClause(entity.palette) : '',
    artClause(entity?.artNotes),
    sentence.trim(),
    'Single illustrated concept frame. No text, no UI, no watermarks.',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
