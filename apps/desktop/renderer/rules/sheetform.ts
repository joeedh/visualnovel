/**
 * What a sheet's front-matter form offers beyond its text boxes: the controls that stand in for a
 * box. None runs a command of its own; each edits the form's draft, and the draft ends in the same
 * `doc.write` the text box records, so every control here is that write with an `on` of its own
 * (`docs/plans/pathux-rich-editor-widgets.md`, D8). The one exception is a thumbnail, which is
 * the strip's own cell and opens the picture.
 */
import { refuse, type Offer } from './anchors.js';
import { cellAction, type StripAsset } from './assetstrip.js';
import { publish } from './effects.js';
import { openOf, routeFor } from './route.js';
import type { EditorId } from '../../src/shared/editors.js';

/** The two controls drawn as rows of entries: a character's outfits, a location's variants. */
export type EntryKind = 'wardrobe' | 'variants';

/** What the form's controls read when they draw. */
export interface SheetFormState {
  /** The open sheet's path, which the write every control ends in names. */
  path: string;
  /** Whether the session refuses writes, which greys every control with the reason. */
  readOnly?: boolean;
  /** The palette control's swatch count, when the sheet has one. */
  palette?: { swatches: number };
  /** The wardrobe's rows, when the sheet is a character's. */
  wardrobe?: EntryRows;
  /** The variants' rows, when the sheet is a location's. */
  variants?: EntryRows;
  /** The prompt override's button, when the sheet has one. */
  prompt?: PromptState;
}

/** What the prompt control's button reads; the field is a character sheet's. */
export interface PromptState {
  /** The portrait whose prompt the button opens, when one has been drawn. */
  hash?: string;
  /** Whether the sheet has edits not yet on disk, which the Asset editor's write would overtake. */
  dirty?: boolean;
  /** The editors on screen, which route the button's open. */
  visible?: readonly EditorId[];
}

/** The rows one entry control draws. */
export interface EntryRows {
  /** The entries' ids in written order; an entry not yet named is its index as `#<n>`. */
  ids: string[];
  /** The id the sheet's `default_outfit` names, for a wardrobe. */
  default?: string;
  /** The art drawn for each entry, as the strip's cells. */
  art?: { id: string; asset: StripAsset }[];
  /** The editors on screen, which route a thumbnail's click. */
  visible?: readonly EditorId[];
}

const READ_ONLY = 'This document cannot be written';

/** The noun each control's sentences use, and the same with its article. */
const NOUN: Record<EntryKind, string> = { wardrobe: 'outfit', variants: 'variant' };
const A_NOUN: Record<EntryKind, string> = { wardrobe: 'an outfit', variants: 'a variant' };

/** What the writing-into-the-sheet clause calls each control. */
const WHOLE: Record<EntryKind, string> = { wardrobe: 'the wardrobe', variants: 'the variants' };

/** The `doc.write` a control's edit ends in, greyed while nothing can be written. */
function draftWrite(state: SheetFormState, on: string, label: string, tooltip: string): Offer {
  const control = { id: 'doc.write', on, label, tooltip, supplies: ['text', 'seenHash'] };
  if (state.path === '') return { ...refuse('No document is open.'), ...control };
  if (state.readOnly === true) return { ...refuse(READ_ONLY), ...control };
  return { ok: true, props: { path: state.path }, ...control };
}

/** One swatch: a click opens the colour picker on it. */
export function swatchOffer(state: SheetFormState, index: number): Offer {
  return draftWrite(
    state,
    `palette/${index}`,
    `Swatch ${index + 1}`,
    "Pick this swatch's colour; Apply answers writes the palette into the sheet",
  );
}

/** The ✕ beside a swatch. */
export function swatchRemove(state: SheetFormState, index: number): Offer {
  return draftWrite(
    state,
    `palette/${index}/remove`,
    '×',
    'Take this swatch out of the palette; Apply answers writes the palette into the sheet',
  );
}

/** The empty slot after the last swatch. */
export function swatchAdd(state: SheetFormState): Offer {
  return draftWrite(
    state,
    'palette/add',
    '+',
    'Add a swatch to the palette; Apply answers writes the palette into the sheet',
  );
}

/** The button after the rows: a new entry with an empty id, focused. */
export function entryAdd(state: SheetFormState, kind: EntryKind): Offer {
  return draftWrite(
    state,
    `${kind}/add`,
    `Add ${A_NOUN[kind]}`,
    `Append ${A_NOUN[kind]} with an empty id and focus it; Apply answers writes ${WHOLE[kind]} into the sheet`,
  );
}

/** The boxes of one row, by what each edits. */
export type EntryField = 'id' | 'description' | 'notes' | 'seed' | 'model';

const FIELD_LABEL: Record<EntryField, string> = {
  id         : 'Id',
  description: 'Description',
  notes      : 'Art notes',
  seed       : 'Seed',
  model      : 'Image model',
};

function fieldTip(kind: EntryKind, field: EntryField): string {
  const noun = NOUN[kind];
  switch (field) {
    case 'id':
      return `The name scenes and prompts refer to this ${noun} by; changing it renames the entry in place`;
    case 'description':
      return `What this ${noun} looks like, in the words every prompt for it starts from`;
    case 'notes':
      return `Art direction appended to every prompt for this ${noun}, after the sheet's own`;
    case 'seed':
      return `Image seed for every picture of this ${noun}; empty inherits the sheet's`;
    case 'model':
      return `Image model for every picture of this ${noun}; inherit draws with the sheet's`;
  }
}

/** One box of a row: the write its text ends in. */
export function entryField(
  state: SheetFormState,
  kind: EntryKind,
  id: string,
  field: EntryField,
): Offer {
  return draftWrite(
    state,
    `${kind}/${id}/${field}`,
    FIELD_LABEL[field],
    `${fieldTip(kind, field)}; Apply answers writes ${WHOLE[kind]} into the sheet`,
  );
}

/** The quiet word at the end of a row's heading. */
export function entryRemove(state: SheetFormState, kind: EntryKind, id: string): Offer {
  return draftWrite(
    state,
    `${kind}/${id}/remove`,
    'Remove',
    `Take this ${NOUN[kind]} out of ${WHOLE[kind]}; Apply answers writes ${WHOLE[kind]} into the sheet`,
  );
}

/**
 * The mark beside an outfit's id: the default one is marked and cannot be pressed, since it is
 * already what a scene draws when it names none; any other row's mark makes it the default.
 */
export function defaultMark(state: SheetFormState, id: string, isDefault: boolean): Offer {
  const on = `wardrobe/${id}/default`;
  if (isDefault) {
    return {
      ...refuse('This is already the outfit a scene wears when it names none'),
      id: 'doc.write',
      on,
      label   : 'default',
      tooltip : 'The outfit a scene wears when it names none',
      supplies: ['text', 'seenHash'],
    };
  }
  return draftWrite(
    state,
    on,
    'make default',
    'Make this the outfit a scene wears when it names none; Apply answers writes the sheet',
  );
}

/** A thumbnail beside its entry: the strip's own cell, keyed apart from the strip's. */
export function entryArt(
  kind: EntryKind,
  id: string,
  asset: StripAsset,
  visible: readonly EditorId[],
): Offer {
  return { ...cellAction(asset, visible), on: `${kind}/${id}/asset/${asset.hash}` };
}

/** Said under the prompt sentence while the sheet has edits the Asset editor's write would overtake. */
export const SAVE_FIRST = 'Save the sheet first; the Asset editor writes the prompt into it';

/**
 * The button under the prompt sentence: selects the picture the sheet's prompt draws and opens
 * it where the route says, as a thumbnail's click does, since the clauses are edited there.
 */
export function promptEdit(state: SheetFormState, prompt: PromptState): Offer {
  const control = {
    on     : 'prompt/edit',
    label  : 'Edit the prompt in the Asset editor',
    tooltip:
      "Open the picture this sheet's prompt draws, where its clauses are edited and written back into the sheet",
  };
  // A refusal is about the open; the click itself is the strip's publish-then-open
  const refused = (why: string): Offer => ({ ...refuse(why), id: 'view.open', ...control });
  if (state.path === '') return refused('No document is open.');
  if (prompt.hash === undefined) {
    return refused('Nothing has been drawn for this character yet, so there is no prompt to edit');
  }
  if (prompt.dirty === true) return refused(SAVE_FIRST);
  const node = { id: `asset:${prompt.hash}`, kind: 'asset' as const, label: prompt.hash };
  const open = openOf(routeFor({ node, visible: prompt.visible ?? [] }));
  return {
    ok: true,
    ...publish({ assetHash: prompt.hash }),
    ...control,
    ...(open ? { then: [open] } : {}),
  };
}

function entryControls(state: SheetFormState, kind: EntryKind, rows: EntryRows): Offer[] {
  const out: Offer[] = [];
  for (const id of rows.ids) {
    out.push(entryField(state, kind, id, 'id'));
    if (kind === 'wardrobe') out.push(defaultMark(state, id, id === rows.default));
    for (const field of ['description', 'notes', 'seed', 'model'] as const) {
      out.push(entryField(state, kind, id, field));
    }
    for (const { id: of, asset } of rows.art ?? []) {
      if (of === id) out.push(entryArt(kind, id, asset, rows.visible ?? []));
    }
    out.push(entryRemove(state, kind, id));
  }
  out.push(entryAdd(state, kind));
  return out;
}

/** Every offer the form's controls draw for a sheet. */
export function controls(state: SheetFormState): readonly Offer[] {
  const out: Offer[] = [];
  if (state.palette) {
    for (let index = 0; index < state.palette.swatches; index++) {
      out.push(swatchOffer(state, index), swatchRemove(state, index));
    }
    out.push(swatchAdd(state));
  }
  if (state.wardrobe) out.push(...entryControls(state, 'wardrobe', state.wardrobe));
  if (state.variants) out.push(...entryControls(state, 'variants', state.variants));
  if (state.prompt) out.push(promptEdit(state, state.prompt));
  return out;
}
