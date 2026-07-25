/**
 * Drive the running desktop app's command stack from outside the process, over Chrome's own
 * DevTools Protocol. Nothing new is listening: the app opens the port only when
 * `VN_CDP_PORT` is set (`scripts/dev.desktop.mjs` sets it for the dev loop), and it binds to
 * loopback. The evaluated expression goes through the same `window.vn` bridge the DevTools
 * console uses, so there is no second, less-guarded entry point.
 *
 * Usage:
 *   node scripts/vn-cdp.mjs "workspace.index()"
 *   node scripts/vn-cdp.mjs --catalog
 *   node scripts/vn-cdp.mjs --history 5
 *   node scripts/vn-cdp.mjs --undo          # v1: refuses, see docs/gitUndoOptions.md
 */
const PORT = process.env.VN_CDP_PORT ?? '9222';
const HOST = '127.0.0.1';

/** Node 22+ has a global WebSocket; the repo's floor is 20, so fall back to `ws`. */
async function connect(url) {
  const WS = globalThis.WebSocket ?? (await import('ws')).default;
  const socket = new WS(url);
  await new Promise((ok, fail) => {
    socket.addEventListener('open', ok, { once: true });
    socket.addEventListener('error', () => fail(new Error(`could not connect to ${url}`)), {
      once: true,
    });
  });
  return socket;
}

/** The first page target — the app has exactly one window. */
async function pageTarget() {
  let targets;
  try {
    targets = await (await fetch(`http://${HOST}:${PORT}/json/list`)).json();
  } catch {
    throw new Error(
      `no CDP endpoint on ${HOST}:${PORT}. Start the app with VN_CDP_PORT=${PORT} set.`,
    );
  }
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target — is a window open?');
  return page.webSocketDebuggerUrl;
}

function evaluate(socket, expression) {
  return new Promise((ok, fail) => {
    socket.addEventListener(
      'message',
      (event) => {
        const reply = JSON.parse(String(event.data));
        if (reply.id !== 1) return;
        if (reply.error) return fail(new Error(reply.error.message));
        const { result, exceptionDetails } = reply.result;
        if (exceptionDetails) return fail(new Error(exceptionDetails.text));
        ok(result.value);
      },
      { once: false },
    );
    socket.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
}

const [arg, extra] = process.argv.slice(2);
if (!arg) {
  process.stderr.write(
    'usage: node scripts/vn-cdp.mjs "<command dsl>" | --catalog | --history [n] | --undo | --redo\n',
  );
  process.exit(2);
}

const BRIDGE = {
  '--catalog': 'window.vn.catalog()',
  '--undo': 'window.vn.undo()',
  '--redo': 'window.vn.redo()',
  '--history': `window.vn.history(${extra ? Number(extra) : ''})`,
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
