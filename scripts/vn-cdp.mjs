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
 *
 * --raw evaluates the expression as-is instead of wrapping it in window.vn.exec(). It
 * crosses CDP with returnByValue, so the expression must end in a plain-data projection
 * (.explain(), .table(), a string) — live objects and ResultSets do not survive the wire.
 */
import { connect, evaluate, pageTarget } from './cdp.mjs';

const [arg, extra] = process.argv.slice(2);
if (!arg || (arg === '--raw' && !extra)) {
  process.stderr.write(
    'usage: node scripts/vn-cdp.mjs "<command dsl>" | --catalog | --history [n] | --undo | --redo | --raw "<expr>"\n',
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

const socket = await connect(await pageTarget());
try {
  const value = await evaluate(socket, expression);
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  // A refused or failed command is a non-zero exit, so this composes in a shell.
  if (value && value.ok === false) process.exitCode = 1;
} finally {
  socket.close();
}
