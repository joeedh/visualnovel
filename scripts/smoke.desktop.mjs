/**
 * Ask the *packaged* app whether it can still find its two external SDKs.
 *
 * `scripts/package.desktop.mjs` builds the app image from a scratch hoisted install precisely
 * because pnpm's symlinked `node_modules` does not survive being copied into one. This is the
 * check that the workaround worked, and it has to run the built executable — a test run from the
 * repo would resolve the SDKs out of the workspace and pass no matter what shipped.
 *
 * Usage: `node scripts/smoke.desktop.mjs [path-to-executable]`. With no argument it looks for the
 * unpacked build `--dir` leaves behind, so `pnpm package:dir && pnpm smoke` is the loop.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './aliases.mjs';

const SMOKE_PREFIX = 'VN-SMOKE ';

const UNPACKED = {
  win32: join('win-unpacked', 'vnstudio.exe'),
  darwin: join('mac', 'vnstudio.app', 'Contents', 'MacOS', 'vnstudio'),
  linux: join('linux-unpacked', 'vnstudio'),
};

const exe =
  process.argv[2] ??
  join(REPO_ROOT, 'apps', 'desktop', 'release', UNPACKED[process.platform] ?? UNPACKED.linux);

if (!existsSync(exe)) {
  throw new Error(`no packaged app at ${exe} — run \`pnpm package:dir\` first`);
}

console.log(`[smoke] ${exe} --smoke`);

let stdout = '';
let failed;
try {
  // No key in the environment on purpose: constructing a client must not need one, and a smoke
  // test that quietly depends on the developer's key is not a test of the installer.
  stdout = execFileSync(exe, ['--smoke'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' },
  });
} catch (err) {
  stdout = (err.stdout ?? '').toString();
  failed = err;
}

// Electron writes its own noise to stdout on some platforms, so the report is found by its
// prefix rather than by being the only thing there.
const line = stdout.split(/\r?\n/).find((l) => l.startsWith(SMOKE_PREFIX));
if (!line) {
  console.error(stdout.trim() || '(no output)');
  throw new Error(
    `the app printed no ${SMOKE_PREFIX.trim()} line${failed ? ' and exited nonzero' : ''}`,
  );
}

const report = JSON.parse(line.slice(SMOKE_PREFIX.length));
for (const check of report.checks) {
  console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.spec} — ${check.detail}`);
}
if (!report.ok || failed) {
  throw new Error('the packaged app cannot load both model SDKs');
}
console.log('[smoke] both SDKs resolved from the app image');
