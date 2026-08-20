/**
 * One instance per workspace: the real socket end to end, plus the two paths a real socket
 * cannot be made to take on demand — a stale endpoint left by a killed owner, and an owner that
 * is still there.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, Socket } from 'node:net';
import {
  acquireWorkspace,
  focusOwner,
  lockAddress,
  workspaceIsTaken,
  type LockIo,
} from '../instancelock.js';

const root = (): Promise<string> => mkdtemp(join(tmpdir(), 'vn-lock-'));

describe('lockAddress', () => {
  it('is a pipe on Windows and a socket file elsewhere', () => {
    expect(lockAddress('C:/dev/story', 'win32')).toMatch(/^\\\\\.\\pipe\\vnstudio-[0-9a-f]{16}$/);
    expect(lockAddress('/home/a/story', 'linux')).toMatch(/vnstudio-[0-9a-f]{16}\.sock$/);
  });

  it('keys on the project, and on Windows ignores how the path was spelt', () => {
    expect(lockAddress('C:/dev/story', 'win32')).toBe(lockAddress('C:\\DEV\\Story', 'win32'));
    expect(lockAddress('C:/dev/story', 'win32')).not.toBe(lockAddress('C:/dev/other', 'win32'));
  });

  // The `platform` argument says which rules apply, not which machine is asking: resolved under
  // the host's rules, a Windows root read on a Linux runner keeps its backslashes and picks up
  // that runner's cwd. Both assertions above pass under that mistake, so the value is pinned here.
  it('answers the same on every host, because the platform is an argument', () => {
    expect(lockAddress('C:/dev/story', 'win32')).toBe('\\\\.\\pipe\\vnstudio-fb8a5d7e99c96a22');
    expect(lockAddress('/home/a/story', 'linux')).toMatch(/vnstudio-7e897f1fc5575733\.sock$/);
  });
});

describe('acquireWorkspace', () => {
  it('lets one instance in, turns the next away, and frees the endpoint on release', async () => {
    const dir = await root();
    const first = await acquireWorkspace(dir, () => {});
    expect(first).not.toBeNull();

    // A second instance on the same project must not open: two stacks would silently overwrite
    // each other's `refs/vn/undo/<seq>` snapshots.
    expect(await acquireWorkspace(dir, () => {})).toBeNull();
    expect(await workspaceIsTaken(dir)).toBe(true);

    await first!.release();
    expect(await workspaceIsTaken(dir)).toBe(false);

    const second = await acquireWorkspace(dir, () => {});
    expect(second).not.toBeNull();
    await second!.release();
  });

  it('lets two different projects run side by side', async () => {
    const [a, b] = [await root(), await root()];
    const one = await acquireWorkspace(a, () => {});
    const two = await acquireWorkspace(b, () => {});
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    await one!.release();
    await two!.release();
  });

  it('hands off: the arriving instance brings the owner forward', async () => {
    const dir = await root();
    let focused = 0;
    const owner = await acquireWorkspace(dir, () => focused++);

    expect(await focusOwner(dir)).toBe(true);
    // The owner answers on its own event loop turn, so give it one.
    await new Promise((ok) => setTimeout(ok, 50));
    expect(focused).toBe(1);

    await owner!.release();
    // An unanswered address is not an error: the caller may take the lock rather than exiting.
    expect(await focusOwner(dir)).toBe(false);
  });
});

/** A `LockIo` whose every answer is scripted, so the posix stale-socket path can be driven. */
function scriptedIo(script: { taken: boolean; live: boolean }): LockIo & { unlinked: string[] } {
  const unlinked: string[] = [];
  let firstListen = true;
  return {
    unlinked,
    listen: (address: string) => {
      if (firstListen && script.taken) {
        firstListen = false;
        return Promise.reject(
          Object.assign(new Error(`listen EADDRINUSE ${address}`), {
            code: 'EADDRINUSE',
          }),
        );
      }
      firstListen = false;
      return Promise.resolve({ close: (cb?: () => void) => cb?.() } as unknown as Server);
    },
    connect: () =>
      script.live
        ? Promise.resolve({
            destroy: () => {},
            end: (_d: string, cb: () => void) => cb(),
          } as unknown as Socket)
        : Promise.reject(new Error('ECONNREFUSED')),
    unlink: (address: string) => {
      unlinked.push(address);
      return Promise.resolve();
    },
  };
}

describe('a socket file a killed owner left behind', () => {
  it('is unlinked and the listen retried, because nobody answers it', async () => {
    const io = scriptedIo({ taken: true, live: false });
    const lock = await acquireWorkspace('/tmp/story', () => {}, io, 'linux');

    expect(lock).not.toBeNull();
    expect(io.unlinked).toEqual([lockAddress('/tmp/story', 'linux')]);
  });

  it('is left alone when somebody answers — that is an owner, not a leftover', async () => {
    const io = scriptedIo({ taken: true, live: true });
    expect(await acquireWorkspace('/tmp/story', () => {}, io, 'linux')).toBeNull();
    expect(io.unlinked).toEqual([]);
  });

  it('cannot happen on Windows, so EADDRINUSE is taken at its word', async () => {
    // A named pipe dies with the process that made it; probing would only add a round trip.
    const io = scriptedIo({ taken: true, live: false });
    expect(await acquireWorkspace('C:/dev/story', () => {}, io, 'win32')).toBeNull();
    expect(io.unlinked).toEqual([]);
  });
});
