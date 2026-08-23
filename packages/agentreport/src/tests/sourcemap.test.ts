import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { denied, normalize, readableSourcePath, sourceRoot, textFile } from '../sourcemap.js';

const fixture = async (): Promise<string> => {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vn-sourcemap-')));
  await fs.mkdir(join(dir, 'tree', 'packages'), { recursive: true });
  await fs.writeFile(join(dir, 'tree', 'CLAUDE.md'), '# map\n', 'utf8');
  await fs.mkdir(join(dir, 'tree', 'packages', 'x', 'src'), { recursive: true });
  await fs.mkdir(join(dir, 'elsewhere'), { recursive: true });
  return dir;
};

describe('normalize', () => {
  it('speaks one form of path whichever separator arrived', () => {
    expect(normalize('apps\\desktop\\src')).toBe('apps/desktop/src');
    expect(normalize('./docs/index.md')).toBe('docs/index.md');
    expect(normalize('packages/')).toBe('packages');
  });
});

describe('denied', () => {
  it('denies a one-segment name wherever it nests', () => {
    expect(denied('packages/x/node_modules/y/index.js')).toBe(true);
    expect(denied('apps/desktop/dist/main.cjs')).toBe(true);
    expect(denied('.git/config')).toBe(true);
    expect(denied('keys/gemini.txt')).toBe(true);
  });

  it('does not deny a name that merely starts the same way', () => {
    expect(denied('packages/distant/src/a.ts')).toBe(false);
    expect(denied('apps/keystore/src/a.ts')).toBe(false);
  });

  it('denies a multi-segment place as a prefix, not segment by segment', () => {
    expect(denied('vendor/path.ux/scripts/lib/pathux.js')).toBe(true);
    expect(denied('scripts/vn-cdp.mjs')).toBe(false);
    expect(denied('packages/util/src/lib/a.ts')).toBe(false);
  });

  // The packaging script copies this manifest into the installer, so an undenied build directory
  // would put the previous run's app image inside the next run's
  it("denies the desktop app's own build and dev output", () => {
    expect(denied('apps/desktop/.package/source/CLAUDE.md')).toBe(true);
    expect(denied('apps/desktop/release/win-unpacked/resources/app.asar')).toBe(true);
    expect(denied('apps/desktop/.vndesktop/project.yaml')).toBe(true);
    expect(denied('apps/desktop/.turbo/turbo-build.log')).toBe(true);
    expect(denied('apps/desktop/src/main/index.ts')).toBe(false);
  });
});

describe('readableSourcePath', () => {
  it('admits the roots this build ships for reading', () => {
    expect(readableSourcePath('packages/store/src/docfile.ts')).toBe(true);
    expect(readableSourcePath('apps/desktop/src/main/index.ts')).toBe(true);
    expect(readableSourcePath('docs/index.md')).toBe(true);
    expect(readableSourcePath('CLAUDE.md')).toBe(true);
    expect(readableSourcePath('package.json')).toBe(true);
  });

  it('refuses anything outside them, and anything denied inside them', () => {
    expect(readableSourcePath('vngen/build/assets/a.png')).toBe(false);
    expect(readableSourcePath('vendor/path.ux/README.md')).toBe(false);
    expect(readableSourcePath('packages/x/node_modules/y.ts')).toBe(false);
  });

  it('refuses an escape and the empty path', () => {
    expect(readableSourcePath('../secrets.txt')).toBe(false);
    expect(readableSourcePath('')).toBe(false);
  });
});

describe('textFile', () => {
  it('takes what is worth handing a model, whatever the case', () => {
    expect(textFile('index.ts')).toBe(true);
    expect(textFile('PLAN.MD')).toBe(true);
    expect(textFile('project.yaml')).toBe(true);
  });

  it('leaves binaries and build blobs alone', () => {
    expect(textFile('portrait.png')).toBe(false);
    expect(textFile('app.exe')).toBe(false);
  });
});

describe('sourceRoot', () => {
  const saved = process.env.VN_SOURCE_ROOT;
  let dir = '';

  beforeAll(async () => {
    dir = await fixture();
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.VN_SOURCE_ROOT;
    else process.env.VN_SOURCE_ROOT = saved;
    await fs.rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.VN_SOURCE_ROOT;
  });

  it('takes the override first', async () => {
    process.env.VN_SOURCE_ROOT = join(dir, 'tree');
    expect(await sourceRoot(join(dir, 'elsewhere'))).toBe(join(dir, 'tree'));
  });

  it('ignores an override that is not a source tree', async () => {
    process.env.VN_SOURCE_ROOT = join(dir, 'elsewhere');
    expect(await sourceRoot(join(dir, 'elsewhere'))).toBeUndefined();
  });

  it('walks up from the hint to the tree that has both markers', async () => {
    expect(await sourceRoot(join(dir, 'tree', 'packages', 'x', 'src'))).toBe(join(dir, 'tree'));
  });

  it('says nothing rather than guessing when there is no source tree above', async () => {
    expect(await sourceRoot(join(dir, 'elsewhere'))).toBeUndefined();
  });

  it('finds this checkout from its own directory', async () => {
    expect(await sourceRoot()).toBeDefined();
  });
});
