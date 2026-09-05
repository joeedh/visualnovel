/**
 * Which files the tool may be pointed at. The list is deliberately short: this rewrites prose
 * with a model, and a file that is hand-shaped or generated must not be offered to it.
 */

/** Always refused, whatever else matches. */
const REFUSED = [
  // Hand-written shorthand deliberately outside prettier's idea of Markdown, which
  // `docs/reference/conventions.md` says must keep its wording, ordering and whitespace.
  'todos.md',
  // Generated from the command registry by `pnpm gen:command-table`.
  'docs/reference/command-table.md',
  'docs/reference/command-namespaces.md',
];

/** Normalises a path for matching, so a Windows caller and a POSIX one agree. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

export interface Refusal {
  allowed: false;
  why: string;
}

export type Allowance = { allowed: true } | Refusal;

/**
 * Whether the tool may rewrite this path, given relative to the repository root. Archived plans
 * are excluded because they are history, and a shipped plan reads as the record of what was
 * decided rather than as prose to improve.
 */
export function allowsRewrite(relative: string): Allowance {
  const path = normalizePath(relative);

  if (REFUSED.includes(path)) return { allowed: false, why: `${path} is on the refused list` };
  if (path.startsWith('docs/plans/archive/')) {
    return { allowed: false, why: 'archived plans are history and are not rewritten' };
  }
  if (path === 'CLAUDE.md') return { allowed: true };
  if (path.startsWith('docs/') && path.endsWith('.md')) return { allowed: true };

  return { allowed: false, why: `only CLAUDE.md and docs/**.md are offered; got ${path}` };
}
