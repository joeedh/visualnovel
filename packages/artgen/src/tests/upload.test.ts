/**
 * Ingesting outside bytes as a `reference` asset (`docs/plans/archive/chunked-prompts.md` §15).
 *
 * Two properties need a real store. The bytes land in the base root, beside the authored art. Two
 * kinds of file are refused: one that is not an image, and mock art, which a real backend rejects
 * as a reference and which must therefore never reach a run.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeProject, SCRIPTS } from '@vn/testkit';
import { placeholderPng } from '@vn/providers';
import { hashParts, sha256 } from '@vn/util';
import { imageExt, uploadOf, uploadReference } from '../index.js';

/** A small valid PNG carrying no mock marker. */
function realPng(tint: number): Uint8Array {
  const png = placeholderPng('00112233');
  const bytes = new Uint8Array(png);
  // Overwrite the placeholder's `tEXt` keyword, so these are real-looking bytes with no marker.
  const marker = new TextEncoder().encode('vn-mock-placeholder');
  for (let i = 0; i + marker.length <= 128; i++) {
    if (marker.every((b, k) => bytes[i + k] === b)) {
      bytes.fill(0x61, i, i + marker.length);
      break;
    }
  }
  bytes[bytes.length - 1] = tint;
  return bytes;
}

describe('imageExt', () => {
  it('reads the format out of the bytes, never the filename', () => {
    expect(imageExt(realPng(1))).toBe('png');
    expect(imageExt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(imageExt(new TextEncoder().encode('not an image at all'))).toBeUndefined();
  });
});

describe('uploadReference', () => {
  it('writes to the base root, unaccepted, with a synthesized sourceTask', async () => {
    const p = await makeProject({ script: SCRIPTS.branching });
    try {
      const file = join(p.dir, 'moodboard.png');
      const bytes = realPng(7);
      await writeFile(file, bytes);
      const { store } = await p.reload();

      const { ref, title } = await uploadReference({ store }, { file });
      const reopened = (await p.reload()).store;
      const asset = reopened.manifest().find((a) => a.hash === ref.hash)!;

      expect(asset.kind).toBe('reference');
      expect(asset.accepted).toBe(false);
      expect(asset.sourceTask).toBe(
        hashParts('upload', { file: 'moodboard.png', bytes: sha256(bytes) }),
      );
      expect(title).toBe('moodboard');
      // The base root, beside the authored art — not `vngen/build`.
      expect(reopened.pathOf(ref).replace(/\\/g, '/')).toContain('/assets/objects/');
      expect(reopened.pathOf(ref).replace(/\\/g, '/')).not.toContain('/vngen/');
    } finally {
      await p.cleanup();
    }
  });

  it('is idempotent over identical bytes, and says so before writing', async () => {
    const p = await makeProject({ script: SCRIPTS.branching });
    try {
      const file = join(p.dir, 'board.png');
      await writeFile(file, realPng(9));
      const { store } = await p.reload();

      const first = await uploadReference({ store }, { file });
      expect(first.known).toBe(false);
      const again = await uploadReference({ store }, { file, title: 'Board' });
      expect(again.ref.hash).toBe(first.ref.hash);
      expect(again.known).toBe(true);
    } finally {
      await p.cleanup();
    }
  });

  it('refuses bytes that are not an image', async () => {
    const p = await makeProject({ script: SCRIPTS.branching });
    try {
      const { store } = await p.reload();
      const decided = uploadOf(store, {
        file: 'notes.png',
        bytes: new TextEncoder().encode('# just some notes'),
      });
      expect(decided.ok).toBe(false);
      if (!decided.ok) expect(decided.code).toBe('NOT_AN_IMAGE');
    } finally {
      await p.cleanup();
    }
  });

  // The marker is what keeps mock art out of a real run, and an upload is the only way bytes
  // enter the store without passing through a provider
  it('refuses mock-marked bytes, naming why', async () => {
    const p = await makeProject({ script: SCRIPTS.branching });
    try {
      const { store } = await p.reload();
      const decided = uploadOf(store, { file: 'shot.png', bytes: placeholderPng('deadbeef') });
      expect(decided.ok).toBe(false);
      if (!decided.ok) {
        expect(decided.code).toBe('MOCK_PLACEHOLDER');
        expect(decided.reason).toContain('placeholder');
      }
    } finally {
      await p.cleanup();
    }
  });
});
