/**
 * The host's pixel work for generation graphs, over jimp: pure JavaScript, so the desktop shell
 * and the CLI carry no native binding, and it reads and writes PNG and JPEG, which are the two
 * formats the image backends answer in. It lives here rather than in `@vn/gengraph` because the
 * renderer imports that package's entry point and must not load an image codec.
 */
import { Jimp, defaultFormats } from 'jimp';
import type { GenImageInput, GenPixelService, PixelRect } from '@vn/gengraph';

type Mime = 'image/png' | 'image/jpeg';

/** The mime jimp encodes an extension as; anything else is written back as PNG. */
const MIME: Record<string, Mime> = {
  png : 'image/png',
  jpg : 'image/jpeg',
  jpeg: 'image/jpeg',
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** jimp's codecs by mime, instantiated once. */
const FORMATS = new Map(defaultFormats.map((make) => make()).map((f) => [f.mime, f]));

/**
 * What the bytes are, read from their magic number. Decided here rather than by jimp's own
 * sniffing, which loads `file-type` through a dynamic import, and a CommonJS host running
 * without ESM support in its VM (jest, for one) refuses that import.
 */
function mimeOf(bytes: Uint8Array): Mime {
  const starts = (magic: readonly number[]): boolean => magic.every((b, i) => bytes[i] === b);
  if (starts(PNG_MAGIC)) return 'image/png';
  if (starts(JPEG_MAGIC)) return 'image/jpeg';
  throw new Error(
    'the picture is neither a PNG nor a JPEG, which are the two formats a crop reads',
  );
}

/** A fraction of a length in whole pixels, at least one so a sliver never becomes an empty crop. */
function px(fraction: number, length: number): number {
  return Math.max(1, Math.round(fraction * length));
}

/**
 * Cuts the rectangle out of the picture and re-encodes it. The rectangle is clamped to the
 * picture's edge after rounding, since a cell at the right or bottom edge can round one pixel
 * past it.
 */
export async function cropImage(
  bytes: Uint8Array,
  ext: string,
  rect: PixelRect,
): Promise<GenImageInput> {
  const codec = FORMATS.get(mimeOf(bytes));
  if (codec === undefined) {
    throw new Error('jimp was built without the codec for this picture');
  }
  const image = Jimp.fromBitmap(await codec.decode(Buffer.from(bytes)));
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const x = Math.min(width - 1, Math.round(rect.x * width));
  const y = Math.min(height - 1, Math.round(rect.y * height));
  const w = Math.min(width - x, px(rect.w, width));
  const h = Math.min(height - y, px(rect.h, height));
  image.crop({ x, y, w, h });

  const mime = MIME[ext.toLowerCase()] ?? 'image/png';
  const out = await image.getBuffer(mime);
  return { bytes: new Uint8Array(out), ext: mime === 'image/jpeg' ? 'jpg' : 'png' };
}

/** The pixel service the real host hands every graph. */
export const pixelService: GenPixelService = { crop: cropImage };
