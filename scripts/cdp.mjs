/**
 * The wire to a running desktop app, shared by every script that drives one. Nothing new is
 * listening: the app opens the port only when `VN_CDP_PORT` is set (the dev launchers set it), and
 * it binds to loopback.
 *
 * Everything crosses with `returnByValue`, so an evaluated expression must end in a plain-data
 * projection — live objects and ResultSets do not survive the wire.
 *
 * The app can have several windows open, so a page target is chosen by index rather than taken
 * off the top of the list: every window loads its own url with `?window=<n>` on it, and that
 * query string is what CDP reports as the target's `url`.
 */
/**
 * Read per call, not once at import. A script that starts the app itself knows the port only after
 * it has picked one, and a module-level constant is already frozen at `9222` by then — which reads
 * as "no CDP endpoint" against an app that is listening perfectly well on another port.
 */
export const cdpPort = () => process.env.VN_CDP_PORT || '9222';
export const CDP_HOST = '127.0.0.1';

/** Node 22+ has a global WebSocket; the repo's floor is 20, so fall back to `ws`. */
export async function connect(url) {
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

/**
 * The page target for one window, by the index the app gave it — window 0 unless asked.
 *
 * Picking `targets.find(t => t.type === 'page')` was deterministic only while a window was
 * something the app had exactly one of. It is matched on `?window=<n>` instead, and an app old
 * enough not to put the index on the url still answers for window 0, so the two-call
 * `window.__x = …` / read-it-back debugging pattern keeps landing in one renderer.
 */
export async function pageTarget(index = 0) {
  let targets;
  try {
    targets = await (await fetch(`http://${CDP_HOST}:${cdpPort()}/json/list`)).json();
  } catch {
    throw new Error(
      `no CDP endpoint on ${CDP_HOST}:${cdpPort()}. Start the app with VN_CDP_PORT=${cdpPort()} set.`,
    );
  }
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (pages.length === 0) throw new Error('no page target — is a window open?');

  const wanted = new RegExp(`[?&]window=${index}(&|$)`);
  const page =
    pages.find((t) => wanted.test(String(t.url))) ??
    (index === 0 && !pages.some((t) => /[?&]window=/.test(String(t.url))) ? pages[0] : undefined);
  if (!page) {
    const open = pages.map((t) => String(t.url).match(/[?&]window=(\d+)/)?.[1] ?? '?').join(', ');
    throw new Error(`no window ${index} — open: ${open}`);
  }
  return page.webSocketDebuggerUrl;
}

let nextId = 0;

/** One protocol call, matched back by its own id so calls may overlap on the one socket. */
export function send(socket, method, params = {}) {
  const id = ++nextId;
  return new Promise((ok, fail) => {
    const onMessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (reply.error) return fail(new Error(reply.error.message));
      ok(reply.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

/** Evaluate an expression in the page and return its value. Throws what the page threw. */
export async function evaluate(socket, expression) {
  const { result, exceptionDetails } = await send(socket, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
}

/** Run one command through the same `window.vn` bridge the DevTools console uses. */
export const exec = (socket, invocation) =>
  evaluate(socket, `window.vn.exec(${JSON.stringify(invocation)})`);
