/**
 * The front-matter forms the Wiki pane mounts over a character or location sheet: the app's Zod
 * schemas adapted once, with the labels and help sentences path.ux's `FormControl` shows, and
 * the `select` that picks one for a document. Imports only path.ux's DOM-free form modules, so
 * the coverage test runs under node.
 */
import { characterFrontMatter, docKind, locationFrontMatter, type EntityTag } from '@vn/types';
import type { JsonValue } from 'pathux-richtext-headless';
import { formObject, type FormPresentation, type FormSchema } from 'pathux-richtext-schema';
import { zodFormSchema } from 'pathux-richtext-zod';

/** What `nativeFormWidgets` selects: path.ux's `RegisteredForm`, spelled structurally. */
export interface DocForm {
  readonly schema: FormSchema;
  readonly presentation: FormPresentation;
}

type Fields = NonNullable<FormPresentation['fields']>;

/** Help sentences shared by the two sheets, keyed by the field they describe. */
const SHARED: Fields = {
  id: {
    label: 'Id',
    help: 'The identifier every scene and prompt refers to this entity by; renaming the file is how it changes',
  },
  type: {
    label: 'Type',
    help: 'Optional in the conventional directory, which carries the tag implicitly; elsewhere it is what makes the file an entity',
  },
  name       : { label: 'Name', help: 'The display name prompts and the playable use' },
  palette: {
    label: 'Palette',
    help : 'Hex colours, one per line as JSON, that art direction keeps to',
  },
  art_notes: {
    label: 'Art notes',
    help : 'Free-form art direction appended to every prompt this entity reaches',
  },
  seed: {
    label: 'Seed',
    help : 'Image seed for every prompt this entity reaches; a narrower entry can carry its own',
  },
  image_model: {
    label: 'Image model',
    help : 'Image model id used in place of the project default for every picture of this entity',
  },
};

const CHARACTER_FIELDS: Fields = {
  ...SHARED,
  status: {
    label: 'Status',
    help : 'draft, candidates, approved or locked; the approval gate reads it',
  },
  default_outfit: {
    label: 'Default outfit',
    help : 'The outfit id a scene uses when it names none; synthesized when the wardrobe omits it',
  },
  outfits: {
    label: 'Outfits',
    help: 'The wardrobe as JSON: outfit id to description, or to an entry carrying its own art direction',
  },
  traits: {
    label: 'Traits',
    help : 'Personality words the writing agent keeps in character, as JSON',
  },
  prompt_override: {
    label: 'Prompt override',
    help : 'Overrides the derived portrait prompt, as JSON; leave empty to keep the derived prompt',
  },
  approved_portrait: {
    label: 'Approved portrait',
    help : 'The asset hash of the portrait the author approved',
  },
};

const LOCATION_FIELDS: Fields = {
  ...SHARED,
  mood    : { label: 'Mood', help: 'The atmosphere every plate of this location is prompted with' },
  lighting: { label: 'Lighting', help: 'The light every plate of this location is prompted with' },
  variants: {
    label: 'Variants',
    help: 'The variants plates are generated for, as JSON: a bare id, or an entry carrying its own art direction',
  },
};

/**
 * Built once at module load, because `nativeFormBinding` compares the selected form to the one it
 * was built with by identity, and a form built per call would never match.
 */
export const FORMS: Record<EntityTag, DocForm> = {
  character: {
    schema      : zodFormSchema(characterFrontMatter),
    presentation: {
      order: [
        'id',
        'name',
        'type',
        'status',
        'default_outfit',
        'outfits',
        'traits',
        'palette',
        'art_notes',
        'seed',
        'image_model',
        'prompt_override',
        'approved_portrait',
      ],
      fields: CHARACTER_FIELDS,
    },
  },
  location: {
    schema      : zodFormSchema(locationFrontMatter),
    presentation: {
      order: [
        'id',
        'name',
        'type',
        'mood',
        'lighting',
        'variants',
        'palette',
        'art_notes',
        'seed',
        'image_model',
      ],
      fields: LOCATION_FIELDS,
    },
  },
};

/**
 * Which sheet a document is: the entity tag, `undefined` for a note, and a thrown conflict whose
 * message names why the location and the tag disagree.
 */
export function formKind(implied: EntityTag | undefined, values: JsonValue): EntityTag | undefined {
  const kind = docKind(implied, formObject(values) ? values : {});
  if (kind.kind === 'conflict') throw new Error(`This document ${kind.reason}`);
  return kind.kind === 'note' ? undefined : kind.kind;
}

/**
 * The `select` of `nativeFormWidgets` for one document: the sheet's form, `undefined` for a note
 * (path.ux then keeps the raw block), and a thrown conflict, whose message path.ux hands back
 * through `onDiagnostic`.
 */
export function selectForm(implied: EntityTag | undefined, values: JsonValue): DocForm | undefined {
  const kind = formKind(implied, values);
  return kind === undefined ? undefined : FORMS[kind];
}
