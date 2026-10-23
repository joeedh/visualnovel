import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskRequests, withRequestStop } from '../requests.js';

it('resumes multiple calls inside one graph node, retaining binary responses and deliberate repeats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-requests-'));
  const stop = new AbortController();
  let count = 0;
  const request = jest.fn(async () => ({ bytes: new Uint8Array([++count]), ext: 'png' }));
  try {
    const first = new TaskRequests(dir);
    await withRequestStop({ signal: stop.signal }, async () => {
      expect((await first.call('node.image', ['same input'], request)).bytes).toEqual(
        new Uint8Array([1]),
      );
      stop.abort();
      await expect(first.call('node.image', ['same input'], request)).rejects.toBeDefined();
    });
    const resumed = new TaskRequests(dir);
    expect((await resumed.call('node.image', ['same input'], request)).bytes).toEqual(
      new Uint8Array([1]),
    );
    expect((await resumed.call('node.image', ['same input'], request)).bytes).toEqual(
      new Uint8Array([2]),
    );
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
