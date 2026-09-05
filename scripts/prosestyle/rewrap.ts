/**
 * Re-wrapping a revised block to the shape its original had.
 *
 * A block whose text did not change is emitted byte for byte by the caller and never reaches
 * this file, so nothing cosmetic pads the diff a person reviews.
 */
import { splitBlocks, isProse } from './split.js';

const LIST_MARKER = /^(\s*(?:[-*+]|\d+[.)])\s+)/;

/** `.prettierignore` excludes `docs/**`, so there is no repo-wide width to read from a config. */
const FALLBACK_WIDTH = 95;

function bareLines(text: string): string[] {
  return text.replace(/\r?\n$/, '').split(/\r?\n/);
}

/**
 * The width the document wraps at, read from the lines the author actually broke: every line of a
 * prose block except its last. A block's final line stops early because the text ran out, and a
 * line carrying a long link can exceed the width because it could not be broken, so taking the
 * longest line of all reports a width the document never used.
 */
export function wrapWidth(markdown: string): number {
  const broken = splitBlocks(markdown)
    .filter(isProse)
    .flatMap((b) => bareLines(b.text).slice(0, -1));
  const widest = broken.reduce((max, line) => Math.max(max, line.length), 0);
  return widest >= 60 ? widest : FALLBACK_WIDTH;
}

export interface Shape {
  /** What opens the first line: a list marker with its indent, or a bare indent. */
  prefix: string;
  /** What opens every line after the first. */
  hanging: string;
  eol: string;
  width: number;
  /**
   * The original's own line terminator, or the empty string at end of file. It is structural:
   * blocks tile the document, so dropping it would run this block into the next one.
   */
  trailing: string;
}

/** Reads the shape of the original block, which the revision has to be poured back into. */
export function shapeOf(original: string, width: number): Shape {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const rows = bareLines(original);
  const first = rows[0] ?? '';
  const marker = LIST_MARKER.exec(first);
  const prefix = marker ? (marker[1] as string) : (/^\s*/.exec(first)?.[0] ?? '');
  const second = rows[1];
  const hanging =
    second !== undefined && second.trim()
      ? (/^\s*/.exec(second)?.[0] ?? '')
      : ' '.repeat(prefix.length);
  const trailing = /(\r?\n)$/.exec(original)?.[1] ?? '';
  return { prefix, hanging, eol, width, trailing };
}

/**
 * Pours revised text back into the original's shape. A word longer than the remaining room is
 * placed whole and allowed to overflow, since breaking a URL or an identifier is worse than a
 * long line.
 */
export function rewrap(revised: string, shape: Shape): string {
  const words = revised.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return revised;

  const out: string[] = [];
  let line = shape.prefix;
  let empty = true;

  for (const word of words) {
    const candidate = empty ? line + word : `${line} ${word}`;
    if (!empty && candidate.length > shape.width) {
      out.push(line);
      line = shape.hanging + word;
    } else {
      line = candidate;
    }
    empty = false;
  }
  out.push(line);

  return out.join(shape.eol) + shape.trailing;
}
