import type { ImageInput } from '../backend.js';

const BY_EXT: Record<string, string> = {
  png : 'image/png',
  jpg : 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const MAGIC: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  // RIFF....WEBP: bytes 4–7 are the chunk size, so only the two fixed runs are matched
  ['image/webp', [0x52, 0x49, 0x46, 0x46]],
];

const WEBP_TAG = [0x57, 0x45, 0x42, 0x50];

/**
 * The media type a request declares for an image. Decided from the bytes' magic number, and
 * from `ext` only when they match none, because an `ext` rebuilt from a bare hash can say png
 * over jpeg bytes and every vision vendor rejects the mismatch.
 */
export function imageMime(img: ImageInput): string {
  const at = (offset: number, magic: readonly number[]): boolean =>
    magic.every((b, i) => img.bytes[offset + i] === b);
  for (const [mime, magic] of MAGIC) {
    if (!at(0, magic)) continue;
    if (mime === 'image/webp' && !at(8, WEBP_TAG)) continue;
    return mime;
  }
  return BY_EXT[img.ext.toLowerCase()] ?? 'image/png';
}
