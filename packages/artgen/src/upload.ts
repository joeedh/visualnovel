/**
 * Bringing outside bytes into the store (`docs/plans/archive/INDEX.md#chunked-prompts` §15).
 *
 * A custom reference is not generated at all, unlike a concept, which comes from an unplanned
 * call. It has no binding, so it can never drift, and it is the store's only ingress for bytes
 * from outside.
 *
 * Validation happens here rather than at use. A file that is not an image, or one carrying the
 * mock marker a real backend refuses, fails at upload with a sentence naming the file rather than
 * mid-run with a provider error.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AssetRef } from '@vn/types';
import type { AssetStore } from '@vn/store';
import { isPlaceholderImage } from '@vn/providers';
import { hashParts, sha256, VnError } from '@vn/util';
import { baseRefusal } from './base.js';

/** How much of a filename becomes the asset's name when the author gave none. */
const TITLE_CHARS = 48;

/**
 * Leading bytes that identify a format an image model will accept. A signature check rather than a
 * decode: the point is to reject a PDF or a text file named `.png`, and nothing here needs the
 * pixels. The extension comes from the bytes, never from the name they arrived under.
 */
const SIGNATURES: { ext: string; magic: readonly number[]; at?: number }[] = [
  { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { ext: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'webp', magic: [0x57, 0x45, 0x42, 0x50], at: 8 },
];

/** The extension these bytes really are, or `undefined` for something that is not an image. */
export function imageExt(bytes: Uint8Array): string | undefined {
  return SIGNATURES.find(({ magic, at = 0 }) => magic.every((b, i) => bytes[at + i] === b))?.ext;
}

export interface UploadRequest {
  /** Path of the file to ingest. */
  file: string;
  /** What to call it on screen. Empty means the filename. */
  title?: string;
}

/** What an upload would record, once the bytes have been read. */
export interface UploadPlan {
  ext: string;
  /** Synthesized: an upload has no task, so provenance names the request instead. */
  sourceTask: string;
  title: string;
  /** True when these exact bytes are already in the store — the upload is then a no-op. */
  known: boolean;
  /** The sentence a surface shows before writing into the repo. */
  note: string;
}

export interface UploadResult {
  ref: AssetRef;
  title: string;
  /** Absolute path of the bytes as stored. */
  stored: string;
  known: boolean;
}

/** The filename, shortened at a word boundary — what an upload is called with no title given. */
function fileTitle(file: string): string {
  const name = basename(file)
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return name.length <= TITLE_CHARS ? name : `${name.slice(0, TITLE_CHARS).trimEnd()}…`;
}

/**
 * Every refusal an upload can give, decided from the bytes and the manifest alone. Same two-layer
 * shape as `promotionOf`, so the precondition a surface shows is the sentence the act would use.
 */
export function uploadOf(
  store: AssetStore,
  req: UploadRequest & { bytes: Uint8Array },
): { ok: false; code: string; reason: string } | { ok: true; plan: UploadPlan } {
  const refusal = baseRefusal(store.base);
  if (refusal) return { ok: false, code: 'BASE_UNAVAILABLE', reason: refusal };

  const name = basename(req.file);
  const ext = imageExt(req.bytes);
  if (!ext) {
    return {
      ok    : false,
      code  : 'NOT_AN_IMAGE',
      reason: `${name} is not a PNG, JPEG, GIF or WebP — an image model can only be shown an image.`,
    };
  }
  // The marker is what keeps mock art out of a real run. Refusing here means the author hears
  // about it at the file picker rather than as a provider error mid-run.
  if (isPlaceholderImage(req.bytes)) {
    return {
      ok    : false,
      code  : 'MOCK_PLACEHOLDER',
      reason: `${name} is a placeholder from a mock run. A real image backend refuses those as references, so it cannot be used as one.`,
    };
  }

  const hash = sha256(req.bytes);
  const known = store.has(hash);
  return {
    ok  : true,
    plan: {
      ext,
      // An upload has no task node, so this is the hash of the request instead — the same shape
      // a concept uses, so `sourceTask` still says what made the asset
      sourceTask: hashParts('upload', { file: name, bytes: hash }),
      title     : (req.title ?? '').trim() || fileTitle(req.file),
      known,
      note: known
        ? `${name} is already in the store as ${hash.slice(0, 8)}; the upload records it again under the same bytes.`
        : `Would bring ${name} into the base asset store as a reference image. It is never approved and never planned — it is only ever something to point a prompt at.`,
    },
  };
}

/**
 * Read a file and record it as a `reference` asset.
 *
 * It goes to the base root beside the authored art rather than into `vngen/build`, and acceptance
 * never applies, because the author chose the file and there is no generation to approve.
 * Re-uploading identical bytes is idempotent, since bytes are content-addressed.
 */
export async function uploadReference(
  deps: { store: AssetStore },
  req: UploadRequest,
): Promise<UploadResult> {
  const bytes = new Uint8Array(await readFile(req.file));
  const decided = uploadOf(deps.store, { ...req, bytes });
  if (!decided.ok) throw new VnError(decided.code, decided.reason);
  const { ext, sourceTask, title, known } = decided.plan;

  const ref = await deps.store.write(bytes, ext, {
    kind: 'reference',
    sourceTask,
    refs   : [],
    // No model drew it, and the field is required
    modelId: 'upload',
    title,
  });
  return { ref, title, stored: deps.store.pathOf(ref), known };
}
