/**
 * The branch-marker layer (report §6, plan §P0). Standard Fountain is linear, so
 * branching is expressed with lightweight markers inside Fountain notes (`[[ … ]]`),
 * which ordinary Fountain renderers ignore. Supported forms:
 *
 *   [[scene: s12_rooftop]]                 — assign a stable id to the current scene
 *   [[choice: "Tell the truth" -> s13]]    — a branch edge with a label
 *   [[next: s13]]  /  [[goto: s13]]        — linear continuation to the next scene
 *   [[outfit: aiko=uniform]]               — what a character wears for this whole scene
 *   [[line: L4]]                           — the allocated id of the element below it
 *   [[nextline: 12]]                       — the scene's line-id allocator high-water mark
 */

export type BranchMarker =
  | { kind: 'scene'; id: string }
  | { kind: 'choice'; label: string; goto: string }
  | { kind: 'next'; goto: string }
  | { kind: 'outfit'; characterId: string; outfit: string }
  | { kind: 'line'; id: string }
  | { kind: 'nextline'; value: number };

/** Parse a single note's text into a branch marker, or null if it is a plain note. */
export function parseBranchMarker(note: string): BranchMarker | null {
  const text = note.trim();
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const key = text.slice(0, colon).trim().toLowerCase();
  const value = text.slice(colon + 1).trim();

  if (key === 'scene' || key === 'id') {
    return value ? { kind: 'scene', id: value } : null;
  }
  if (key === 'next' || key === 'goto') {
    return value ? { kind: 'next', goto: value } : null;
  }
  if (key === 'outfit') {
    // One pair per marker, repeated for a second character. Both halves are ids, so a value
    // with whitespace or a missing half is a plain note rather than a half-read marker.
    const eq = value.indexOf('=');
    if (eq < 0) return null;
    const characterId = value.slice(0, eq).trim();
    const outfit = value.slice(eq + 1).trim();
    if (!characterId || !outfit || /\s/.test(characterId) || /\s/.test(outfit)) return null;
    return { kind: 'outfit', characterId, outfit };
  }
  if (key === 'line') {
    return value && !/\s/.test(value) ? { kind: 'line', id: value } : null;
  }
  if (key === 'nextline') {
    // A non-numeric value is a plain note, not a broken allocator: splitScenes then derives
    // the mark from the ids it saw, which is the same path an unmigrated file takes.
    return /^\d+$/.test(value) ? { kind: 'nextline', value: Number(value) } : null;
  }
  if (key === 'choice') {
    const m = /^(.*?)->\s*(\S+)\s*$/.exec(value);
    if (!m) return null;
    const label = (m[1] ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    const goto = (m[2] ?? '').trim();
    return goto ? { kind: 'choice', label: label || goto, goto } : null;
  }
  return null;
}
