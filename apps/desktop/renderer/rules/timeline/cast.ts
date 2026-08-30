/**
 * What the strip's "in this shot" controls hold: who the selected shot frames, who it could be
 * given, whether the picture has to show them, and the variant it is drawn against.
 *
 * The shape is here rather than in the editor so the same three invocations can be tested without
 * a DOM. Nothing is decided twice: each control asks for the command that owns its rule, and the
 * refusals come back from `check` the way every other control's do.
 */
import type { SceneCoverage } from '../../../src/shared/ipc';

/** The selected shot's cast, as its controls need it. */
export interface ShotCast {
  scene: string;
  shot: string;
  /** Character ids the shot frames, in the order it frames them. */
  framed: string[];
  /** Characters the project describes that this shot does not frame, in model order. */
  spare: string[];
  /** Whether the frame has to show {@link framed} — the inverse of `Shot.castOptional`. */
  required: boolean;
  /** The location variant the shot is drawn against. */
  variant: string;
  /** The variant ids the scene's location offers, in authored order. */
  variants: string[];
}

/**
 * The selected shot's cast, or null when nothing is selected or the coverage no longer holds the
 * selection. Null is what leaves the controls off the strip entirely, which is right: there is no
 * shot for them to be about.
 */
export function shotCast(data: SceneCoverage | null, selected: string | null): ShotCast | null {
  if (!data || !selected) return null;
  const shot = data.shots.find((s) => s.id === selected);
  if (!shot) return null;
  return {
    scene: data.sceneId,
    shot: shot.id,
    framed: [...shot.subjects],
    spare: data.characters.filter((id) => !shot.subjects.includes(id)),
    required: shot.castOptional !== true,
    variant: shot.location,
    variants: [...data.variants],
  };
}

/** The cast list with `character` appended — the shot frames whoever it framed, plus them. */
export function withCharacter(cast: ShotCast, character: string): string[] {
  return cast.framed.includes(character) ? cast.framed : [...cast.framed, character];
}

/** The cast list without `character`. */
export function withoutCharacter(cast: ShotCast, character: string): string[] {
  return cast.framed.filter((id) => id !== character);
}

/** The invocation that writes a cast list. */
export function subjectsInvocation(
  cast: ShotCast,
  subjects: readonly string[],
): { id: string; props: Record<string, string> } {
  return {
    id: 'story.setSubjects',
    props: { scene: cast.scene, shot: cast.shot, subjects: subjects.join(',') },
  };
}

/** The invocation that turns the reviewer's demand on or off. */
export function requireCastInvocation(
  cast: ShotCast,
  required: boolean,
): { id: string; props: Record<string, string | boolean> } {
  return {
    id: 'story.requireCast',
    props: { scene: cast.scene, shot: cast.shot, required },
  };
}

/** The invocation that moves the shot to another variant of its scene's location. */
export function variantInvocation(
  cast: ShotCast,
  variant: string,
): { id: string; props: Record<string, string> } {
  return {
    id: 'story.setVariant',
    props: { scene: cast.scene, shot: cast.shot, variant },
  };
}

/**
 * What the "must appear" checkbox says it would do. Both halves name the consequence rather than
 * the setting, since the setting is the checkbox itself.
 */
export function requireCastTitle(cast: ShotCast): string {
  if (cast.framed.length === 0) {
    return 'Nobody is in this shot, so there is nothing it could be made to show.';
  }
  const named = cast.framed.join(', ');
  return cast.required
    ? `Clear this to stop the reviewer calling ${named} missing from this frame. Their sheets ` +
        'still reach the generator, so the frame is drawn from them either way.'
    : `Set this to have the reviewer treat ${named} as missing when the frame does not show them.`;
}
