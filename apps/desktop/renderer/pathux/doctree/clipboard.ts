/**
 * The window's file clipboard: the paths the last Cut or Copy in a Documents pane took, and which
 * of the two it was. Every Documents pane in the window shares it, and it is not persisted. Paste
 * turns it into an ordinary `doc.move` or `doc.copy` with every prop filled in, so nothing about
 * the clipboard reaches main.
 */

/** Whether the next Paste moves the paths or copies them. */
export type ClipMode = 'cut' | 'copy';

export interface Clip {
  paths: readonly string[];
  mode: ClipMode;
}

export const EMPTY_CLIP: Clip = { paths: [], mode: 'cut' };

/** The sentence an empty clipboard's Paste is refused with. */
export const NOTHING_CLIPPED = 'Nothing has been copied or cut yet.';

let held: Clip = EMPTY_CLIP;
const listeners = new Set<() => void>();

/** Answers the clipboard as it stands. */
export function clipboard(): Clip {
  return held;
}

/** Calls `listener` whenever the clipboard changes, until the returned function is called. */
export function onClip(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replaces the clipboard, which tells every listener. */
export function setClip(next: Clip): void {
  held = next;
  for (const listener of listeners) listener();
}

/** Answers the clipboard after it was pasted: a Cut is used up, and a Copy can be pasted again. */
export function pasted(clip: Clip): Clip {
  return clip.mode === 'cut' ? EMPTY_CLIP : clip;
}

/** Whether a row showing `path` draws dimmed, as one waiting to be moved by the next Paste. */
export function isCut(clip: Clip, path: string | undefined): boolean {
  return clip.mode === 'cut' && path !== undefined && clip.paths.includes(path);
}
