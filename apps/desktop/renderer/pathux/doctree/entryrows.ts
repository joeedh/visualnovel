/**
 * The rows a wardrobe and a variants control share: one per entry, with its id, its description
 * in the prose face, the art drawn for it, and the entry's own art direction under that. The
 * control owning the rows keeps the list and encodes it; this module only draws it and reports
 * what the author changed.
 */
import type { JsonValue } from 'pathux-richtext-headless';
import {
  defaultMark,
  entryAdd,
  entryArt,
  entryField,
  entryRemove,
  type EntryKind,
  type SheetFormState,
} from '../../rules/sheetform.js';
import { assetCell, type StripCell } from '../assets/assetstrip.js';
import { imageModelMenu } from '../widgets/modelmenu.js';
import type { SheetHost } from './sheetform.js';

/** The long form of an entry; keys the schema does not name ride through untouched. */
export interface EntryObject {
  description: string;
  art_notes?: string;
  seed?: number;
  image_model?: string;
  [key: string]: JsonValue | undefined;
}

export type EntryValue = string | EntryObject;

export interface EntryRow {
  id: string;
  /** The id the row was read from the document under; absent for a row added since. */
  loadedId?: string;
  entry: EntryValue;
  /** A row the default names but no entry describes; typing a description creates the entry. */
  synthesized?: boolean;
}

/** What the rows read from their control and tell it. */
export interface EntryRowsHost {
  kind: EntryKind;
  host: SheetHost;
  readOnly: boolean;
  /** Whether the pipeline plans art for this id, which decides the sentence a row with none says. */
  planned(id: string): boolean;
  art(id: string): readonly StripCell[];
  /** The ids some scene refers to, for the sentence a renamed row says. */
  used(): readonly string[];
  /** The default mark, drawn only by the wardrobe; by row, so a renamed default stays it. */
  mark?: { isDefault(row: EntryRow): boolean; make(row: EntryRow): void };
  /** Said in place of the rows when there are none. */
  empty(): string;
  changed(): void;
  add(): void;
  remove(row: EntryRow): void;
}

const NOUN: Record<EntryKind, string> = { wardrobe: 'outfit', variants: 'variant' };

/** Said in a row's art column when nothing is drawn and nothing is planned. */
const UNPLANNED: Record<EntryKind, string> = {
  wardrobe: 'No scene wears this outfit, so nothing is planned for it',
  variants: 'No plate is planned for this variant',
};

/** Why the rows cannot be applied yet, or `undefined` when every id is usable. */
export function idProblem(
  rows: readonly EntryRow[],
  row: EntryRow,
  kind: EntryKind,
): string | undefined {
  if (row.synthesized) return undefined;
  if (row.id === '') return `Give this ${NOUN[kind]} an id`;
  if (rows.some((other) => other !== row && !other.synthesized && other.id === row.id)) {
    return `Another ${NOUN[kind]} already has this id`;
  }
  return undefined;
}

/** The long form of an entry, made when an art-direction box is first typed into. */
export function longForm(entry: EntryValue): EntryObject {
  return typeof entry === 'string' ? { description: entry } : entry;
}

/** Draws every row into `root`, replacing what was there, on a fresh anchor pass for the control. */
export function renderEntryRows(root: HTMLElement, rows: EntryRow[], on: EntryRowsHost): void {
  root.replaceChildren();
  const { kind, host } = on;
  const anchors = host.anchors(kind);
  const state: SheetFormState = { path: host.path(), readOnly: on.readOnly };
  const visible = host.visible();
  const used = on.used();

  if (rows.length === 0) root.append(el('div', 'sf-entry-empty', on.empty()));
  for (const [index, row] of rows.entries()) {
    const key = row.id === '' ? `#${index}` : row.id;
    const block = el('div', row.synthesized ? 'sf-entry synthesized' : 'sf-entry');
    const head = el('div', 'sf-entry-head');
    const note = el('div', 'sf-entry-note');
    note.textContent = row.synthesized
      ? 'Synthesized: no entry describes it'
      : (idProblem(rows, row, kind) ?? renamedNote(row, used, kind));
    block.append(head, note);

    if (row.synthesized) {
      head.append(el('span', 'sf-entry-id-text', row.id));
    } else {
      const id = document.createElement('input');
      id.type = 'text';
      id.className = 'sf-entry-id';
      id.value = row.id;
      id.placeholder = `${NOUN[kind]} id`;
      id.readOnly = on.readOnly;
      id.setAttribute('aria-label', `${NOUN[kind]} id`);
      anchors.record(id, entryField(state, kind, key, 'id'));
      id.addEventListener('input', () => {
        row.id = id.value.trim();
        on.changed();
        note.textContent = idProblem(rows, row, kind) ?? renamedNote(row, used, kind);
      });
      head.append(id);
    }

    if (on.mark) {
      const isDefault = on.mark.isDefault(row);
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = isDefault ? 'sf-entry-mark is-default' : 'sf-entry-mark';
      mark.textContent = isDefault ? '● default' : '○ make default';
      anchors.act(mark, defaultMark(state, key, isDefault), () => {
        on.mark!.make(row);
        on.changed();
        renderEntryRows(root, rows, on);
      });
      head.append(mark);
    }

    if (!row.synthesized) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'sf-entry-remove';
      remove.textContent = 'Remove';
      anchors.act(remove, entryRemove(state, kind, key), () => on.remove(row));
      head.append(remove);
    }

    const description = document.createElement('textarea');
    description.className = 'sf-entry-desc';
    description.rows = 1;
    description.value = typeof row.entry === 'string' ? row.entry : row.entry.description;
    description.placeholder = row.synthesized
      ? `Describe this ${NOUN[kind]} to create its entry`
      : `What this ${NOUN[kind]} looks like`;
    description.readOnly = on.readOnly;
    description.setAttribute('aria-label', `${NOUN[kind]} description`);
    anchors.record(description, entryField(state, kind, key, 'description'));
    const grow = () => {
      description.style.height = 'auto';
      description.style.height = `${description.scrollHeight}px`;
    };
    description.addEventListener('input', () => {
      grow();
      if (row.synthesized) {
        row.synthesized = false;
        row.entry = description.value;
        on.changed();
        renderEntryRows(root, rows, on);
        focusField(root, index, 'description');
        return;
      }
      if (typeof row.entry === 'string') row.entry = description.value;
      else row.entry = { ...row.entry, description: description.value };
      on.changed();
    });
    block.append(description);
    queueMicrotask(grow);

    const art = el('div', 'sf-entry-art');
    const cells = on.art(row.id);
    if (cells.length === 0) {
      const sentence = on.planned(row.id) ? 'Nothing drawn yet' : UNPLANNED[kind];
      art.append(el('span', 'sf-entry-none', sentence));
    }
    for (const asset of cells) {
      art.append(
        assetCell(asset, {
          onPick: (hash) => host.openAsset(hash),
          anchor: (box, cell, run) => anchors.act(box, entryArt(kind, key, cell, visible), run),
        }),
      );
    }
    block.append(art);

    if (!row.synthesized) block.append(directionRow(row, key, state, kind, anchors, on));
    root.append(block);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'sf-entry-add';
  const offer = entryAdd(state, kind);
  add.textContent = offer.label;
  anchors.act(add, offer, () => on.add());
  root.append(add);
}

/** Focuses one box of one row after a rebuild. */
export function focusField(root: HTMLElement, index: number, field: 'id' | 'description'): void {
  const block = root.querySelectorAll<HTMLElement>('.sf-entry')[index];
  const box = block?.querySelector<HTMLElement>(field === 'id' ? '.sf-entry-id' : '.sf-entry-desc');
  box?.focus();
}

function renamedNote(row: EntryRow, used: readonly string[], kind: EntryKind): string {
  const renamed = row.loadedId !== undefined && row.loadedId !== row.id;
  return renamed && used.includes(row.loadedId!)
    ? `Scenes wear this ${NOUN[kind]} by its old name, ${row.loadedId}`
    : '';
}

/** The entry's own art direction: notes, seed and model, as the Asset editor's rung row draws them. */
function directionRow(
  row: EntryRow,
  key: string,
  state: SheetFormState,
  kind: EntryKind,
  anchors: ReturnType<SheetHost['anchors']>,
  on: EntryRowsHost,
): HTMLElement {
  const line = el('div', 'sf-entry-dir');
  const entry = typeof row.entry === 'string' ? undefined : row.entry;
  const set = (patch: Partial<EntryObject>, drop?: keyof EntryObject) => {
    const next: EntryObject = { ...longForm(row.entry), ...patch };
    if (drop) delete next[drop];
    row.entry = next;
    on.changed();
  };

  const notes = document.createElement('input');
  notes.type = 'text';
  notes.className = 'sf-entry-notes';
  notes.value = entry?.art_notes ?? '';
  notes.placeholder = 'Art notes';
  notes.readOnly = on.readOnly;
  notes.setAttribute('aria-label', `Art notes for ${row.id}`);
  anchors.record(notes, entryField(state, kind, key, 'notes'));
  notes.addEventListener('input', () => {
    if (notes.value === '') set({}, 'art_notes');
    else set({ art_notes: notes.value });
  });

  const seed = document.createElement('input');
  seed.type = 'number';
  seed.min = '0';
  seed.step = '1';
  seed.className = 'as-rung-seed';
  seed.value = entry?.seed === undefined ? '' : String(entry.seed);
  seed.placeholder = 'Seed';
  seed.readOnly = on.readOnly;
  seed.setAttribute('aria-label', `Image seed for ${row.id}`);
  anchors.record(seed, entryField(state, kind, key, 'seed'));
  seed.addEventListener('input', () => {
    const value = Number.parseInt(seed.value, 10);
    if (seed.value === '' || Number.isNaN(value) || value < 0) set({}, 'seed');
    else set({ seed: value });
  });

  const current = entry?.image_model ?? '';
  // An entry's inherit is the sheet's model before the project's, so the row names neither
  const model = imageModelMenu(on.host.ctx(), current, undefined, (id) => {
    if (id === '') set({}, 'image_model');
    else set({ image_model: id });
  });
  model.menu.disabled = on.readOnly;
  anchors.record(model.menu, entryField(state, kind, key, 'model'));

  line.append(notes, seed, model.frame);
  return line;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
