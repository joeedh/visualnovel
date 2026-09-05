/**
 * The two rules about who a shot frames: which characters it lists, and whether they have to
 * appear in the picture.
 *
 * They live here for the reason the outfit and variant rules do: the desktop's `story.setSubjects`
 * / `story.requireCast`, the timeline's own strip, and any agent tool over them must give the same
 * answer, so the rule can live in none of them. Both are in the shot's prompt, so either re-hashes
 * the shot and the next run draws that frame again.
 */
import type { Scene, Shot, ShotSubject } from '@vn/types';
import type { ShotOutfitOp } from './outfits.js';

/** An id list, quoted and comma-separated for a refusal sentence. */
const listed = (ids: readonly string[]): string => ids.map((id) => `"${id}"`).join(', ') || 'none';

/**
 * Set the characters `shot` frames, in the given order. An empty list makes it a background plate,
 * which is a real answer rather than an unfilled one: nothing is then expected in frame.
 *
 * A character that stays keeps its outfit override, so re-ordering the list or adding someone does
 * not quietly undress the rest. One that leaves takes its override with it, since an override on a
 * character the shot no longer frames reaches nothing.
 */
export function setShotSubjects(
  shots: readonly Shot[],
  scene: Pick<Scene, 'id'>,
  cast: readonly string[],
  args: { shot: string; subjects: readonly string[] },
): ShotOutfitOp {
  const shot = shots.find((s) => s.id === args.shot);
  if (!shot) return { ok: false, error: `No shot "${args.shot}" in ${scene.id}.` };

  const wanted = [...new Set(args.subjects)];
  const unknown = wanted.filter((id) => !cast.includes(id));
  if (unknown.length > 0) {
    return {
      ok   : false,
      error: `No character "${unknown[0]}" in this project — it has ${listed(cast)}.`,
    };
  }

  const was = shot.subjects.map((s) => s.characterId);
  if (was.length === wanted.length && was.every((id, i) => id === wanted[i])) {
    return {
      ok   : false,
      error: wanted.length
        ? `${args.shot} already frames ${wanted.join(', ')}.`
        : `${args.shot} already frames nobody.`,
      noop : true,
    };
  }

  const held = new Map(shot.subjects.map((s) => [s.characterId, s]));
  const subjects: ShotSubject[] = wanted.map((id) => held.get(id) ?? { characterId: id });
  const next = shots.map((s) => (s.id === args.shot ? { ...s, subjects } : s));
  const gone = was.filter((id) => !wanted.includes(id));
  const message =
    (wanted.length
      ? `${args.shot} frames ${wanted.join(', ')}.`
      : `${args.shot} frames nobody — it is a background plate now.`) +
    (gone.length ? ` ${gone.join(', ')} left it, and their outfit overrides with them.` : '') +
    ' The frame is drawn again on the next run.';
  return { ok: true, shots: next, message };
}

/**
 * Say whether the characters `shot` lists have to be in the picture it produces. With `required`
 * off the sheets still reach the generator as references, and only the reviewer's demand goes
 * away — see {@link Shot.castOptional} for what that stops.
 */
export function requireShotCast(
  shots: readonly Shot[],
  scene: Pick<Scene, 'id'>,
  args: { shot: string; required: boolean },
): ShotOutfitOp {
  const shot = shots.find((s) => s.id === args.shot);
  if (!shot) return { ok: false, error: `No shot "${args.shot}" in ${scene.id}.` };
  const optional = shot.castOptional === true;
  if (optional === !args.required) {
    return {
      ok   : false,
      error: optional
        ? `${args.shot} already lets its cast out of frame.`
        : `${args.shot} already requires its cast in frame.`,
      noop : true,
    };
  }
  if (!args.required && shot.subjects.length === 0) {
    return {
      ok   : false,
      error: `${args.shot} frames nobody, so there is nothing to stop requiring.`,
    };
  }

  const next = shots.map((s) => {
    if (s.id !== args.shot) return s;
    const { castOptional: _dropped, ...rest } = s;
    return args.required ? rest : { ...rest, castOptional: true };
  });
  const message = args.required
    ? `${args.shot} must show ${shot.subjects.map((s) => s.characterId).join(', ')} again; ` +
      'a frame without them is a defect once more.'
    : `${args.shot} no longer has to show anybody. Its cast still reaches the generator as ` +
      'references, but the reviewer will not call an absence a defect.';
  return { ok: true, shots: next, message };
}
