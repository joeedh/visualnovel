/**
 * The variants: a location's `variants` as rows. It speaks the field's encoded JSON, so the
 * form's draft, Apply and Discard treat it as one more field. A variant that only has an id is
 * written as the bare string the schema allows; one with a description or art direction of its
 * own is written as an entry with `id` first.
 */
import type { FieldControl, FieldHost } from 'pathux-richtext-schema';
import {
  focusField,
  idProblem,
  renderEntryRows,
  type EntryObject,
  type EntryRow,
} from './entryrows.js';
import type { SheetHost } from './sheetform.js';

/** The variant the schema supplies when a sheet names none. */
const SCHEMA_DEFAULT = 'day';

/** The rows a list encodes to, or `null` for text the control cannot draw. */
function parseList(text: string | undefined): EntryRow[] | undefined | null {
  if (text === undefined || text === '') return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return null;
    const rows: EntryRow[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        rows.push({ id: item, loadedId: item, entry: { description: '' } });
        continue;
      }
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
      const { id, ...rest } = item as Record<string, unknown>;
      if (typeof id !== 'string') return null;
      const entry = { description: '', ...rest } as EntryObject;
      if (typeof entry.description !== 'string') return null;
      rows.push({ id, loadedId: id, entry });
    }
    return rows;
  } catch {
    return null;
  }
}

/** A row as the list holds it: the bare id while nothing else is written for it. */
function itemOf(row: EntryRow): string | EntryObject {
  const entry = typeof row.entry === 'string' ? { description: row.entry } : row.entry;
  const bare = Object.entries(entry).every(([key, value]) =>
    key === 'description' ? value === '' : value === undefined,
  );
  return bare ? row.id : { id: row.id, ...entry };
}

export function variantsControl(field: FieldHost, host: SheetHost): FieldControl {
  const element = document.createElement('div');
  element.className = 'sf-entries';
  const note = document.createElement('span');
  note.className = 'sf-note';
  const rowsEl = document.createElement('div');
  rowsEl.className = 'sf-entry-list';
  element.append(note, rowsEl);

  let rows: EntryRow[] = [];
  // The last text read or written; `null` is text the control cannot draw
  let shown: string | undefined;
  let undrawable = false;
  let readOnly = false;

  const control: FieldControl = {
    element,
    read       : () => shown,
    write: (_key, text) => {
      if (text === shown) return;
      shown = text;
      const parsed = parseList(text);
      undrawable = parsed === null;
      rows = parsed ?? [];
      render();
    },
    setReadOnly: (on) => {
      readOnly = on;
      render();
    },
    focus      : () => focusField(rowsEl, 0, 'id'),
    dispose: () => {
      element.remove();
      offLinks();
      host.anchors('variants');
    },
  };

  /** Encode what the rows hold, unless an id is missing or repeated, which keeps the last text. */
  const changed = () => {
    if (rows.some((row) => idProblem(rows, row, 'variants') !== undefined)) return;
    const next = rows.length ? JSON.stringify(rows.map(itemOf)) : undefined;
    if (next === shown) return;
    shown = next;
    control.oninput?.(field.name, next);
  };

  const links = () => host.links();
  const used = () => links()?.usedVariants ?? [];

  const render = () => {
    note.textContent = undrawable ? 'Not a list of variants; edit it in the Raw view' : '';
    if (undrawable) {
      rowsEl.replaceChildren();
      host.anchors('variants');
      return;
    }
    renderEntryRows(rowsEl, rows, {
      kind: 'variants',
      host,
      readOnly,
      planned: (id) => used().includes(id),
      art: (id) =>
        (links()?.assets ?? []).filter(
          (asset) => asset.slot?.startsWith('plate:') === true && asset.slot.split('/')[1] === id,
        ),
      used,
      empty: () => `No variants yet. Plates are drawn for ${SCHEMA_DEFAULT} until one is added.`,
      changed,
      add: () => {
        rows.push({ id: '', entry: { description: '' } });
        render();
        focusField(rowsEl, rows.length - 1, 'id');
      },
      remove: (row) => {
        rows = rows.filter((r) => r !== row);
        changed();
        render();
      },
    });
  };

  // Art arrives with the tree, which the pane fetches on its own signal
  const offLinks = host.onLinks(() => render());
  render();
  return control;
}
