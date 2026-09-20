/**
 * The palette control: a row of swatches over a sheet's `palette` key, in place of the JSON box.
 * A swatch opens path.ux's colour picker, its ✕ takes it out, and the slot after the last one adds
 * a swatch. It speaks the field's encoded JSON, so the form's draft, Omit, Apply and Discard
 * treat it as one more text field; a swatch the author did not touch keeps its written string.
 */
import { UIBase, type ColorPickerButton } from 'pathux';
import type { FieldControl, FieldHost } from 'pathux-richtext-schema';
import { swatchAdd, swatchOffer, swatchRemove } from '../../rules/sheetform.js';
import type { SheetHost } from './sheetform.js';

const SWATCH_PX = 22;

/** Said in place of the swatches when the key does not hold a list of strings. */
const NOT_A_LIST = 'Not a list of colours; edit it in the Raw view';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A hex colour as the picker's unit floats; anything else reads as mid grey. */
function floatsOf(text: string): [number, number, number, number] {
  if (!HEX.test(text)) return [0.5, 0.5, 0.5, 1];
  const hex = text.length === 4 ? [...text.slice(1)].map((c) => c + c).join('') : text.slice(1);
  const at = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [at(0), at(2), at(4), 1];
}

/** The picker's unit floats as `#rrggbb`. */
function hexOf(rgba: Iterable<number>): string {
  const channel = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  const [r = 0, g = 0, b = 0] = rgba;
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function parseList(text: string | undefined): string[] | undefined | null {
  if (text === undefined || text === '') return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? (value as string[])
      : null;
  } catch {
    return null;
  }
}

export function paletteControl(field: FieldHost, host: SheetHost): FieldControl {
  const element = document.createElement('div');
  element.className = 'sf-palette';
  const row = document.createElement('div');
  row.className = 'sf-swatches';
  const note = document.createElement('span');
  note.className = 'sf-note';
  element.append(row, note);

  // `null` is text the control cannot draw, kept as it is so Apply writes it back unchanged
  let colors: string[] | undefined | null;
  let shown: string | undefined;
  let readOnly = false;

  const control: FieldControl = {
    element,
    read       : () => shown,
    write: (_key, text) => {
      if (text === shown) return;
      shown = text;
      colors = parseList(text);
      render();
    },
    setReadOnly: (on) => {
      readOnly = on;
      render();
    },
    focus      : () => (row.querySelector<HTMLElement>('[tabindex], button') ?? element).focus(),
    dispose: () => {
      element.remove();
      // An empty pass, so the sweep stops seeing swatches that are no longer drawn
      host.anchors('palette');
    },
  };

  const changed = () => {
    shown = colors === undefined ? undefined : JSON.stringify(colors);
    control.oninput?.(field.name, shown);
  };

  const render = () => {
    row.replaceChildren();
    const anchors = host.anchors('palette');
    const state = { path: host.path(), readOnly, palette: { swatches: colors?.length ?? 0 } };
    note.textContent = colors === null ? NOT_A_LIST : '';
    if (colors === null) return;
    for (const [index, color] of (colors ?? []).entries()) {
      const cell = document.createElement('span');
      cell.className = 'sf-swatch';
      const button = UIBase.constructElement<ColorPickerButton>(
        'color-picker-button-x',
        field.context,
      );
      button.noLabel = true;
      button.overrideDefault('width', SWATCH_PX);
      button.overrideDefault('height', SWATCH_PX);
      button.setCSS();
      button.setRGBA(floatsOf(color));
      button.disabled = readOnly;
      button.setAttribute('aria-label', `Swatch ${index + 1}: ${color}`);
      // The picker is the widget's own click; the offer is recorded so the sweep sees the write
      anchors.record(button, swatchOffer(state, index));
      button.on_change = (rgba) => {
        const next = hexOf(rgba);
        if (colors![index] === next) return;
        colors![index] = next;
        button.setAttribute('aria-label', `Swatch ${index + 1}: ${next}`);
        changed();
      };
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'sf-swatch-remove';
      remove.textContent = '×';
      remove.disabled = readOnly;
      remove.setAttribute('aria-label', `Remove swatch ${index + 1}`);
      anchors.act(remove, swatchRemove(state, index), () => {
        colors!.splice(index, 1);
        changed();
        render();
      });
      cell.append(button, remove);
      row.append(cell);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'sf-swatch-add';
    add.textContent = '+';
    add.disabled = readOnly;
    add.setAttribute('aria-label', 'Add a swatch');
    anchors.act(add, swatchAdd(state), () => {
      (colors ??= []).push('#808080');
      changed();
      render();
    });
    row.append(add);
  };

  render();
  return control;
}
