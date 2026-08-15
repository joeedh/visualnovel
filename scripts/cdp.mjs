/**
 * The wire to a running desktop app, shared by every script that drives one. Nothing new is
 * listening: the app opens the port only when `VN_CDP_PORT` is set (the dev launchers set it), and
 * it binds to loopback.
 *
 * Everything crosses with `returnByValue`, so an evaluated expression must end in a plain-data
 * projection — live objects and ResultSets do not survive the wire.
 */
export const CDP_PORT = process.env.VN_CDP_PORT ?? '9222';
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

/** The first page target — the app has exactly one window. */
export async function pageTarget() {
  let targets;
  try {
    targets = await (await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`)).json();
  } catch {
    throw new Error(
      `no CDP endpoint on ${CDP_HOST}:${CDP_PORT}. Start the app with VN_CDP_PORT=${CDP_PORT} set.`,
    );
  }
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target — is a window open?');
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
