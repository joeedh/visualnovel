/**
 * Turn a built `apps/desktop` into an installer.
 *
 * The one non-obvious step is why electron-builder is not simply run against `apps/desktop`.
 * pnpm's `node_modules` is a farm of symlinks into a content-addressed store; electron-builder
 * copies a module tree into the app image and does not reliably reproduce that layout. The
 * failure it produces is the worst kind — the app installs, the window opens, and the first
 * `import('@anthropic-ai/sdk')` throws, which is *after* every smoke test that only checks for a
 * window. So this assembles a scratch project (`apps/desktop/.package/`) holding the bundle, the
 * shipped resources and a plain hoisted `node_modules`, and points electron-builder at that.
 *
 * Usage: `node scripts/package.desktop.mjs [--dir]` — `--dir` stops at the unpacked app, which
 * is what to use while iterating, since building the NSIS installer is the slow half.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from './aliases.mjs';

const APP = join(REPO_ROOT, 'apps', 'desktop');
const SCRATCH = join(APP, '.package');
const dirOnly = process.argv.includes('--dir');

const read = async (...parts) => JSON.parse(await readFile(join(...parts), 'utf8'));

/**
 * electron-builder needs the Electron version, not the Electron package: it downloads the
 * runtime into its own cache either way. Passing the version means the scratch install stays
 * two small packages rather than a second copy of Electron.
 */
async function electronVersion() {
  try {
    return (await read(APP, 'node_modules', 'electron', 'package.json')).version;
  } catch {
    throw new Error('electron is not installed in apps/desktop — run `pnpm install` first');
  }
}

const app = await read(APP, 'package.json');
if (app.version === '0.0.0') {
  throw new Error('apps/desktop/package.json is still 0.0.0; an installer needs a real version');
}

const dist = join(APP, 'dist', 'main', 'index.cjs');
try {
  await readFile(dist);
} catch {
  throw new Error(`no bundle at ${dist} — run \`pnpm --filter @vn/desktop build\` first`);
}

console.log(`[package] assembling ${SCRATCH}`);
await rm(SCRATCH, { recursive: true, force: true });
await mkdir(SCRATCH, { recursive: true });

// `name` rather than the workspace's `@vn/desktop`: Electron derives `app.getPath('userData')`
// from it, and a scoped name makes a directory nobody would recognise as this app.
await writeFile(
  join(SCRATCH, 'package.json'),
  JSON.stringify(
    {
      name: 'vnstudio',
      version: app.version,
      private: true,
      main: app.main,
      // electron-builder warns without one, and it is not ceremony: NSIS puts it in the
      // installer's own file properties, which is where Windows shows it during an install.
      description: app.description,
      author: 'Joe Eagar',
      license: 'UNLICENSED',
      // The whole runtime dependency tree. Everything else is bundled into `dist/`.
      dependencies: {
        '@anthropic-ai/sdk': app.dependencies['@anthropic-ai/sdk'],
        '@google/genai': app.dependencies['@google/genai'],
      },
    },
    null,
    2,
  ) + '\n',
);

await cp(join(APP, 'dist'), join(SCRATCH, 'dist'), { recursive: true });
await mkdir(join(SCRATCH, 'docs'), { recursive: true });
await cp(join(REPO_ROOT, 'docs', 'api-keys.md'), join(SCRATCH, 'docs', 'api-keys.md'));

// `--ignore-workspace` because the scratch tree sits inside the monorepo and pnpm would
// otherwise resolve against it; `hoisted` because that is the entire point of this directory.
console.log('[package] hoisted install of the two runtime dependencies');
execFileSync('pnpm', ['install', '--ignore-workspace', '--config.node-linker=hoisted'], {
  cwd: SCRATCH,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

console.log(`[package] electron-builder${dirOnly ? ' (unpacked only)' : ''}`);
execFileSync(
  'pnpm',
  [
    'exec',
    'electron-builder',
    ...(dirOnly ? ['--dir'] : []),
    '--config',
    join(APP, 'electron-builder.yml'),
    '--project',
    SCRATCH,
    `--config.electronVersion=${await electronVersion()}`,
    // Never from here. A release is uploaded by the release workflow, as a draft, by a human.
    '--publish',
    'never',
  ],
  { cwd: APP, stdio: 'inherit', shell: process.platform === 'win32' },
);

console.log(`[package] done — see ${join(APP, 'release')}`);
