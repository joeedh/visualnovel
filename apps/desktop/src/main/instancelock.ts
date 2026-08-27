/**
 * One app instance per workspace, not per install.
 *
 * Two instances on two different repos share nothing that can collide: the committer's `-A`
 * sweep, the notification log and the agent conversation are all per project. Two instances on
 * the same repo collide in every one of them, and silently: each holds its own undo history over
 * the same worktree, so a restore in one is drift the other refuses to undo through. The lock is
 * therefore keyed by the resolved root. `app.requestSingleInstanceLock()` is a global lock and is deliberately not
 * used, because it would also forbid two instances on two different repos.
 *
 * The lock is a listening socket rather than a file, so binding it is acquiring it: the bind
 * succeeds for exactly one process, and the endpoint dies with the process, so there is no
 * stale-pid bookkeeping and no lock that outlives a crash. On Windows a named pipe leaves
 * nothing behind. On posix a socket file survives a hard kill, so `EADDRINUSE` is followed by a
 * connect attempt: a refused connect means the owner is gone, so the file is unlinked and the
 * listen retried once.
 *
 * Nothing here imports `electron`, so it is testable in the node-only desktop jest project.
 */
import { createHash } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';

/** What the arriving instance sends, and the only message the owner answers. */
export const FOCUS_MESSAGE = 'focus';

/** How long a hand-off waits on the owner before giving up and opening a window anyway. */
const HANDOFF_MS = 2000;

/**
 * The endpoint a workspace's owner listens on. A digest rather than the path itself, because a
 * project root is longer than a pipe name may be and contains separators that are not legal in
 * one. Case-normalized on Windows, where two spellings of one directory are one directory.
 *
 * `platform` decides which rules the path is resolved under, so the resolver is picked
 * explicitly rather than taken from `node:path`'s default export. A bare `resolve` follows the
 * host, so `lockAddress(root, 'win32')` would mean something different on a Linux runner than on
 * Windows: it leaves the backslashes in `C:\DEV\Story` as ordinary characters and prepends the
 * cwd, so the two spellings of one directory stop agreeing.
 */
export function lockAddress(root: string, platform: string = process.platform): string {
  const canonical = platform === 'win32' ? win32.resolve(root).toLowerCase() : posix.resolve(root);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return platform === 'win32'
    ? `\\\\.\\pipe\\vnstudio-${hash}`
    : join(tmpdir(), `vnstudio-${hash}.sock`);
}

/** A held lock. Releasing stops listening; the endpoint is free for the next instance. */
export interface InstanceLock {
  readonly root: string;
  readonly address: string;
  release(): Promise<void>;
}

/** The socket calls this module makes, injected so a test can replace them with fakes. */
export interface LockIo {
  listen(address: string, onConnection: (socket: Socket) => void): Promise<Server>;
  connect(address: string, timeoutMs: number): Promise<Socket>;
  unlink(address: string): Promise<void>;
}

const nodeIo: LockIo = {
  listen: (address, onConnection) =>
    new Promise<Server>((ok, fail) => {
      const server = createServer(onConnection);
      server.once('error', fail);
      server.listen(address, () => {
        server.removeListener('error', fail);
        server.unref();
        ok(server);
      });
    }),
  connect: (address, timeoutMs) =>
    new Promise<Socket>((ok, fail) => {
      const socket = createConnection(address);
      const timer = setTimeout(() => {
        socket.destroy();
        fail(new Error(`timed out connecting to ${address}`));
      }, timeoutMs);
      timer.unref?.();
      socket.once('connect', () => {
        clearTimeout(timer);
        ok(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        fail(err);
      });
    }),
  unlink: (address) => unlink(address).catch(() => {}),
};

function isAddressInUse(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'EADDRINUSE';
}

/**
 * Take the lock on `root`, or report that somebody else has it.
 *
 * `onFocus` is called when a later instance hands off to this one — the owner is expected to
 * bring its most recently focused window forward. It is never called for our own acquisition.
 */
export async function acquireWorkspace(
  root: string,
  onFocus: () => void,
  io: LockIo = nodeIo,
  platform: string = process.platform,
): Promise<InstanceLock | null> {
  const address = lockAddress(root, platform);

  const handle = (socket: Socket): void => {
    socket.setEncoding('utf8');
    socket.once('data', (data: string) => {
      if (data.trim() === FOCUS_MESSAGE) onFocus();
      socket.end();
    });
  };

  const listen = async (): Promise<Server | null> => {
    try {
      return await io.listen(address, handle);
    } catch (err) {
      if (!isAddressInUse(err)) throw err;
      return null;
    }
  };

  let server = await listen();
  if (!server) {
    // The address is either held by a live owner or a stale socket file left by a killed one.
    // Only a connect attempt tells the two apart, and only on posix, because a Windows pipe
    // cannot outlive the process that made it.
    if (platform === 'win32') return null;
    const live = await io
      .connect(address, HANDOFF_MS)
      .then((socket) => {
        socket.destroy();
        return true;
      })
      .catch(() => false);
    if (live) return null;
    await io.unlink(address);
    server = await listen();
    if (!server) return null;
  }

  const held = server;
  return {
    root,
    address,
    release: () =>
      new Promise<void>((ok) => {
        held.close(() => ok());
      }),
  };
}

/**
 * Tell the instance that owns `root` to come forward. Answers whether anybody was listening —
 * `false` means the endpoint went away between the failed acquire and this call, so the caller
 * may take it after all rather than exiting into nothing.
 */
export async function focusOwner(
  root: string,
  io: LockIo = nodeIo,
  platform: string = process.platform,
): Promise<boolean> {
  const address = lockAddress(root, platform);
  try {
    const socket = await io.connect(address, HANDOFF_MS);
    await new Promise<void>((ok) => {
      socket.end(FOCUS_MESSAGE, () => ok());
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `root` is open in another instance at this instant. The caller must still acquire for
 * real, because the answer can change before it does. Used by `workspace.open`'s check, which is
 * allowed to race because `run` re-decides.
 */
export async function workspaceIsTaken(
  root: string,
  io: LockIo = nodeIo,
  platform: string = process.platform,
): Promise<boolean> {
  const lock = await acquireWorkspace(root, () => {}, io, platform).catch(() => null);
  if (!lock) return true;
  await lock.release();
  return false;
}
