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

      // A rename onto a directory fails, so the temp is written and the rename does not happen,
      // which is the case the `finally` cleans up after
      const blocked = join(dir, 'taken');
      await fs.mkdir(join(blocked, 'inside'), { recursive: true });
      await expect(writeFileAtomic(blocked, 'nope')).rejects.toThrow();
      expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(['scene.md', 'taken']));
      expect((await fs.readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('retries a rename refused by a transient lock, and succeeds when it lifts', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      // On Windows antivirus or a watcher holds the destination open for a few milliseconds and
      // the rename comes back EPERM, though both paths are fine
      const file = join(dir, 'scene.md');
      const real = fs.rename.bind(fs);
      let refusals = 2;
      const spy = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (refusals > 0) {
          refusals--;
          const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        return real(from, to);
      });
      try {
        await writeFileAtomic(file, 'held then released');
        expect(await fs.readFile(file, 'utf8')).toBe('held then released');
        expect(spy).toHaveBeenCalledTimes(3);
      } finally {
        spy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  it('gives up after bounded attempts when the lock never lifts, leaving no temp', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = join(dir, 'scene.md');
      const spy = jest.spyOn(fs, 'rename').mockImplementation(async () => {
        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });
      try {
        await expect(writeFileAtomic(file, 'never lands')).rejects.toThrow('EPERM');
        expect(spy).toHaveBeenCalledTimes(5);
      } finally {
        spy.mockRestore();
      }
      expect((await fs.readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('gives two concurrent writers of the same path their own temp file', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      // Same path, same data length is the case the old sha1(path + length) suffix collided on,
      // where one writer's rename moved the shared temp file out from under the other
      const file = join(dir, 'scene.md');
      await Promise.all([writeFileAtomic(file, 'aaaaa'), writeFileAtomic(file, 'bbbbb')]);
      expect(['aaaaa', 'bbbbb']).toContain(await fs.readFile(file, 'utf8'));
      expect(await fs.readdir(dir)).toEqual(['scene.md']);
    } finally {
      await cleanup();
    }
  });
});
