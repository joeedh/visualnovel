/**
 * What a prose edit does to the shots that illustrate it: which `work/shots/<scene>.json` files
 * change, which shots follow their lines into another scene, which lose coverage, and which keep
 * art made from prose that no longer reads that way.
 *
 * It is the second half of a `lineops` decision and deliberately not part of it. `lineops` is
 * pure over the *scene set* and knows nothing about the storyboard; this module takes the op's
 * three id lists (`moved`, `retired`, `retyped`) plus the shots as they sit on disk and answers
 * the question an author needs answered before committing: what does this cost?
 *
 * Four rules carry the whole module:
 *
 * - **A shot follows its lines when all of them go to the same place.** Coverage is a set of line
 *   ids and `moved` maps every id a scene edit renames, so a shot covering only lines that left
 *   for one scene is *that scene's* shot now — it changes file, keeps its id, keeps its art.
 * - **A shot that straddles stays put and loses what left.** That is the honest signal a split is
 *   in the wrong place, and the count is what the check reports.
 * - **A shot's own id is part of its task hash**, so nothing here renames one. A shot carried into
 *   `rooftop` keeps the id it was minted with (`arrival__beat1`) precisely so its generated image
 *   is still the answer to the task that produced it.
 * - **No *prose* edit invalidates art, so drift has to be reported.** No line's text reaches a
 *   shot's task inputs, which is why editing is affordable at all — and also why a rendered frame
 *   goes on illustrating text the author replaced until they ask for a new one. `drifted` is that
 *   count. A scene's *heading* is the exception and the reason `restaged` is priced separately: a
 *   location **is** in a shot's task inputs, so moving a scene re-renders it.
 */
import type { Shot } from '@vn/types';
import { sceneIdOf, type AppliedLineOp } from './lineops.js';

/** The persisted shots of every scene an edit touches, keyed by scene id. */
export type ShotsByScene = ReadonlyMap<string, readonly Shot[]>;

export interface ShotFallout {
  /** Scene id → the complete shot list to write. A scene absent from it keeps its file as is. */
  writes: Map<string, Shot[]>;
  /**
   * Scene ids whose shots file must go — either the scene stopped existing, or it has no shots
   * left. An absent file is the *only* signal that means "decompose this scene", so removing an
   * emptied one is how a scene gets a fresh storyboard instead of staying blank forever. The same
   * posture as `deleteShot` removing the last shot by hand (`shotcreate.ts`): an empty list is
   * never written, the file is deleted instead.
   */
  removes: string[];
  /** Shots that changed file, `[shotId, destination scene]`. Their art is untouched. */
  carried: [string, string][];
  /** Shots that stay where they are and lose coverage, `[shotId, lines lost]`. */
  detached: [string, number][];
  /** Shots that stay and end up covering nothing — real, paid for, and never displayed. */
  orphaned: string[];
  /** Shots dropped with the file of a scene that stopped existing. */
  discarded: string[];
  /**
   * Shots whose scene changed place, restaged onto the new heading's variant. This is the one
   * consequence in this module that *does* rehash: a location is in a shot's task inputs, so a
   * rendered one here is re-rendered rather than left to drift.
   */
  restaged: string[];
  /**
   * Rendered shots whose covered prose changed. Nothing re-renders them — the task hash does not
   * see line text — so the frame keeps depicting the old words until the author regenerates it.
   */
  drifted: string[];
  /**
   * The sentence a `check` note and a run message both append to the op's own message. Empty when
   * the edit costs the storyboard nothing, so the common case stays quiet.
   */
  note: string;
}

/**
 * The scenes whose storyboard an edit could touch: the ones it writes or removes, plus whichever
 * scene owns each id it renames, retires or retypes. A caller reads exactly these shot files and
 * hands them to {@link shotFallout}.
 */
export function scenesTouchedBy(op: AppliedLineOp): string[] {
  const ids = new Set<string>();
  for (const scene of op.writes) ids.add(scene.id);
  for (const id of op.removes) ids.add(id);
  for (const [from, to] of op.moved) {
    ids.add(sceneIdOf(from));
    ids.add(sceneIdOf(to));
  }
  for (const id of [...op.retired, ...op.retyped]) ids.add(sceneIdOf(id));
  for (const [sceneId] of op.relocated) ids.add(sceneId);
  ids.delete('');
  return [...ids];
}

/** Every id a shot still covers, renamed where the edit renamed it and dropped where it retired. */
function rewrite(op: AppliedLineOp, shot: Shot): string[] {
  const retired = new Set(op.retired);
  const lines: string[] = [];
  for (const id of shot.coversLines) {
    const moved = op.moved.find(([from]) => from === id);
    if (moved) lines.push(moved[1]);
    else if (!retired.has(id)) lines.push(id);
  }
  return lines;
}

/**
 * The storyboard consequence of an accepted `lineops` decision. Pure: the caller reads the shot
 * files, this decides what they should say, and `session.editScene` is the only thing that writes.
 */
export function shotFallout(op: AppliedLineOp, shots: ShotsByScene): ShotFallout {
  const gone = new Set(op.removes);
  const retyped = new Set(op.retyped);
  const staging = new Map(op.relocated);

  // Every surviving scene that has a file starts with an empty list, so one that loses its last
  // shot is visible as emptied rather than simply never mentioned.
  const next = new Map<string, Shot[]>();
  for (const sceneId of shots.keys()) if (!gone.has(sceneId)) next.set(sceneId, []);
  const listFor = (sceneId: string): Shot[] => {
    const existing = next.get(sceneId);
    if (existing) return existing;
    const fresh: Shot[] = [];
    next.set(sceneId, fresh);
    return fresh;
  };

  const carried: [string, string][] = [];
  const detached: [string, number][] = [];
  const orphaned: string[] = [];
  const discarded: string[] = [];
  const drifted: string[] = [];
  const restaged: string[] = [];

  for (const [sceneId, owned] of shots) {
    for (const shot of owned) {
      // One destination for everything it still covers means the shot belongs there now. A shot
      // covering nothing has no destination to argue for, so it stays with the scene it was in.
      const surviving = rewrite(op, shot);
      const destinations = new Set(surviving.map(sceneIdOf));
      const first = destinations.values().next().value;
      const home = destinations.size === 1 && first !== sceneId ? (first as string) : sceneId;

      // A shot only ever covers its own scene's lines, so whatever ended up elsewhere is lost —
      // together with the ids that retired outright. That count is the straddle the check reports.
      const lines = surviving.filter((id) => sceneIdOf(id) === home);
      const lost = shot.coversLines.length - lines.length;

      if (shot.image !== undefined && lines.some((id) => retyped.has(id))) drifted.push(shot.id);
      if (home !== sceneId) {
        carried.push([shot.id, home]);
      } else if (gone.has(sceneId)) {
        // Its scene is gone and its lines went nowhere. Keeping the shot would need a scene to
        // keep it in, and the author deleted the one it belonged to.
        discarded.push(shot.id);
        continue;
      } else {
        if (lost > 0) detached.push([shot.id, lost]);
        if (lines.length === 0 && shot.coversLines.length > 0) orphaned.push(shot.id);
      }
      // Restaging is keyed by the scene the shot ends up in, so a shot carried into a scene that
      // moved is staged where it lands rather than where it came from.
      const variant = staging.get(home);
      if (variant !== undefined && variant !== shot.location) restaged.push(shot.id);
      listFor(home).push({
        ...shot,
        sceneId: home,
        coversLines: lines,
        ...(variant !== undefined ? { location: variant } : {}),
      });
    }
  }

  const writes = new Map<string, Shot[]>();
  const emptied: string[] = [];
  for (const [sceneId, list] of next) {
    const before = shots.get(sceneId) ?? [];
    if (list.length === 0) {
      if (before.length > 0) emptied.push(sceneId);
      continue;
    }
    if (!unchanged(before, list)) writes.set(sceneId, list);
  }
  const removes = [...op.removes.filter((id) => shots.has(id)), ...emptied];

  const fallout = { writes, removes, carried, detached, orphaned, discarded, drifted, restaged };
  return { ...fallout, note: noteFor(shots, { ...fallout, emptied }) };
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

function unchanged(before: readonly Shot[], after: readonly Shot[]): boolean {
  return (
    before.length === after.length &&
    before.every((shot, i) => {
      const now = after[i] as Shot;
      return (
        shot.id === now.id &&
        shot.location === now.location &&
        sameLines(shot.coversLines, now.coversLines)
      );
    })
  );
}

/** How many of a set of shots already have an image, so the note can price what is being lost. */
function renderedIn(shots: ShotsByScene, ids: readonly string[]): number {
  const withArt = new Set<string>();
  for (const owned of shots.values()) {
    for (const shot of owned) if (shot.image !== undefined) withArt.add(shot.id);
  }
  return ids.filter((id) => withArt.has(id)).length;
}

type NoteParts = Omit<ShotFallout, 'note' | 'writes' | 'removes'> & { emptied: string[] };

function noteFor(shots: ShotsByScene, parts: NoteParts): string {
  const clauses: string[] = [];
  const priced = (ids: readonly string[]): string => {
    const rendered = renderedIn(shots, ids);
    return rendered > 0 ? `, ${rendered} already rendered` : '';
  };

  if (parts.carried.length > 0) {
    const into = [...new Set(parts.carried.map(([, to]) => to))].join(', ');
    clauses.push(`${parts.carried.length} shot(s) follow their lines into ${into}`);
  }
  if (parts.detached.length > 0) {
    const lines = parts.detached.reduce((n, [, lost]) => n + lost, 0);
    const ids = parts.detached.map(([id]) => id);
    clauses.push(`${ids.length} shot(s) lose ${lines} line(s) of coverage${priced(ids)}`);
  }
  if (parts.orphaned.length > 0) {
    clauses.push(`${parts.orphaned.length} shot(s) end up covering nothing`);
  }
  if (parts.discarded.length > 0) {
    clauses.push(`${parts.discarded.length} shot(s) go with it${priced(parts.discarded)}`);
  }
  if (parts.restaged.length > 0) {
    const rendered = renderedIn(shots, parts.restaged);
    clauses.push(
      rendered > 0
        ? `${parts.restaged.length} shot(s) are set somewhere else now, ${rendered} already ` +
            `rendered — a location is in a shot's task inputs, so those will be drawn again`
        : `${parts.restaged.length} shot(s) are set somewhere else now`,
    );
  }
  if (parts.drifted.length > 0) {
    clauses.push(
      `${parts.drifted.length} rendered shot(s) still illustrate the old prose and will not ` +
        `re-render on their own`,
    );
  }
  if (parts.emptied.length > 0) {
    clauses.push(`${parts.emptied.join(', ')} has no shots left and will be decomposed again`);
  }
  return clauses.length === 0 ? '' : `${capitalize(clauses.join('; '))}.`;
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
