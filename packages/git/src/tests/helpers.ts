import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git, openGit } from '../index.js';

/** A temp repository with a fixed identity, so no global config reaches the test. */
export async function tempRepo(): Promise<{ git: Git; dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-git-'));
  const git = openGit(dir);
  await git.init();
  await git.config('user.email', 'test@example.com');
  await git.config('user.name', 'Test');
  // Byte-exact line endings, so a blob read back equals what was written on Windows
  await git.config('core.autocrlf', 'false');
  return { git, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

export const write = (dir: string, name: string, body: string | Buffer): Promise<void> =>
  fs.writeFile(join(dir, name), body);

/** Runs git directly, for the verbs the wrapper does not expose yet (rebase, remote). */
export function sh(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}
