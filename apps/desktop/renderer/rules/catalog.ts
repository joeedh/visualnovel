/**
 * The palette's pure half. Decides which catalog entries a query matches, and turns a command's
 * declared props into an editable form and then an invocation. `Palette.tsx` keeps only rendering
 * and IPC, the same impure-shell/pure-core split the graph and timeline surfaces use.
 */
import type { CatalogEntry, CatalogProp, PropValue } from '../../src/shared/ipc';

/**
 * Substring match over `id` and `title`, every whitespace-separated term required. Matching is
 * deliberately not fuzzy, so a mistyped term returns nothing rather than the wrong command.
 */
export function matches(entry: CatalogEntry, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${entry.id} ${entry.title}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterCommands(entries: CatalogEntry[], query: string): CatalogEntry[] {
  return entries.filter((entry) => matches(entry, query));
}

/** Starting value for an untouched field. Uses the declared default, or the kind's blank value. */
export function blankValue(prop: CatalogProp): PropValue {
  if (prop.default !== undefined) return prop.default;
  switch (prop.kind) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'enum':
      return prop.values?.[0] ?? '';
    case 'string[]':
      return [];
    default:
      return '';
  }
}

export function blankProps(entry: CatalogEntry): Record<string, PropValue> {
  return Object.fromEntries(entry.props.map((p) => [p.name, blankValue(p)]));
}

/**
 * One edited field back in its declared kind. `coerceProps` in main stays the validation
 * authority — this only keeps the palette from sending a number prop a string.
 */
export function fieldValue(prop: CatalogProp, raw: string | boolean): PropValue {
  if (prop.kind === 'boolean') return Boolean(raw);
  const text = String(raw);
  if (prop.kind === 'number') return text.trim() === '' ? 0 : Number(text);
  if (prop.kind === 'string[]') {
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return text;
}

/** Renders a value for an input's `value`. A list becomes the comma-separated text it parses from. */
export function fieldText(value: PropValue): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/**
 * Size of a bulk (`digest`) prop, worded for a form to display. The value is a serialized document
 * or mesh that cannot be read in a text field, so the form shows its size instead of its text.
 */
export function bulkSize(value: PropValue): string {
  const chars = fieldText(value).length;
  return chars < 2048 ? `${chars} characters` : `${Math.round(chars / 1024)} KB`;
}
