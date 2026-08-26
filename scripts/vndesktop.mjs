/**
 * Launch the built desktop app with the remote-debugging port open, the way
 * `scripts/dev.desktop.mjs` already does for the dev loop. `pnpm vndesktop` is a developer
 * entry point — the thing you reach for when you want to drive the app from
 * `scripts/vn-cdp.mjs` — so the port being open is the useful default rather than a flag to
 * remember after the window is already up (it can only be set before `app.whenReady()`).
 *
 * A packaged app still opens nothing: `src/main/index.ts` reads `VN_CDP_PORT` and this script
 * is not in the bundle. Setting `VN_CDP_PORT` yourself picks the port exactly; setting it
 * **empty** (`VN_CDP_PORT= pnpm vndesktop`) is the opt-out, because the main process treats an
 * empty value as unset. The port grants full control of the renderer, so it is announced on
 * stdout rather than opened in silence.
 *
 * Left to itself the launcher takes the **first free port from 9222 upward**, because one app
 * instance per workspace means two workspaces are two processes, and the second one silently
 * losing the race for 9222 would leave `vn-cdp.mjs` talking confidently to the wrong app.
 *
 * Usage: `pnpm vndesktop [--mock] [--project <dir>]`
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'apps/desktop');

/**
 * Checks whether nothing is listening on loopback at this port by binding it, which is the only
 * answer that is not a guess. Releasing the port here and Electron taking it later leaves a race,
 * and this accepts that race deliberately because it runs only in a developer loop, where the
 * alternative would hold a socket the child process cannot have.
 */
function isFree(candidate) {
  return new Promise((ok) => {
    const probe = createServer();
    probe.once('error', () => ok(false));
    probe.once('listening', () => probe.close(() => ok(true)));
    probe.listen(candidate, '127.0.0.1');
  });
}

async function choosePort() {
  // An explicit VN_CDP_PORT is honoured as written — including empty, which is the opt-out.
  if (process.env.VN_CDP_PORT !== undefined) return process.env.VN_CDP_PORT;
  for (let candidate = 9222; candidate < 9242; candidate++) {
    if (await isFree(candidate)) return String(candidate);
  }
  process.stderr.write('vndesktop: no free CDP port in 9222-9241; starting without one\n');
  return '';
}

const port = await choosePort();

if (port)
  process.stdout.write(
    `vndesktop: CDP on 127.0.0.1:${port} — VN_CDP_PORT=${port} node scripts/vn-cdp.mjs\n`,
  );

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
