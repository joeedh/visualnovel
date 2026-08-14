/**
 * Launch the built desktop app with the remote-debugging port open, the way
 * `scripts/dev.desktop.mjs` already does for the dev loop. `pnpm vndesktop` is a developer
 * entry point — the thing you reach for when you want to drive the app from
 * `scripts/vn-cdp.mjs` — so the port being open is the useful default rather than a flag to
 * remember after the window is already up (it can only be set before `app.whenReady()`).
 *
 * A packaged app still opens nothing: `src/main/index.ts` reads `VN_CDP_PORT` and this script
 * is not in the bundle. Setting `VN_CDP_PORT` yourself picks the port; setting it **empty**
 * (`VN_CDP_PORT= pnpm vndesktop`) is the opt-out, because the main process treats an empty
 * value as unset. The port grants full control of the renderer, so it is announced on stdout
 * rather than opened in silence.
 *
 * Usage: `pnpm vndesktop [--mock] [--project <dir>]`
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'apps/desktop');
const port = process.env.VN_CDP_PORT ?? '9222';

if (port) process.stdout.write(`vndesktop: CDP on 127.0.0.1:${port} — node scripts/vn-cdp.mjs\n`);

const electron = spawn('pnpm', ['exec', 'electron', '.', ...process.argv.slice(2)], {
  cwd: desktop,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VN_CDP_PORT: port },
});

electron.on('error', (err) => {
  process.stderr.write(`vndesktop: could not launch Electron: ${err.message}\n`);
  process.exit(1);
});
electron.on('exit', (code) => process.exit(code ?? 0));
