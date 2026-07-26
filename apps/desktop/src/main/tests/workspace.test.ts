import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { seedWorkspace } from '../workspace.js';

/** A template shaped like `examples/sample`: authored inputs plus a previous run's output. */
async function makeTemplate(dir: string): Promise<void> {
  await mkdir(join(dir, 'characters', 'aiko'), { recursive: true });
  await mkdir(join(dir, 'screenplay'), { recursive: true });
  await mkdir(join(dir, 'vngen', 'build', 'assets'), { recursive: true });
  await mkdir(join(dir, 'keys'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'title: Sample\n');
  await writeFile(join(dir, 'characters', 'aiko', 'character.md'), '---\nid: aiko\n---\n');
  await writeFile(join(dir, 'screenplay', 'script.fountain'), '# arrival\n');
  await writeFile(join(dir, 'vngen', 'build', 'assets', 'deadbeef.png'), 'not really a png');
  await writeFile(join(dir, 'keys', 'gemini.key'), 'sk-secret');
}

describe('seedWorkspace', () => {
  let root: string;
  let template: string;
  let target: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-seed-'));
    template = join(root, 'sample');
    target = join(root, 'mySampleRepo');
    await makeTemplate(template);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('copies the authored inputs, leaves out output and secrets, and commits them', async () => {
    const result = await seedWorkspace(template, target);
    expect(result).toEqual({ root: target, seeded: true });

    expect((await readdir(target)).sort()).toEqual([
      '.git',
      'characters',
      'project.yaml',
      'screenplay',
    ]);
    expect(await readFile(join(target, 'project.yaml'), 'utf8')).toBe('title: Sample\n');

    // A fresh workspace has not been run: nothing may claim it has.
    const git = openGit(target);
    expect(await git.isRepo()).toBe(true);
    expect((await git.log()).map((c) => c.subject)).toEqual(['Sample project inputs']);
    expect((await git.status()).dirty).toBe(false);
  }, 20_000);

  it('opens an existing workspace untouched', async () => {
    await seedWorkspace(template, target);
    await writeFile(join(target, 'project.yaml'), 'title: Mine\n');

    const again = await seedWorkspace(template, target);
    expect(again).toEqual({ root: target, seeded: false });
    // Re-copying would silently discard a day's authoring, so it must not happen.
    expect(await readFile(join(target, 'project.yaml'), 'utf8')).toBe('title: Mine\n');
  }, 20_000);

  it('fails by name when there is no template to seed from', async () => {
    const missing = join(root, 'nope');
    await expect(seedWorkspace(missing, target)).rejects.toThrow(missing);
  });
});
