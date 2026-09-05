/**
 * Rows of the outfit strip. Each row names a character that can be dressed, the value its control
 * currently holds, and the value a clear would fall back to.
 *
 * Both levels sit in one list: a scene row per cast member, and a subject row per subject of the
 * selected shot. Only the shot rows shadow a scene marker. The inheritance chain is not re-decided
 * here. `outfitFor` supplies both the value in force and the value a clear would reveal, so the
 * strip and the prompt cannot disagree.
 */
import { outfitFor, type ResolvedOutfit } from '@vn/model';
import type { CoverageCast, SceneCoverage } from '../../../src/shared/ipc';

/** A select's value for setting nothing at this level. Both commands clear with an empty outfit. */
export const INHERIT = '';

/** One control in the strip: a character at one level, with the wardrobe it may be set to. */
export interface OutfitRow {
  level: 'scene' | 'shot';
  scene: string;
  /** The shot the row overrides; only ever set on a `shot` row. */
  shot?: string;
  character: string;
  /** Outfit ids from the character sheet, in order; offered by the select beside {@link INHERIT}. */
  outfits: string[];
  /** This row's own value: an outfit id, or {@link INHERIT} when the row sets nothing. */
  value: string;
  /** What actually reaches the frame, and which level supplied it. */
  effective: ResolvedOutfit;
  /** What would reach the frame if this row were cleared. */
  inherits: ResolvedOutfit;
}

/**
 * The rows for a scene and the shot the timeline has selected. An unselected shot (or one the
 * coverage no longer has) leaves the scene rows alone rather than emptying the strip.
 */
export function outfitRows(data: SceneCoverage | null, selected: string | null): OutfitRow[] {
  if (!data) return [];
  const marks: Record<string, string> = {};
  for (const c of data.cast) if (c.marked) marks[c.id] = c.marked;

  const rows: OutfitRow[] = data.cast.map((c) => ({
    level    : 'scene',
    scene    : data.sceneId,
    character: c.id,
    outfits  : c.outfits,
    value    : c.marked ?? INHERIT,
    // A scene row's value is the marker and its fallback is the character sheet; the shot level
    // sits below the scene level, so a scene marker never inherits from it
    effective: c.marked ? { id: c.marked, origin: 'scene' } : sheet(c),
    inherits : sheet(c),
  }));

  const shot = selected ? data.shots.find((s) => s.id === selected) : undefined;
  if (!shot) return rows;

  const byId = new Map(data.cast.map((c) => [c.id, c]));
  for (const character of shot.subjects) {
    const c = byId.get(character);
    if (!c) continue;
    const override = shot.outfits[character];
    rows.push({
      level: 'shot',
      scene: data.sceneId,
      shot : shot.id,
      character,
      outfits  : c.outfits,
      value    : override ?? INHERIT,
      effective: outfitFor(
        { characterId: character, ...(override ? { outfit: override } : {}) },
        { outfits: marks },
        c,
      ),
      inherits : outfitFor({ characterId: character }, { outfits: marks }, c),
    });
  }
  return rows;
}

/**
 * The scene marker a shot row hides, or null when it hides none. A shot decomposed before outfits
 * were authorable carries an explicit outfit that a marker cannot reach, and clearing the row is
 * the fix; this is all the strip says about such a shot. A baked outfit is not distinguished from
 * a deliberate one, because the file asserts an override either way.
 */
export function shadowedMarker(row: OutfitRow): string | null {
  if (row.level !== 'shot' || row.value === INHERIT) return null;
  return row.inherits.origin === 'scene' ? row.inherits.id : null;
}

/** The command invocation a row runs when its select changes. */
export function outfitInvocation(
  row: OutfitRow,
  outfit: string,
): { id: string; props: Record<string, string> } {
  return row.level === 'scene'
    ? {
        id   : 'story.setSceneOutfit',
        props: { scene: row.scene, character: row.character, outfit },
      }
    : {
        id   : 'story.setOutfit',
        props: { scene: row.scene, shot: row.shot ?? '', character: row.character, outfit },
      };
}

/** How a resolved outfit reads in a control: `"uniform" (character sheet)`. */
export function sourceLabel(resolved: ResolvedOutfit): string {
  const from =
    resolved.origin === 'shot'
      ? 'this shot'
      : resolved.origin === 'scene'
        ? 'scene marker'
        : 'character sheet';
  return `"${resolved.id}" (${from})`;
}

const sheet = (c: CoverageCast): ResolvedOutfit => ({ id: c.defaultOutfit, origin: 'default' });
