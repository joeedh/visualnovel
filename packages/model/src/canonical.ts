/**
 * The comparison projection the prose writers use. `branchpatch.ts`, `lineids.ts` and the
 * screenplay importer all work the same way: write, re-parse, and refuse unless the scenes come
 * back identical. They share this projection so that all three agree on what "identical" means.
 */
import type { Scene } from '@vn/types';

/**
 * A scene list as a canonical string: every field the model carries except `shots`, which is not
 * serialized. Line ids and the allocator are included deliberately — a writer that moved one has
 * re-pointed a shot's coverage, which is the damage these checks exist to catch.
 */
export function canonicalScenes(scenes: Scene[]): string {
  return JSON.stringify(
    scenes.map((s) => ({
      id             : s.id,
      location       : s.location,
      locationVariant: s.locationVariant ?? null,
      headingPrefix  : s.headingPrefix ?? null,
      synopsis       : s.synopsis ?? null,
      characters     : s.characters,
      nextLineId     : s.nextLineId ?? null,
      lines: s.lines.map((l) => ({
        id     : l.id,
        kind   : l.kind,
        speaker: l.speaker ?? null,
        text   : l.text,
      })),
      choices        : s.choices.map((c) => ({ label: c.label, goto: c.goto })),
      next           : s.next ?? null,
      // Normalized so "no markers" and "every marker removed" compare equal — a patch that
      // clears the last one has to be able to reproduce the scene it intended.
      outfits        : s.outfits && Object.keys(s.outfits).length > 0 ? s.outfits : null,
    })),
  );
}
