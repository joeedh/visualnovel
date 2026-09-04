import { assetThumbUrl, galleryItem, loadAssetThumb } from '../assetthumb.js';
import type { AssetListing } from '../../../../src/shared/ipc.js';

const listing = (over: Partial<AssetListing> = {}): AssetListing => ({
  hash: 'a'.repeat(64),
  ext: 'png',
  kind: 'portrait',
  label: 'Aiko',
  accepted: false,
  ...over,
});

/** Stands in for the two browser globals the loader reaches for. */
function stubBrowser(response: { ok: boolean; status: number }) {
  const decoded: unknown[] = [];
  const globals = globalThis as unknown as {
    fetch: unknown;
    createImageBitmap: unknown;
  };
  const before = { fetch: globals.fetch, createImageBitmap: globals.createImageBitmap };

  globals.fetch = jest.fn(async () => ({ ...response, blob: async () => 'blob' }));
  globals.createImageBitmap = jest.fn(async (_blob: unknown, options: unknown) => {
    decoded.push(options);
    return { width: 256, height: 256 };
  });

  return {
    decoded,
    restore: () => {
      globals.fetch = before.fetch;
      globals.createImageBitmap = before.createImageBitmap;
    },
  };
}

describe('assetThumbUrl', () => {
  it('addresses the stored bytes by hash and extension', () => {
    expect(assetThumbUrl('deadbeef', 'webp')).toBe('vnasset://deadbeef.webp');
  });
});

describe('loadAssetThumb', () => {
  it('decodes down to thumbnail width rather than at full resolution', async () => {
    const stub = stubBrowser({ ok: true, status: 200 });
    try {
      const bitmap = await loadAssetThumb('deadbeef', 'png');
      expect(bitmap.width).toBe(256);
      expect(stub.decoded).toEqual([{ resizeWidth: 256, resizeQuality: 'high' }]);
    } finally {
      stub.restore();
    }
  });

  // A missing hash answers 404 with a body that is not an image, so the decoder would report it as
  // a corrupt picture. The response is checked first so the error names the real problem.
  it('refuses a hash the store has no bytes for', async () => {
    const stub = stubBrowser({ ok: false, status: 404 });
    try {
      await expect(loadAssetThumb('deadbeef', 'png')).rejects.toThrow(
        'No stored bytes for deadbeef.png (404).',
      );
    } finally {
      stub.restore();
    }
  });
});

describe('galleryItem', () => {
  it('keys on the hash and shows the name the document tree shows', () => {
    const item = galleryItem(listing());
    expect(item.id).toBe('a'.repeat(64));
    expect(item.label).toBe('Aiko');
    expect(item.tooltip).toBe('Aiko — portrait');
  });

  it('searches over the kind, the slot it fills and its approval', () => {
    expect(galleryItem(listing()).searchTags).toEqual(['portrait']);
    expect(galleryItem(listing({ slot: 'plate:cafe/night', accepted: true })).searchTags).toEqual([
      'portrait',
      'plate:cafe/night',
      'accepted',
    ]);
  });

  it('leaves the image undecoded until the thumbnail is asked for', () => {
    const stub = stubBrowser({ ok: true, status: 200 });
    try {
      const item = galleryItem(listing());
      expect(typeof item.image).toBe('function');
      expect(stub.decoded).toEqual([]);
    } finally {
      stub.restore();
    }
  });
});
