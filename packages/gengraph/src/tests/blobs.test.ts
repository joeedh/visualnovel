import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectPaths } from '@vn/store';

import {
  graphBlobDir,
  graphBlobStore,
  graphDocFile,
  graphJournalFile,
  graphLibDir,
} from '../state.js';

let root: string;
let paths: ProjectPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vn-gengraph-'));
  paths = new ProjectPaths(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('where a project keeps its graphs', () => {
  it('authors documents under work/ and records runs under state/', () => {
    expect(graphDocFile(paths, 'cafe')).toBe(join(root, 'vngen', 'work', 'graphs', 'cafe.json'));
    expect(graphLibDir(paths)).toBe(join(root, 'vngen', 'work', 'graphs', 'lib'));
    expect(graphJournalFile(paths, 'cafe')).toBe(
      join(root, 'vngen', 'state', 'graphs', 'cafe.jsonl'),
    );
    expect(graphBlobDir(paths, 'cafe')).toBe(join(root, 'vngen', 'state', 'graphs', 'cafe'));
  });
});

describe('the blob store', () => {
  it('round-trips bytes through their content hash', async () => {
    const store = graphBlobStore(paths, 'cafe');
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10]);

    const ref = await store.write(bytes, 'png');
    expect(ref.ext).toBe('png');

    expect(await store.read(ref.hash)).toEqual(bytes);
  });

  it('gives the same reference to the same bytes twice', async () => {
    const store = graphBlobStore(paths, 'cafe');
    const bytes = new Uint8Array([1, 2, 3]);

    const first = await store.write(bytes, 'png');
    const second = await store.write(bytes, 'png');

    expect(second.hash).toBe(first.hash);
  });

  it('reads nothing for a hash it never wrote', async () => {
    const store = graphBlobStore(paths, 'cafe');
    await store.write(new Uint8Array([1]), 'png');

    expect(await store.read('0'.repeat(64))).toBeUndefined();
  });

  it('reads nothing at all before the graph has run', async () => {
    expect(await graphBlobStore(paths, 'cafe').read('0'.repeat(64))).toBeUndefined();
  });

  it('keeps one graph out of another graph blob directory', async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const ref = await graphBlobStore(paths, 'cafe').write(bytes, 'png');

    expect(await graphBlobStore(paths, 'street').read(ref.hash)).toBeUndefined();
  });
});
