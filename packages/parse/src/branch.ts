/**
 * The branch-marker layer (report §6, plan §P0). Standard Fountain is linear, so
 * branching is expressed with lightweight markers inside Fountain notes (`[[ … ]]`),
 * which ordinary Fountain renderers ignore. Supported forms:
 *
 *   [[scene: s12_rooftop]]                 — assign a stable id to the current scene
 *   [[choice: "Tell the truth" -> s13]]    — a branch edge with a label
 *   [[next: s13]]  /  [[goto: s13]]        — linear continuation to the next scene
 */

export type BranchMarker =
  | { kind: 'scene'; id: string }
  | { kind: 'choice'; label: string; goto: string }
  | { kind: 'next'; goto: string };

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
