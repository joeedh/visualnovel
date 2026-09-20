/**
 * What a sheet's front-matter form offers beyond its text boxes: the controls that stand in for a
 * box. None runs a command of its own; each edits the form's draft, and the draft ends in the same
 * `doc.write` the text box records, so every control here is that write with an `on` of its own
 * (`docs/plans/pathux-rich-editor-widgets.md`, D8).
 */
import { refuse, type Offer } from './anchors.js';

/** What the form's controls read when they draw. */
export interface SheetFormState {
  /** The open sheet's path, which the write every control ends in names. */
  path: string;
  /** Whether the session refuses writes, which greys every control with the reason. */
  readOnly?: boolean;
  /** The palette control's swatch count, when the sheet has one. */
  palette?: { swatches: number };
}

const READ_ONLY = 'This document cannot be written';

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

/** Every offer the form's controls draw for a sheet: each swatch, its ✕, and the slot after them. */
export function controls(state: SheetFormState): readonly Offer[] {
  const out: Offer[] = [];
  if (state.palette) {
    for (let index = 0; index < state.palette.swatches; index++) {
      out.push(swatchOffer(state, index), swatchRemove(state, index));
    }
    out.push(swatchAdd(state));
  }
  return out;
}
