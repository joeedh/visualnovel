import { imageMime } from '../backends/mime.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

describe('imageMime', () => {
  it('trusts the bytes over an ext that guessed wrong', () => {
    expect(imageMime({ bytes: JPEG, ext: 'png' })).toBe('image/jpeg');
    expect(imageMime({ bytes: PNG, ext: 'jpg' })).toBe('image/png');
    expect(imageMime({ bytes: WEBP, ext: 'png' })).toBe('image/webp');
  });

  it('falls back to the ext when the bytes match no known magic', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(imageMime({ bytes, ext: 'JPEG' })).toBe('image/jpeg');
    expect(imageMime({ bytes, ext: 'bmp' })).toBe('image/png');
    expect(imageMime({ bytes: new Uint8Array(), ext: 'webp' })).toBe('image/webp');
  });
});
