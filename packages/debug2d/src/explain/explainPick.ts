/**
 * `explainPick` — an ordered rejection log, not an inventory (research §6): the winner,
 * then why each candidate under the point LOST. The flagship line ("z-index N ignored —
 * X established a stacking context via …") is mechanically derived from the culprit the
 * stacking walk retained. Where the computed order and the browser's elementsFromPoint
 * oracle disagree, a ⚠ line says so and refuses to pick a side — an honest "one of us
 * is wrong" is actionable; a confident wrong answer is not.
 */
import { applyToPoint, containsPoint, type Vec2 } from '../geom.js';
import { insideClips, pickBounds } from '../query/hit.js';
import { fmtNum, padCols } from './format.js';
import type { ClipRef, Fragment, Frame, SpaceId } from '../types.js';

type Candidate = {
  f: Fragment;
  /** The query point converted into the fragment's space. */
  p: Vec2;
};

function clipCulprit(f: Fragment, p: Vec2): ClipRef | undefined {
  return (f.clip ?? []).find((c) => !containsPoint(c.rect, p));
}

function labelOf(frame: Frame, id: string): string {
  return frame.fragments.find((f) => f.id === id)?.owner.label ?? id;
}

export function explainPickFrame(frame: Frame, point: Vec2, space: SpaceId = 'css'): string {
  const candidates: Candidate[] = [];
  const unsupported: string[] = [];
  const bySpace = new Map<SpaceId, Fragment[]>();
  for (const f of frame.fragments) {
    const list = bySpace.get(f.space);
    if (list) list.push(f);
    else bySpace.set(f.space, [f]);
  }
  for (const [fragSpace, frags] of bySpace) {
    const m = frame.spaces.transform(space, fragSpace);
    if (!m) {
      for (const f of frags) if (!unsupported.includes(f.source)) unsupported.push(f.source);
      continue;
    }
    const p = applyToPoint(m, point);
    for (const f of frags) {
      if (containsPoint(f.bounds, p) || containsPoint(pickBounds(f), p)) {
        candidates.push({ f, p });
      }
    }
  }
  candidates.sort((a, b) => b.f.z - a.f.z || a.f.id.localeCompare(b.f.id));

  const winner = candidates.find(
    ({ f, p }) => f.pick.mode !== 'none' && insideClips(f, p) && containsPoint(pickBounds(f), p),
  );

  const header = `explainPick(${fmtNum(point.x)}, ${fmtNum(point.y)}) ${space} → ${
    winner
      ? `winner + ${candidates.length - 1} rejection${candidates.length === 2 ? '' : 's'}`
      : `no winner, ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`
  }`;

  const rows: string[][] = [];
  for (const { f, p } of candidates) {
    if (winner && f === winner.f) {
      const alphaWarn = f.style.alpha === 0 ? ' ⚠ alpha 0 — clickable while invisible' : '';
      rows.push(['✓', f.source, `#${f.id}`, f.owner.label, `wins (z=${f.z})${alphaWarn}`]);
      continue;
    }
    let reason: string;
    const clip = clipCulprit(f, p);
    if (f.pick.mode === 'none') {
      reason = "pick='none' (pointer-events)";
    } else if (clip) {
      reason = `clipped away by ${labelOf(frame, clip.by)}`;
    } else if (!containsPoint(pickBounds(f), p)) {
      reason = 'painted here, but its pick geometry misses this point';
    } else if (f.zContext && f.style.zIndex !== undefined) {
      reason = `z-index ${f.style.zIndex} ignored — ${f.zContext.byLabel} established a stacking context via ${f.zContext.reason}`;
    } else if (f.style.alpha === 0) {
      reason = "alpha 0 — but pick='auto' (clickable while invisible)";
    } else if (winner) {
      reason = `below winner (z=${f.z} < ${winner.f.z})`;
    } else {
      reason = `not hit (z=${f.z})`;
    }
    rows.push(['✗', f.source, `#${f.id}`, f.owner.label, reason]);
  }

  const lines = [header, ...padCols(rows).map((r) => `  ${r}`)];

  const oracle = frame.oracle;
  if (oracle && oracle.point.x === point.x && oracle.point.y === point.y && oracle.ids.length) {
    const known = oracle.ids.filter((id) => frame.fragments.some((f) => f.id === id));
    const oracleTop = known[0];
    if (oracleTop && winner && oracleTop !== winner.f.id) {
      lines.push(
        `  ⚠ oracle disagreement: elementsFromPoint ranks #${oracleTop} above #${winner.f.id} — computed`,
        '    stacking order may be wrong here, or the DOM adapter is stale relative to this frame.',
      );
    }
  }
  for (const s of unsupported) lines.push(`  ⚠ source '${s}' could not answer this query`);

  return lines.join('\n');
}
