/**
 * Drive the running desktop app's command stack from outside the process, over Chrome's own
 * DevTools Protocol. The evaluated expression goes through the same `window.vn` bridge the
 * DevTools console uses, so there is no second, less-guarded entry point. The socket itself is
 * `scripts/cdp.mjs`, shared with `verify-prompt-chunks.mjs`.
 *
 * Usage:
 *   node scripts/vn-cdp.mjs "workspace.index()"
 *   node scripts/vn-cdp.mjs --catalog
 *   node scripts/vn-cdp.mjs --history 5
 *   node scripts/vn-cdp.mjs --undo          # and --redo; refuses if the workspace moved
 *   node scripts/vn-cdp.mjs --raw "window.__vnDebug.explainPick(400, 300)"
 *   node scripts/vn-cdp.mjs --window 1 "view.open(editor='script')"
 *
 * --window <n> picks which of the app's windows to talk to, defaulting to 0. It matters more
 * than it looks: each window is a separate renderer with its own globals, so a scratch value
 * parked on `window.__x` in one is simply not there in another.
 *
 * --raw evaluates the expression as-is instead of wrapping it in window.vn.exec(). It
 * crosses CDP with returnByValue, so the expression must end in a plain-data projection
 * (.explain(), .table(), a string) — live objects and ResultSets do not survive the wire.
 */
import { connect, evaluate, pageTarget } from './cdp.mjs';

const argv = process.argv.slice(2);

// `--window <n>` may sit anywhere among the arguments because it selects where to run the
// expression, not what expression to run.
let windowIndex = 0;
const at = argv.indexOf('--window');
if (at !== -1) {
  windowIndex = Number(argv[at + 1]);
  if (!Number.isInteger(windowIndex) || windowIndex < 0) {
    process.stderr.write('vn-cdp: --window takes a window index, e.g. --window 1\n');
    process.exit(2);
  }
  argv.splice(at, 2);
}

const [arg, extra] = argv;
if (!arg || (arg === '--raw' && !extra)) {
  process.stderr.write(
    'usage: node scripts/vn-cdp.mjs [--window n] "<command dsl>" | --catalog | --history [n] | --undo | --redo | --raw "<expr>"\n',
  );
  process.exit(2);
}

const BRIDGE = {
  '--catalog': 'window.vn.catalog()',
  '--undo': 'window.vn.undo()',
  '--redo': 'window.vn.redo()',
  '--history': `window.vn.history(${extra ? Number(extra) : ''})`,
  '--raw': extra,
};
const expression = BRIDGE[arg] ?? `window.vn.exec(${JSON.stringify(arg)})`;

const socket = await connect(await pageTarget(windowIndex));
try {
  const value = await evaluate(socket, expression);
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  // A refused or failed command is a non-zero exit, so this composes in a shell.
  if (value && value.ok === false) process.exitCode = 1;
} finally {
  socket.close();
}
