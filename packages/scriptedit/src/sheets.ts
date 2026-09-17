/**
 * The rule about a scene's staging-sheet groups: which shots share one, and the seed and notes a
 * group carries. It lives here for the reason the panel rule does: the desktop's `story.setSheet`
 * and `story.setSheetGroup` and the agent's tools must give the same answer. A group's members,
 * seed and notes are all in the sheet's key, so any change here re-keys every member shot and the
 * next run draws the sheet, and every member, again.
 */
import { MAX_SHEET_CELLS, type SheetGroup } from '@vn/types';

/** Just enough of a `Shot` to reason about its group. */
export interface SheetShot {
  id: string;
  sheet?: string;
}

/** A group change: the shots and groups as they would be written. */
export type SheetsOp<S extends SheetShot> =
  | { ok: true; shots: S[]; sheets: Record<string, SheetGroup>; message: string }
  | { ok: false; error: string; noop?: boolean };

const GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function refuse(error: string, noop?: true): { ok: false; error: string; noop?: boolean } {
  return noop ? { ok: false, error, noop } : { ok: false, error };
}

function membersOf<S extends SheetShot>(shots: readonly S[], group: string): S[] {
  return shots.filter((s) => s.sheet === group);
}

/** The groups with no member left dropped, since a group is defined by the shots that name it. */
function pruned<S extends SheetShot>(
  shots: readonly S[],
  sheets: Readonly<Record<string, SheetGroup>>,
): Record<string, SheetGroup> {
  const out: Record<string, SheetGroup> = {};
  for (const [id, group] of Object.entries(sheets)) {
    if (membersOf(shots, id).length > 0) out[id] = group;
  }
  return out;
}

/**
 * Puts `shot` in the group `sheet`, or takes it out of its group when `sheet` is empty. A group
 * already holding `MAX_SHEET_CELLS` shots is refused, because a sheet has that many cells. A
 * group's settings stay while it has a member and go when its last member leaves.
 */
export function setSheet<S extends SheetShot>(
  shots: readonly S[],
  sheets: Readonly<Record<string, SheetGroup>> | undefined,
  args: { shot: string; sheet: string },
): SheetsOp<S> {
  const shot = shots.find((s) => s.id === args.shot);
  if (!shot) return refuse(`No shot "${args.shot}" in this scene.`);

  const wanted = args.sheet.trim();
  if (wanted !== '' && !GROUP_ID.test(wanted)) {
    return refuse(
      `"${wanted}" is not a sheet group id; use letters, digits, dashes and underscores.`,
    );
  }
  if ((shot.sheet ?? '') === wanted) {
    return refuse(
      wanted === ''
        ? `Shot "${shot.id}" is in no sheet group.`
        : `Shot "${shot.id}" is already in sheet group "${wanted}".`,
      true,
    );
  }
  if (wanted !== '' && membersOf(shots, wanted).length >= MAX_SHEET_CELLS) {
    return refuse(
      `Sheet group "${wanted}" already has ${MAX_SHEET_CELLS} shots, which is as many cells as a sheet carries; start another group.`,
    );
  }

  const next = shots.map((s) => {
    if (s.id !== shot.id) return s;
    const { sheet: _dropped, ...rest } = s;
    return (wanted === '' ? rest : { ...rest, sheet: wanted }) as S;
  });
  const size = membersOf(next, wanted).length;
  const message =
    wanted === ''
      ? `Shot "${shot.id}" leaves sheet group "${shot.sheet}".`
      : `Shot "${shot.id}" joins sheet group "${wanted}" (${size} of ${MAX_SHEET_CELLS} cells).`;
  return { ok: true, shots: next, sheets: pruned(next, sheets ?? {}), message };
}

/**
 * Sets a group's seed and notes. The group must have a member, since a group is the shots that
 * name it. A seed below zero is refused; an absent seed clears the group's own, so the sheet is
 * drawn with none; empty notes clear the notes.
 */
export function setSheetGroup<S extends SheetShot>(
  shots: readonly S[],
  sheets: Readonly<Record<string, SheetGroup>> | undefined,
  args: { sheet: string; seed?: number; notes?: string },
): SheetsOp<S> {
  const id = args.sheet.trim();
  if (membersOf(shots, id).length === 0) {
    return refuse(`No shot in this scene is in a sheet group "${id}".`);
  }
  if (args.seed !== undefined && (!Number.isInteger(args.seed) || args.seed < 0)) {
    return refuse(`A sheet seed is a whole number of zero or more, not ${String(args.seed)}.`);
  }

  const group: SheetGroup = {};
  if (args.seed !== undefined) group.seed = args.seed;
  const notes = args.notes?.trim() ?? '';
  if (notes !== '') group.notes = notes;

  const before = sheets?.[id] ?? {};
  if (before.seed === group.seed && (before.notes ?? '') === (group.notes ?? '')) {
    return refuse(`Sheet group "${id}" already has these settings.`, true);
  }

  const next = pruned(shots, { ...(sheets ?? {}), [id]: group });
  const said = [
    group.seed === undefined ? 'no seed of its own' : `seed ${group.seed}`,
    group.notes === undefined ? 'no notes' : 'notes',
  ].join(' and ');
  return { ok: true, shots: [...shots], sheets: next, message: `Sheet group "${id}": ${said}.` };
}
