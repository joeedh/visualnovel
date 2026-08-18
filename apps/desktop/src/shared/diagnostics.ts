/**
 * What the header's problem count is counting, arranged for reading.
 *
 * The count itself has been in the header for a long time; what it never had was a way to ask
 * *which* problems. That is all this is: the ordering and the two sentences a list of
 * `Diagnostic`s needs before it can be drawn, kept here so the node-only jest project can test
 * them and the popup stays widgets.
 */
import type { Diagnostic } from '@vn/types';

/**
 * Errors first, then warnings, each keeping the order the model produced them in. Severity is the
 * only thing worth reordering by — a diagnostic's position in the list is the order validation
 * found it, which is roughly the order the files are read, and sorting by message or code would
 * scatter the three complaints about one scene across the list.
 */
export function orderDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [
    ...diagnostics.filter((d) => d.severity === 'error'),
    ...diagnostics.filter((d) => d.severity !== 'error'),
  ];
}

/** `3 errors · 1 warning`, or the one that is not zero, or nothing at all. */
export function diagnosticSummary(diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * What one row hovers as: the code that raised it, and the entity it is about where it named one.
 * The message is already on screen, so repeating it here would waste the one line a tooltip has;
 * the code is what a search of the source takes.
 */
export function diagnosticDetail(diagnostic: Diagnostic): string {
  const where = diagnostic.where ? ` · ${diagnostic.where}` : '';
  return `${diagnostic.severity} ${diagnostic.code}${where}`;
}
