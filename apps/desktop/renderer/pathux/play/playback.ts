/**
 * The runner's rules, with no widget in them: folding a scene's beats into frames, where a click
 * or a key goes next, and what a save file is. The path.ux editor holds only the rendering.
 */
import type { Beat, Playable, PlayableScene } from '../../../src/shared/ipc.js';

/** A content-addressed asset ref, as it appears in the playable. */
export interface Ref {
  hash: string;
  ext: string;
}

/** A position in the playthrough: which scene, and how far into its frames. */
export interface Pos {
  sceneId: string;
  frameIndex: number;
}

/**
 * A textual beat with the accumulated stage state at that point: `show` beats are folded into
 * the frame that follows them, so advancing one frame reveals one line of dialogue or narration
 * while the background and portrait carry over.
 */
export interface Frame {
  bg?: Ref;
  /** The shot the background came from — what a jump-to-shot selects. */
  shotId?: string;
  /** Last speaker so far — drives which portrait is on stage (persists through narration). */
  portraitWho?: string;
  /** Set only when this frame is spoken dialogue (drives the nameplate). */
  speaker?: string;
  text: string;
}

/** Fold a scene's beats into displayable frames. */
export function framesOf(scene: PlayableScene | undefined): Frame[] {
  if (!scene) return [];

  const frames: Frame[] = [];
  let bg: Ref | undefined;
  let shotId: string | undefined;
  let lastWho: string | undefined;

  for (const beat of scene.beats as Beat[]) {
    if (beat.type === 'show') {
      bg = beat.image;
      shotId = beat.shot;
    } else if (beat.type === 'say') {
      lastWho = beat.who;
      frames.push({ bg, shotId, portraitWho: lastWho, speaker: beat.who, text: beat.text });
    } else {
      frames.push({ bg, shotId, portraitWho: lastWho, text: beat.text });
    }
  }

  return frames;
}

/** `vnasset://<hash>.<ext>` — resolved by main from the content-addressed store. */
export function assetUrl(ref?: Ref): string | undefined {
  return ref ? `vnasset://${ref.hash}.${ref.ext}` : undefined;
}

/**
 * Where a click goes from `history`'s last position. Advances one frame. At the scene-end panel
 * with no choice to make, follows the linear `next`. Returns the same array when there is nowhere
 * to go, so a caller can compare by identity.
 */
export function advance(play: Playable, history: Pos[]): Pos[] {
  const cur = history[history.length - 1];
  if (!cur) return history;

  const scene = play.scenes[cur.sceneId];
  if (!scene) return history;

  if (cur.frameIndex < framesOf(scene).length) {
    return [...history, { sceneId: cur.sceneId, frameIndex: cur.frameIndex + 1 }];
  }

  if (!scene.choices.length && scene.next) {
    return [...history, { sceneId: scene.next, frameIndex: 0 }];
  }

  return history;
}

/** One step back through the navigation stack; the entry position is never popped. */
export function back(history: Pos[]): Pos[] {
  return history.length > 1 ? history.slice(0, -1) : history;
}

/** Follow a choice edge. */
export function choose(history: Pos[], goto: string): Pos[] {
  return [...history, { sceneId: goto, frameIndex: 0 }];
}

/** The opening history for a playable, or empty when it has no entry scene. */
export function startOf(play: Playable): Pos[] {
  return play.start ? [{ sceneId: play.start, frameIndex: 0 }] : [];
}

/**
 * Where a scene or a shot selected elsewhere in the shell sits in the playable: the first frame
 * drawn from that shot, or the scene's first frame when no shot is named. `null` for a scene the
 * playable does not have, which is what an unexported scene looks like from here.
 *
 * A shot the scene's frames do not name falls back to that scene's first frame. A shot covering
 * only stage directions has no frame of its own, and a shot id from another scene is a stale
 * selection rather than a reason to refuse the scene.
 */
export function jumpTo(play: Playable, sceneId: string, shotId: string): Pos | null {
  const scene = play.scenes[sceneId];
  if (!scene) return null;
  const at = shotId ? framesOf(scene).findIndex((f) => f.shotId === shotId) : -1;
  return { sceneId, frameIndex: at < 0 ? 0 : at };
}

/** Whether two positions are the same place, so a jump that would not move is skipped. */
export function samePos(a: Pos | undefined, b: Pos | null): boolean {
  return !!a && !!b && a.sceneId === b.sceneId && a.frameIndex === b.frameIndex;
}

/** Saves are per-title, so two projects open in turn do not overwrite each other. */
export function saveKeyOf(play: Playable | undefined): string {
  return play ? `vn.runner.save.${play.title}` : 'vn.runner.save';
}

/**
 * Accepts a history stack and rejects anything else. The stored value is user-writable
 * (localStorage), so it is validated rather than trusted.
 */
export function parseSave(raw: string | null): Pos[] | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed) || !parsed.length) return undefined;

  const ok = parsed.every(
    (p): p is Pos =>
      !!p &&
      typeof p === 'object' &&
      typeof (p as Pos).sceneId === 'string' &&
      Number.isInteger((p as Pos).frameIndex),
  );

  return ok ? (parsed as Pos[]) : undefined;
}
