/**
 * Asking one question about one stored image and getting a paragraph of prose back.
 *
 * This is deliberately not `VisionReviewer`. That interface belongs to P7: it is told what a shot
 * ordered and answers with a structured `DefectReport` the refine loop branches on, and it has no
 * question to ask about a portrait, a sheet or a plate. What an author (or an agent proposing an
 * art note) needs is the plain vision call underneath: "does this read as brutalist yet?" is not a
 * defect report, and widening the reviewer to carry it would put two jobs in one interface, one of
 * them in the task graph's hot path.
 */
import type { Asset } from '@vn/types';
import type { AssetStore } from '@vn/store';
import type { ChatBackend } from '@vn/providers';
import { VnError } from '@vn/util';
import { slotOf } from './refcycle.js';
import { slotLabel } from './slotaddr.js';

export interface DescribeDeps {
  store: AssetStore;
  /** Any vision-capable chat backend; the host picks the model, as it does for every other call. */
  backend: ChatBackend;
}

export interface DescribeRequest {
  /** The asset to look at, named by a full hash. A surface that takes a prefix resolves it first. */
  hash: string;
  /** What to ask about it. Defaults to {@link DEFAULT_QUESTION}. */
  question?: string;
}

export interface DescribeResult {
  hash: string;
  /** What this picture is, in the project's own terms — `rooftop — evening plate`. */
  label: string;
  answer: string;
}

/** Asked when the caller has no question of its own — the widest useful one. */
export const DEFAULT_QUESTION =
  'Describe this image: subject, framing, palette, style, and anything that looks wrong.';

const SYSTEM =
  'You are looking at one generated image from a visual novel. Answer the question about it ' +
  'directly and concretely, in one short paragraph. Describe what is actually there — do not ' +
  'invent detail you cannot see, and do not offer to help further.';

/**
 * What a picture is called, from the slot it fills. A concept or an upload fills none, so the title
 * it was stored with is used instead.
 */
export function assetSlotLabel(asset: Asset): string {
  const slot = slotOf(asset);
  if (slot) return slotLabel(slot);
  return asset.title?.trim() || `${asset.kind} ${asset.hash.slice(0, 8)}`;
}

/**
 * Ask a vision model about one stored picture. Refuses an asset the store has never heard of
 * rather than describing whatever came before it. A task that is queued but not run has no image,
 * and the refusal says so.
 */
export async function describeAsset(
  deps: DescribeDeps,
  req: DescribeRequest,
): Promise<DescribeResult> {
  const asset = deps.store.manifest().find((a) => a.hash === req.hash);
  if (!asset) {
    throw new VnError(
      'UNKNOWN_ASSET',
      `No asset "${req.hash}" in the store — a task that has not run has no picture to look at yet.`,
    );
  }
  const bytes = await deps.store.read({ hash: asset.hash, ext: asset.ext }).catch(() => undefined);
  if (!bytes) {
    throw new VnError(
      'NO_BYTES',
      `Asset ${req.hash.slice(0, 8)} is in the manifest but its bytes are not on disk.`,
    );
  }
  const question = req.question?.trim() || DEFAULT_QUESTION;
  const answer = await deps.backend.message({
    system: SYSTEM,
    prompt: question,
    images: [{ bytes, ext: asset.ext }],
  });
  return { hash: asset.hash, label: assetSlotLabel(asset), answer: answer.trim() };
}
