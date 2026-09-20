/**
 * The wardrobe: a character's `outfits` as rows, with `default_outfit` as the mark on one of
 * them. It speaks the field's encoded JSON for `outfits` and the plain id for `default_outfit`,
 * which it also edits (`also`), so the form's draft, Apply and Discard treat both as fields.
 */
import type { FieldControl, FieldHost } from 'pathux-richtext-schema';
import {
  focusField,
  idProblem,
  renderEntryRows,
  type EntryRow,
  type EntryValue,
} from './entryrows.js';
import type { SheetHost } from './sheetform.js';

const OUTFITS = 'outfits';
const DEFAULT = 'default_outfit';

/** The outfit the pipeline synthesizes when a sheet names none. */
const SYNTHESIZED_DEFAULT = 'default';

function parseMap(text: string | undefined): Record<string, EntryValue> | undefined | null {
  if (text === undefined || text === '') return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const entries = Object.entries(value as Record<string, unknown>);
    const ok = entries.every(
      ([, v]) =>
        typeof v === 'string' || (v !== null && typeof v === 'object' && !Array.isArray(v)),
    );
    return ok ? (value as Record<string, EntryValue>) : null;
  } catch {
    return null;
  }
}

export function wardrobeControl(field: FieldHost, host: SheetHost): FieldControl {
  const element = document.createElement('div');
  element.className = 'sf-entries';
  const note = document.createElement('span');
  note.className = 'sf-note';
  const rowsEl = document.createElement('div');
  rowsEl.className = 'sf-entry-list';
  element.append(note, rowsEl);

  let rows: EntryRow[] = [];
  /** What `default_outfit` names: the row itself while one has that id, else the bare id. */
  let defaultRow: EntryRow | undefined;
  let defaultId: string | undefined;
  // The last text read or written per key; `null` for the map is text the control cannot draw
  let shownOutfits: string | undefined;
  let shownDefault: string | undefined;
  let undrawable = false;
  let readOnly = false;

  const control: FieldControl = {
    element,
    also       : [DEFAULT],
    read       : (key) => (key === DEFAULT ? shownDefault : shownOutfits),
    write: (key, text) => {
      if (key === DEFAULT) {
        const next = text === '' ? undefined : text;
        if (next === shownDefault) return;
        shownDefault = next;
        defaultId = next;
        rebuild();
        return;
      }
      if (text === shownOutfits) return;
      shownOutfits = text;
      const map = parseMap(text);
      undrawable = map === null;
      rows = Object.entries(map ?? {}).map(([id, entry]) => ({ id, loadedId: id, entry }));
      rebuild();
    },
    setReadOnly: (on) => {
      readOnly = on;
      render();
    },
    focus      : () => focusField(rowsEl, 0, 'id'),
    dispose: () => {
      element.remove();
      offLinks();
      host.anchors('wardrobe');
    },
  };

  /** Re-derive the default row from the id, add the synthesized row when none matches, draw. */
  const rebuild = () => {
    rows = rows.filter((row) => !row.synthesized);
    defaultRow = rows.find((row) => row.id === defaultId);
    if (defaultId !== undefined && !defaultRow) {
      defaultRow = { id: defaultId, entry: '', synthesized: true };
      rows.unshift(defaultRow);
    }
    render();
  };

  /** Encode what the rows hold, unless an id is missing or repeated, which keeps the last text. */
  const changed = () => {
    if (rows.some((row) => idProblem(rows, row, 'wardrobe') !== undefined)) return;
    const real = rows.filter((row) => !row.synthesized);
    const map: Record<string, EntryValue> = {};
    for (const row of real) map[row.id] = row.entry;
    const outfits = real.length ? JSON.stringify(map) : undefined;
    const nextDefault = defaultRow ? defaultRow.id : defaultId;
    if (outfits !== shownOutfits) {
      shownOutfits = outfits;
      control.oninput?.(OUTFITS, outfits);
    }
    if (nextDefault !== shownDefault) {
      shownDefault = nextDefault;
      defaultId = nextDefault;
      control.oninput?.(DEFAULT, nextDefault);
    }
  };

  const links = () => host.links();
  const used = () => links()?.usedOutfits ?? [];

  const render = () => {
    note.textContent = undrawable ? 'Not a wardrobe; edit it in the Raw view' : '';
    if (undrawable) {
      rowsEl.replaceChildren();
      host.anchors('wardrobe');
      return;
    }
    renderEntryRows(rowsEl, rows, {
      kind: 'wardrobe',
      host,
      readOnly,
      planned: (id) => used().includes(id),
      art: (id) => {
        const assets = links()?.assets ?? [];
        return assets.filter((asset) => {
          const slot = asset.slot;
          if (slot === undefined) return false;
          if (slot.startsWith('sheet:')) return slot.split('/')[1] === id;
          return slot.startsWith('portrait:') && defaultRow?.id === id;
        });
      },
      used,
      mark: {
        isDefault: (row) => row === defaultRow,
        make: (row) => {
          defaultRow = row;
          defaultId = row.id;
        },
      },
      empty: () =>
        `No outfits yet. The pipeline draws ${defaultId ?? SYNTHESIZED_DEFAULT} until one is added.`,
      changed,
      add: () => {
        rows.push({ id: '', entry: '' });
        render();
        focusField(rowsEl, rows.length - 1, 'id');
      },
      // The default keeps naming a removed outfit, so its row comes back as synthesized and says so
      remove: (row) => {
        rows = rows.filter((r) => r !== row);
        if (defaultRow === row) defaultRow = undefined;
        changed();
        rebuild();
      },
    });
  };

  // Art arrives with the tree, which the pane fetches on its own signal
  const offLinks = host.onLinks(() => render());
  render();
  return control;
}
