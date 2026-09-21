/** Character and location sheets: edit an existing one, or create a new one. */
import { z } from 'zod';
import {
  applyCharacterEdit,
  applyLocationEdit,
  docToMarkdown,
  newCharacterDoc,
  newCharacterTemplate,
  newLocationDoc,
  type CharacterEdit,
  type LocationEdit,
} from '@vn/model';
import { exists, writeFileAtomic } from '@vn/util';
import { ok, fail, rel, type Tool } from './core.js';

const characterEditShape = z.object({
  id           : z.string().min(1).describe('id of the character to edit'),
  name         : z.string().optional(),
  description: z
    .string()
    .optional()
    .describe('full prose body — the canonical description fed to the pipeline; replaces it whole'),
  defaultOutfit: z
    .string()
    .optional()
    .describe('outfit id worn wherever nothing else says otherwise; must be one of `outfits`'),
  outfits: z
    .record(
      z.union([
        z.string(),
        z.object({ description: z.string().optional(), art_notes: z.string().optional() }),
      ]),
    )
    .optional()
    .describe(
      'the whole wardrobe, outfit id → description (or {description, art_notes} for one that needs its own art direction); replaces the map, so send the ones being kept too',
    ),
  traits       : z.array(z.string()).optional(),
  palette      : z.array(z.string()).optional().describe('hex colors, e.g. #1a2a44'),
  artNotes: z
    .string()
    .optional()
    .describe(
      'art direction appended to every prompt this character reaches — how the art should look, not who the character is; empty string removes it',
    ),
});

const editCharacterTool: Tool<z.infer<typeof characterEditShape>> = {
  name       : 'edit_character',
  description:
    "Apply a validated edit to an existing character.md and write it back. `artNotes` (and an outfit's `art_notes`) is how an author tweaks the look of generated art: it goes into the prompt, so changing it re-renders the portrait and model sheets it reaches on the next run. Say so before proposing one. A character's approval is not a field here: their look is approved by accepting a portrait (`approve_assets`), and never by writing a status.",
  mutating   : true,
  args       : characterEditShape,
  async run(a, ctx) {
    const found = await ctx.workspace.characterDoc(a.id);
    if (!found) return fail(`no such character: ${a.id}`);
    const { id: _id, ...edit } = a;
    const res = applyCharacterEdit(found.doc, edit as CharacterEdit);
    if (!res.ok) return fail(`edit rejected: ${res.diagnostic.message}`);
    await writeFileAtomic(found.file, docToMarkdown(res.value.doc));
    return ok(`Updated character ${a.id}.`, {
      written: [rel(ctx.workspace.root, found.file)],
      data   : res.value.value,
    });
  },
};

const locationEditShape = z.object({
  id         : z.string().min(1).describe('id of the location to edit'),
  name       : z.string().optional(),
  description: z
    .string()
    .optional()
    .describe('full prose body — the canonical description fed to the pipeline; replaces it whole'),
  mood       : z.string().optional(),
  lighting   : z.string().optional(),
  palette    : z.array(z.string()).optional().describe('hex colors, e.g. #1a2a44'),
  variants: z
    .array(
      z.union([
        z.string(),
        z.object({
          id         : z.string().min(1),
          description: z.string().optional(),
          art_notes  : z.string().optional(),
        }),
      ]),
    )
    .optional()
    .describe(
      'the whole variant list, a bare id or {id, description, art_notes} for one that needs its own art direction; replaces the list',
    ),
  artNotes: z
    .string()
    .optional()
    .describe(
      'art direction appended to every plate of this location — how the art should look, not what the place is; empty string removes it',
    ),
});

const editLocationTool: Tool<z.infer<typeof locationEditShape>> = {
  name       : 'edit_location',
  description:
    "Apply a validated edit to an existing location.md and write it back. `artNotes` (and a variant's `art_notes`) is how an author tweaks the look of generated art: it goes into the prompt, so changing it re-renders the plates it reaches on the next run. Say so before proposing one.",
  mutating   : true,
  args       : locationEditShape,
  async run(a, ctx) {
    const found = await ctx.workspace.locationDoc(a.id);
    if (!found) return fail(`no such location: ${a.id}`);
    const { id: _id, ...edit } = a;
    const res = applyLocationEdit(found.doc, edit as LocationEdit);
    if (!res.ok) return fail(`edit rejected: ${res.diagnostic.message}`);
    await writeFileAtomic(found.file, docToMarkdown(res.value.doc));
    return ok(`Updated location ${a.id}.`, {
      written: [rel(ctx.workspace.root, found.file)],
      data   : res.value.value,
    });
  },
};

/**
 * A create tool takes exactly what its `edit_*` sibling takes, minus the `id` it is about to
 * allocate. Back when the create tool could only be told a name, the agent bypassed it and
 * hand-wrote the sheet in raw YAML through `write_file`.
 */
const characterCreateShape = characterEditShape.omit({ id: true }).extend({
  name: z.string().min(1).describe('the display name; the id is slugged from it'),
});
const locationCreateShape = locationEditShape.omit({ id: true }).extend({
  name: z.string().min(1).describe('the display name; the id is slugged from it'),
});

/** Describe what a create tool just made, in the terms the call asked for it. */
const createdHow = (description: string | undefined, fields: string[]): string => {
  const set = fields.length > 0 ? ` with ${fields.join(', ')} set` : '';
  if (description) return `from the description you gave${set}`;
  if (fields.length > 0)
    return (
      `with${set.slice(5)}, and no description — its body is empty, so there is nothing yet ` +
      'for the image model to draw from'
    );
  return (
    'as an empty template — no description was given, so its body is placeholders for someone ' +
    'who knows it to fill in'
  );
};

/** The fields a create call actually carried, in schema order, for both the edit and the report. */
const givenFields = <T extends object>(rest: T): [string, unknown][] =>
  Object.entries(rest).filter(([, v]) => v !== undefined);

const createCharacterTool: Tool<z.infer<typeof characterCreateShape>> = {
  name       : 'create_character',
  description:
    'Scaffold a new characters/<id>/character.md. Takes every field edit_character takes, so a ' +
    'character known in full is written in one call rather than created and then edited. Given ' +
    'nothing but a name it writes a template of placeholders for the author to fill in; the ' +
    'result says which of the two it wrote.',
  mutating   : true,
  args       : characterCreateShape,
  async run(a, ctx) {
    const { name, description, ...rest } = a;
    const given = givenFields(rest);
    const doc = newCharacterDoc(name, description ?? '');
    const id = String(doc.data['id']);
    if (!id) return fail(`"${name}" does not name a character`);
    const file = ctx.workspace.paths.characterFile(id);
    if (await exists(file)) return fail(`character ${id} already exists`);

    // With no fields given, the sheet is the placeholder template, to be filled in by whoever
    // knows the character. With any field given, the fields go through `applyCharacterEdit`, so
    // a created sheet is validated exactly as an edited one would be.
    let text = newCharacterTemplate(name);
    if (description || given.length > 0) {
      const res = applyCharacterEdit(doc, Object.fromEntries(given) as CharacterEdit);
      if (!res.ok) return fail(`rejected: ${res.diagnostic.message}`);
      text = docToMarkdown(res.value.doc);
    }
    await writeFileAtomic(file, text);
    // The observation says which of the three cases happened, not only the file: a uniform
    // "Created" would let a later turn call a fully written sheet a placeholder and rewrite it.
    return ok(
      `Created character ${id} ${createdHow(
        description,
        given.map(([k]) => k),
      )}.`,
      { written: [rel(ctx.workspace.root, file)], data: { id } },
    );
  },
};

const createLocationTool: Tool<z.infer<typeof locationCreateShape>> = {
  name       : 'create_location',
  description:
    'Scaffold a new locations/<id>.md. Takes every field edit_location takes, so a location known ' +
    'in full is written in one call rather than created and then edited. Given nothing but a name ' +
    'it is an empty sheet for the author to fill in; the result says which of the two it wrote.',
  mutating   : true,
  args       : locationCreateShape,
  async run(a, ctx) {
    const { name, description, ...rest } = a;
    const given = givenFields(rest);
    const doc = newLocationDoc(name, description ?? '');
    const id = String(doc.data['id']);
    if (!id) return fail(`"${name}" does not name a location`);
    const file = ctx.workspace.paths.locationFile(id);
    if (await exists(file)) return fail(`location ${id} already exists`);

    const res = applyLocationEdit(doc, Object.fromEntries(given) as LocationEdit);
    if (!res.ok) return fail(`rejected: ${res.diagnostic.message}`);
    await writeFileAtomic(file, docToMarkdown(res.value.doc));
    return ok(
      `Created location ${id} ${createdHow(
        description,
        given.map(([k]) => k),
      )}.`,
      { written: [rel(ctx.workspace.root, file)], data: { id } },
    );
  },
};

export { editCharacterTool, editLocationTool, createCharacterTool, createLocationTool };
