import { promises as fs } from 'node:fs';

import type { ProjectPaths } from '@vn/store';
import { exists, join, sha256, writeFileAtomic } from '@vn/util';

import { graphBlobDir, graphBlobFile } from './paths.js';
import type { GenBlobRef, GenBlobService } from './services.js';

/**
 * A graph's blob store, one file per content hash under `state/graphs/<slug>/`.
 * Addressing by content means a re-run that produces identical bytes costs no disk and
 * writes nothing, and it is what lets a journal record name a picture in a few bytes.
 */
export function graphBlobStore(paths: ProjectPaths, slug: string): GenBlobService {
  const dir = graphBlobDir(paths, slug);

  return {
    async read(hash: string): Promise<Uint8Array | undefined> {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw err;
      }

      // The extension is part of the file name rather than of the hash, so a read that
      // was handed only a hash finds the name instead of deriving it.
      const name = names.find((n) => n.startsWith(`${hash}.`));
      if (name === undefined) {
        return undefined;
      }

      const bytes = await fs.readFile(join(dir, name));
      // A Buffer is a Uint8Array, but it serializes differently across an IPC boundary
      // and compares differently in a test, so the store hands back a plain view of it.
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },

    async write(bytes: Uint8Array, ext: string): Promise<GenBlobRef> {
      const ref: GenBlobRef = { hash: sha256(bytes), ext };
      const path = graphBlobFile(paths, slug, ref);

      if (!(await exists(path))) {
        await writeFileAtomic(path, bytes);
      }
      return ref;
    },
  };
}
