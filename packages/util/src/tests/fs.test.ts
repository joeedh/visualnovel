import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../fs.js';

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-fs-'));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

describe('writeFileAtomic', () => {
  it('leaves no temp sibling behind, on the happy path or a failed one', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = join(dir, 'scene.md');
      await writeFileAtomic(file, 'hello');
      expect(await fs.readFile(file, 'utf8')).toBe('hello');
      expect(await fs.readdir(dir)).toEqual(['scene.md']);

      // A rename onto a directory fails, which is the shape of failure the `finally` is for: the
      // temp is written and the rename does not happen.
      const blocked = join(dir, 'taken');
      await fs.mkdir(join(blocked, 'inside'), { recursive: true });
      await expect(writeFileAtomic(blocked, 'nope')).rejects.toThrow();
      expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(['scene.md', 'taken']));
      expect((await fs.readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('gives two concurrent writers of the same path their own temp file', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      // Same path, same data length — the case the old sha1(path + length) suffix collided on,
      // so one writer's rename pulled the file out from under the other's.
      const file = join(dir, 'scene.md');
      await Promise.all([writeFileAtomic(file, 'aaaaa'), writeFileAtomic(file, 'bbbbb')]);
      expect(['aaaaa', 'bbbbb']).toContain(await fs.readFile(file, 'utf8'));
      expect(await fs.readdir(dir)).toEqual(['scene.md']);
    } finally {
      await cleanup();
    }
  });
});
