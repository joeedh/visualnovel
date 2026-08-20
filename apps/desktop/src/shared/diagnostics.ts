/**
 * Ordering and labelling for the diagnostics behind the header's problem count.
 *
 * The logic lives here rather than in the popup so the node-only jest project can test it and the
 * popup stays widgets.
 */
import type { Diagnostic } from '@vn/types';

/**
 * Errors first, then warnings, each keeping the order the model produced them in. Nothing else is
 * sorted on: a diagnostic's position is the order validation found it, roughly the order the files
 * are read, and sorting by message or code would scatter several complaints about one scene across
 * the list.
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
 * Tooltip for one diagnostic row: the code that raised it, plus the entity it names where it names
 * one. The message is already on screen, and the code is what a search of the source takes.
 */
export function diagnosticDetail(diagnostic: Diagnostic): string {
  const where = diagnostic.where ? ` · ${diagnostic.where}` : '';
  return `${diagnostic.severity} ${diagnostic.code}${where}`;
}
