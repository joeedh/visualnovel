/**
 * The host's crop, which the Crop node reaches through `GenServices.pixels`. A rectangle is
 * named in fractions, so the same graph cuts the same cell out of a sheet whatever size the
 * model drew it at.
 */
import { defaultFormats } from 'jimp';
import { placeholderPng } from '@vn/providers';

import { cropImage } from '../pixels.js';

const codecs = defaultFormats.map((make) => make());

/** Decoded with the codec the magic number names, as `cropImage` itself decodes. */
async function sizeOf(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const png = bytes[0] === 0x89;
  const codec = codecs.find((c) => c.mime === (png ? 'image/png' : 'image/jpeg'))!;
  const bitmap = await codec.decode(Buffer.from(bytes));
  return { width: bitmap.width, height: bitmap.height };
}

describe('cropImage', () => {
  it('cuts the named fraction of the picture, in whole pixels', async () => {
    const whole = await sizeOf(placeholderPng('seed'));
    const cut = await cropImage(placeholderPng('seed'), 'png', { x: 0.5, y: 0, w: 0.5, h: 0.5 });

    expect(cut.ext).toBe('png');
    expect(await sizeOf(cut.bytes)).toEqual({
      width : whole.width / 2,
      height: whole.height / 2,
    });
  });

  it('keeps at least one pixel each way, so a sliver never becomes an empty picture', async () => {
    const cut = await cropImage(placeholderPng('seed'), 'png', {
      x: 0.99,
      y: 0.99,
      w: 0.001,
      h: 0.001,
    });
    expect(await sizeOf(cut.bytes)).toEqual({ width: 1, height: 1 });
  });

  it('writes a JPEG back as a JPEG and anything unfamiliar as PNG', async () => {
    const asJpg = await cropImage(placeholderPng('seed'), 'jpg', { x: 0, y: 0, w: 1, h: 1 });
    const asPng = await cropImage(placeholderPng('seed'), 'webp', { x: 0, y: 0, w: 1, h: 1 });

    expect(asJpg.ext).toBe('jpg');
    expect(asPng.ext).toBe('png');
  });
});
