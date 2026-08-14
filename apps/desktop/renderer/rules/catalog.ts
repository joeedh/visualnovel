/**
 * The palette's pure half: which catalog entries a query matches, and how a command's declared
 * props become an editable form and then an invocation. `Palette.tsx` keeps only rendering and
 * IPC — the same impure-shell/pure-core split the graph and timeline surfaces use.
 */
import type { CatalogEntry, CatalogProp, PropValue } from '../../src/shared/ipc';

/**
 * Substring match over `id` and `title`, every whitespace-separated term required. Not fuzzy:
 * a palette that answers `stroy` is also a palette that answers with the wrong command.
 */
export function matches(entry: CatalogEntry, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${entry.id} ${entry.title}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterCommands(entries: CatalogEntry[], query: string): CatalogEntry[] {
  return entries.filter((entry) => matches(entry, query));
}

/** What an untouched field starts at: the declared default, else the kind's blank. */
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

/** The inverse, for the input's `value`: a list edits as the comma-separated text it parses from. */
export function fieldText(value: PropValue): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}
