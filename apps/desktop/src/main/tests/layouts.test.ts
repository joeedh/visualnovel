import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { LAYOUT_ATTRIBUTE, shippedLayoutFile } from '../../shared/layouts.js';
import {
  ensureLayoutAttributes,
  ensureLayouts,
  listLayouts,
  readLayout,
  resetLayouts,
  writeLayout,
} from '../layouts.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vn-layouts-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ensureLayouts', () => {
  it('writes both shipped layouts and the merge policy', async () => {
    const written = await ensureLayouts(root);
    expect(written).toEqual([
      '.vnstudio/layouts/writing.json',
      '.vnstudio/layouts/art.json',
      '.gitattributes',
    ]);
    expect(await readFile(join(root, '.gitattributes'), 'utf8')).toContain(LAYOUT_ATTRIBUTE);
  });

  it('writes nothing the second time', async () => {
    await ensureLayouts(root);
    expect(await ensureLayouts(root)).toEqual([]);
  });

  it('leaves a layout the author edited alone', async () => {
    await ensureLayouts(root);
    const path = join(root, '.vnstudio/layouts/writing.json');
    await writeFile(path, JSON.stringify({ ...shippedLayoutFile('writing')!, title: 'Mine' }));

    await ensureLayouts(root);
    expect(JSON.parse(await readFile(path, 'utf8')).title).toBe('Mine');
  });

  it('appends to a .gitattributes the author wrote, and only once', async () => {
    await writeFile(join(root, '.gitattributes'), '*.png binary\n');
    await ensureLayouts(root);
    await ensureLayouts(root);

    const text = await readFile(join(root, '.gitattributes'), 'utf8');
    expect(text).toContain('*.png binary');
    expect(text.split(LAYOUT_ATTRIBUTE)).toHaveLength(2);
  });

  // Writes only the rule layouts need. This repo's own `* text=auto eol=lf` is a policy for this
  // repo, not one to install in somebody's project.
  it('creates a .gitattributes carrying the layout rule and nothing else', async () => {
    await ensureLayoutAttributes(root);
    const text = await readFile(join(root, '.gitattributes'), 'utf8');
    expect(text).toContain(LAYOUT_ATTRIBUTE);
    expect(text).not.toContain('text=auto');
  });
});

describe('listLayouts', () => {
  it('lists both shipped layouts before anything is on disk', async () => {
    const found = await listLayouts(root);
    expect(found.map((entry) => entry.slug)).toEqual(['writing', 'art']);
    expect(found.every((entry) => entry.source === 'shipped')).toBe(true);
    expect(found.every((entry) => entry.problem === undefined)).toBe(true);
  });

  it('shadows a shipped layout with the file rather than listing it twice', async () => {
    await ensureLayouts(root);
    await writeLayout(root, { ...shippedLayoutFile('writing')!, title: 'Mine' });

    const found = await listLayouts(root);
    expect(found.filter((entry) => entry.slug === 'writing')).toHaveLength(1);
    expect(found[0]?.title).toBe('Mine');
  });

  it('puts an author layout after the shipped ones, once', async () => {
    await ensureLayouts(root);
    await writeLayout(root, {
      ...shippedLayoutFile('art')!,
      slug: 'my_desk',
      title: 'My Desk',
      source: 'saved',
    });

    expect((await listLayouts(root)).map((entry) => entry.slug)).toEqual([
      'writing',
      'art',
      'my_desk',
    ]);
  });

  it('says why an unreadable layout cannot be used, and still lists it', async () => {
    await ensureLayouts(root);
    await writeFile(join(root, '.vnstudio/layouts/art.json'), 'not json');

    const art = (await listLayouts(root)).find((entry) => entry.slug === 'art');
    expect(art?.problem).toContain('not valid JSON');
    expect(art?.title).toBe('Art');
  });

  it('fingerprints by content, so an edit moves it and a rewrite does not', async () => {
    await ensureLayouts(root);
    const before = (await listLayouts(root))[0]!.fingerprint;

    await ensureLayouts(root);
    expect((await listLayouts(root))[0]!.fingerprint).toBe(before);

    await writeLayout(root, { ...shippedLayoutFile('writing')!, title: 'Mine' });
    expect((await listLayouts(root))[0]!.fingerprint).not.toBe(before);
  });
});

describe('readLayout', () => {
  it('answers for a shipped layout with no file, from the recipe', async () => {
    const read = await readLayout(root, 'writing');
    expect(read.ok && read.file.title).toBe('Writing');
    expect(read.ok && read.file.recipe).toBeDefined();
  });

  it('refuses a layout that is not there, by name', async () => {
    expect(await readLayout(root, 'nosuch')).toEqual({
      ok: false,
      reason: 'there is no nosuch layout in this project',
    });
  });

  it('refuses an unreadable file, naming the file and the fault', async () => {
    await ensureLayouts(root);
    await writeFile(join(root, '.vnstudio/layouts/art.json'), '{');

    const read = await readLayout(root, 'art');
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toContain('.vnstudio/layouts/art.json cannot be read');
  });
});

describe('resetLayouts', () => {
  it('rewrites the shipped layouts byte-identically and leaves the author’s alone', async () => {
    await ensureLayouts(root);
    await writeLayout(root, {
      ...shippedLayoutFile('art')!,
      slug: 'my_desk',
      title: 'My Desk',
      source: 'saved',
    });

    const pristine = await readFile(join(root, '.vnstudio/layouts/writing.json'), 'utf8');
    await writeLayout(root, { ...shippedLayoutFile('writing')!, title: 'Wrecked' });

    const written = await resetLayouts(root, 'shipped');
    expect(written).toEqual(['.vnstudio/layouts/writing.json', '.vnstudio/layouts/art.json']);
    expect(await readFile(join(root, '.vnstudio/layouts/writing.json'), 'utf8')).toBe(pristine);
    expect((await listLayouts(root)).map((entry) => entry.slug)).toContain('my_desk');
  });

  it('clears the author’s layouts only when asked for all of them', async () => {
    await ensureLayouts(root);
    await writeLayout(root, {
      ...shippedLayoutFile('art')!,
      slug: 'my_desk',
      title: 'My Desk',
      source: 'saved',
    });

    await resetLayouts(root, 'all');
    expect((await listLayouts(root)).map((entry) => entry.slug)).toEqual(['writing', 'art']);
  });
});

/** Raw git, for the subcommands `Git` deliberately does not expose (branching, merging). */
function runGit(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, windowsHide: true }, (err) =>
      resolve(
        err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err
            ? 1
            : 0,
      ),
    );
  });
}

// Checks the `-merge` attribute against real git rather than assuming it works.
describe('the merge policy', () => {
  it('makes git conflict a layout instead of merging one, and leaves ours in the worktree', async () => {
    await runGit(['init', '-b', 'main']);
    await runGit(['config', 'user.email', 'test@example.com']);
    await runGit(['config', 'user.name', 'Test']);
    await runGit(['config', 'core.autocrlf', 'false']);

    await ensureLayouts(root);
    await runGit(['add', '-A']);
    await runGit(['commit', '-m', 'base']);

    const path = '.vnstudio/layouts/writing.json';
    const mine = { ...shippedLayoutFile('writing')!, title: 'Mine' };
    const theirs = { ...shippedLayoutFile('writing')!, title: 'Theirs' };

    await runGit(['checkout', '-b', 'other']);
    await writeLayout(root, theirs);
    await runGit(['add', '-A']);
    await runGit(['commit', '-m', 'theirs']);

    await runGit(['checkout', 'main']);
    await writeLayout(root, mine);
    await runGit(['add', '-A']);
    await runGit(['commit', '-m', 'mine']);

    expect(await runGit(['merge', 'other'])).not.toBe(0);

    // Git reports `UU` when both sides changed the file and it merged neither.
    const status = await openGit(root).status();
    const entry = status.entries.find((item) => item.path === path);
    expect(entry && `${entry.x}${entry.y}`).toBe('UU');

    // The file was never three-way merged; it still holds exactly our own side, unmangled.
    const text = await readFile(join(root, path), 'utf8');
    expect(text).not.toContain('<<<<<<<');
    expect(JSON.parse(text).title).toBe('Mine');

    // The worktree still holds our own side, so that is what the app opens.
    const read = await readLayout(root, 'writing');
    expect(read.ok && read.file.title).toBe('Mine');
  }, 30000);
});
