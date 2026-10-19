/**
 * The write path for `asset.forget`, which removes every reference this project holds to one
 * picture. Pins and shot images go through {@link forgetPicture}; an approved portrait naming the
 * picture is cleared on the sheet directly, since the unapprove path refuses once the manifest row
 * is gone.
 */
import { clearCharacterApproval, removeApprovedPortrait, writeShots } from '@vn/store';
import type { Shot } from '@vn/types';
import { writeFileAtomic } from '@vn/util';
import { forgetPicture, type ChangedShot } from './entitydelete.js';
import { readBoards, sheetTexts, type EntityDeleteInput } from './entityplan.js';

/** What forgetting a picture will write, with nothing left to decide. */
export interface AppliedForgetPlan {
  ok: true;
  hash: string;
  /** Sheets to write whole, absolute. */
  pending: { file: string; text: string }[];
  shotWrites: Map<string, Shot[]>;
  /** Characters whose approved portrait is the picture, with their sheets, absolute. */
  approvals: { id: string; file: string }[];
  changed: ChangedShot[];
  pins: number;
  images: number;
}

export type ForgetPlan = AppliedForgetPlan | { ok: false; message: string };

/** Decides what forgetting `hash` rewrites against a fresh read of every storyboard. */
export async function planForget(
  input: Omit<EntityDeleteInput, 'manifest'>,
  hash: string,
): Promise<ForgetPlan> {
  const op = forgetPicture(
    { shots: await readBoards(input), characters: input.characters, locations: input.locations },
    hash,
  );
  const pending = sheetTexts(input.inputs, op.sheets);
  if (typeof pending === 'string') return { ok: false, message: pending };
  const approvals: { id: string; file: string }[] = [];
  for (const character of input.characters.values()) {
    if (character.approvedPortrait !== hash) continue;
    const doc = input.inputs.characterDocs.find((d) => d.id === character.id);
    if (!doc) return { ok: false, message: `No sheet on disk for character "${character.id}".` };
    approvals.push({ id: character.id, file: doc.file });
  }
  return {
    ok: true,
    hash,
    pending,
    shotWrites: op.shots,
    approvals,
    changed: op.changed,
    pins   : op.pins,
    images : op.images,
  };
}

/**
 * Writes a forget plan: the sheets, then the storyboards, then each approval cleared. Paths are
 * absolute. A sheet can lose both a pin and an approval, so the approval is cleared after the sheet
 * is written.
 */
export async function applyForget(
  input: Pick<EntityDeleteInput, 'paths'>,
  plan: AppliedForgetPlan,
): Promise<{ written: string[]; removed: string[] }> {
  const written: string[] = [];
  for (const { file, text } of plan.pending) {
    await writeFileAtomic(file, text);
    written.push(file);
  }
  for (const [sceneId, shots] of plan.shotWrites) {
    if (await writeShots(input.paths, sceneId, shots)) written.push(input.paths.shotsFile(sceneId));
  }
  const removed: string[] = [];
  for (const { id, file } of plan.approvals) {
    if (await clearCharacterApproval(file)) written.push(file);
    await removeApprovedPortrait(input.paths, id);
    removed.push(input.paths.approvedPortrait(id));
  }
  return { written: [...new Set(written)], removed };
}

/** Formats `n thing(s)` with the plural spelled out. */
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Describes what a forget plan does in one sentence, in the past tense when `done`. */
export function forgetPlanMessage(plan: AppliedForgetPlan, done = false): string {
  const short = plan.hash.slice(0, 8);
  const parts: string[] = [];
  if (plan.pins > 0) parts.push(`drops ${count(plan.pins, 'pin')}`);
  if (plan.images > 0) parts.push(`clears the picture of ${count(plan.images, 'shot')}`);
  if (plan.approvals.length > 0) {
    parts.push(`clears the approved portrait of ${plan.approvals.map((a) => a.id).join(', ')}`);
  }
  const verb = done ? 'Forgot' : 'Forgets';
  if (parts.length === 0) {
    return `${verb} ${short}: nothing in the project names it, so only its task record goes.`;
  }
  return `${verb} ${short}: ${parts.join(', ')}. The next run plans what it was for again.`;
}
