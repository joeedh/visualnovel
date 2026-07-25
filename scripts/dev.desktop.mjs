/**
 * One-command dev loop for the Electron desktop app. Runs the three moving parts
 * together so `pnpm --filter @vn/desktop dev` launches a live window:
 *
 *   1. esbuild --watch  — rebuilds the main + preload CJS bundles on change
 *      (`scripts/esbuild.desktop.mjs`; a restart picks up main-process edits).
 *   2. Vite dev server  — serves the renderer with HMR on a fixed port.
 *   3. Electron         — launched once the server answers, pointed at it via
 *      `VITE_DEV_SERVER_URL` (which `src/main/index.ts` loads instead of the built file).
 *
 * No extra dependencies: process orchestration is hand-rolled over `node:child_process`
 * and global `fetch`. Quitting Electron (or Ctrl-C) tears the whole tree down.
 *
 * Env: `VN_DEV_PORT` overrides the renderer port (default 5176); `VN_MOCK`/`VN_PROJECT`
 * pass straight through to the main process (mock sample project by default).
 * `VN_CDP_PORT` (default 9222 in this loop only) opens the remote-debugging port that
 * `scripts/vn-cdp.mjs` drives.
 *
 * Usage: `node scripts/dev.desktop.mjs`  (or `pnpm --filter @vn/desktop dev`)
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'apps/desktop');
const port = process.env.VN_DEV_PORT ?? '5176';
const devUrl = `http://localhost:${port}`;
const onWindows = process.platform === 'win32';

/** Spawned children, tracked so a single shutdown kills the whole tree. */
const children = [];
let shuttingDown = false;

/** Spawn a long-lived child, inheriting stdio so its logs interleave in this terminal. */
function run(cmd, args, extra = {}) {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: onWindows, ...extra });
  children.push(child);
  child.on('error', (err) => {
    process.stderr.write(`dev: failed to start ${cmd}: ${err.message}\n`);
    shutdown(1);
  });
  return child;
}

/** Poll the dev server until it answers (or give up), so Electron never loads a dead URL. */
async function waitForServer(url, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(url);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

/**
 * Kill every child before exiting. The teardown is SYNCHRONOUS (`spawnSync`) so the
 * orchestrator can't exit out from under a still-pending kill and orphan vite/esbuild.
 * On Windows the shell wrapper reparents the real process, so kill the whole tree (`/T`).
 */
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.pid == null || child.killed) continue;
    if (onWindows)
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 1 + 2: start the bundler watch and the renderer server side by side.
run('node', [resolve(root, 'scripts/esbuild.desktop.mjs'), '--watch'], { cwd: root });
run('pnpm', ['exec', 'vite', '--port', port, '--strictPort'], { cwd: desktop });

// 3: wait for the renderer, then launch Electron against it.
if (!(await waitForServer(devUrl))) {
  process.stderr.write(`dev: renderer never came up at ${devUrl}\n`);
  shutdown(1);
}
process.stdout.write(`dev: renderer up at ${devUrl} — launching Electron…\n`);
// The dev loop opts into CDP so `scripts/vn-cdp.mjs` works out of the box; a packaged app
// never opens the port unless the operator sets VN_CDP_PORT themselves.
const electron = run('pnpm', ['exec', 'electron', '.'], {
  cwd: desktop,
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: devUrl,
    VN_CDP_PORT: process.env.VN_CDP_PORT ?? '9222',
  },
});
electron.on('exit', (code) => shutdown(code ?? 0));
