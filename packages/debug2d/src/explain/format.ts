/**
 * Canonical text formatting for explain output. Floats are fixed-precision and column
 * layout is deterministic, so `explain()` strings are diffable and serve as goldens
 * (research §9) — format changes require golden edits, and that friction is intended.
 */
import type { Rect } from '../geom.js';

/** At most one decimal, no trailing '.0', '-0' normalized — stable across captures. */
export function fmtNum(n: number): string {
  const r = Math.round(n * 10) / 10;
  const v = Object.is(r, -0) ? 0 : r;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** `x,y wxh` — the §9 rect shorthand. */
export function fmtRect(r: Rect): string {
  return `${fmtNum(r.x)},${fmtNum(r.y)} ${fmtNum(r.w)}x${fmtNum(r.h)}`;
}

/** Pad each column to its widest cell; single-space gutters, no trailing spaces. */
export function padCols(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
}
