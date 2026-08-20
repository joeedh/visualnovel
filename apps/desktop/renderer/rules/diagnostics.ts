/**
 * The rail's one non-display decision: which diagnostics can be clicked through to a scene.
 *
 * A diagnostic's `where` is an entity id rather than a scene id (a character sheet that failed to
 * parse carries one too) and a scene diagnostic can name a scene that does not exist, as a `start:`
 * pointing at nothing does. The rail therefore checks whether the id is a scene the workspace
 * lists, and only those rows become clickable.
 *
 * Named for the diagnostics rather than for the rail because `Rail.tsx` shares this directory and
 * a `rail.ts` beside it resolves to the same module on a case-insensitive filesystem.
 */
import type { Diagnostic } from '@vn/types';

export function diagnosticScene(d: Diagnostic, scenes: Iterable<string>): string | null {
  if (!d.where) return null;
  for (const id of scenes) if (id === d.where) return d.where;
  return null;
}
