/**
 * The capture keeps the author's whole conversation in memory and, on request, on disk. So the
 * properties worth testing are the ones that bound it: what the ring holds and when it lets go,
 * that a snapshot does not move under its reader, that the disk half stays off unless asked, and
 * that a caller who says not to record is not recorded.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createGeminiChat, type GeminiClient } from '../gemini.js';
import {
  capturedRequest,
  capturedRequests,
  captureRequest,
  captureSnapshot,
  clearCaptures,
} from '../capture.js';

const BODY = { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hello' }] };

/** A body whose serialized size is predictable enough to set a cap just under it. */
const sized = (chars: number): Record<string, unknown> => ({ pad: 'x'.repeat(chars) });

describe('capturing a request', () => {
  let dir = '';
  const before = { ...process.env };

  beforeEach(async () => {
    clearCaptures();
    dir = await mkdtemp(join(tmpdir(), 'vn-capture-'));
  });

  afterEach(async () => {
    for (const name of ['VN_DUMP_REQUESTS', 'VN_CAPTURE_BYTES', 'VN_CAPTURE_COUNT']) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    clearCaptures();
    await rm(dir, { recursive: true, force: true });
  });

  describe('the ring', () => {
    it('keeps the body with the dump switched off, and numbers it anyway', async () => {
      delete process.env.VN_DUMP_REQUESTS;
      const capture = await captureRequest('convo', BODY);
      // The counter advances whether or not anything is written, so a dumped file and a ring
      // entry name the same request.
      expect(capture.seq).toBeGreaterThan(0);
      expect(capturedRequests().map((h) => h.seq)).toEqual([capture.seq]);
      expect(JSON.parse(capturedRequest(capture.seq) ?? '')).toEqual(BODY);
      expect(await readdir(dir)).toEqual([]);
    });

    it('hands out headers with no body on them', async () => {
      const capture = await captureRequest('convo', BODY);
      const [header] = capturedRequests();
      expect(header).toMatchObject({ seq: capture.seq, label: 'convo', dropped: false });
      expect(header).not.toHaveProperty('json');
      expect(header!.bytes).toBeGreaterThan(0);
    });

    it('files what went wrong on the entry it belongs to', async () => {
      await captureRequest('convo', BODY);
      const second = await captureRequest('convo', BODY);
      await second.failed(new Error('unexpected `tool_use_id`'));
      const [first, latest] = capturedRequests();
      expect(first!.error).toBeUndefined();
      expect(latest!.error).toContain('unexpected `tool_use_id`');
    });

    it('evicts the oldest once there are more entries than the count allows', async () => {
      process.env.VN_CAPTURE_COUNT = '2';
      const seen: number[] = [];
      for (let i = 0; i < 4; i++) seen.push((await captureRequest('convo', { n: i })).seq);
      expect(capturedRequests().map((h) => h.seq)).toEqual(seen.slice(2));
      expect(capturedRequest(seen[1]!)).toBeUndefined();
    });

    it('evicts the oldest once the bodies outweigh the byte cap', async () => {
      // Each of these serializes to ~116 bytes, so two fit under the cap and the third cannot.
      process.env.VN_CAPTURE_BYTES = '250';
      await captureRequest('convo', sized(100));
      await captureRequest('convo', sized(100));
      const last = await captureRequest('convo', sized(100));
      const kept = capturedRequests();
      expect(kept.length).toBeLessThan(3);
      expect(kept.at(-1)!.seq).toBe(last.seq);
    });

    it('keeps the header of a body too big to hold, rather than emptying the ring for it', async () => {
      process.env.VN_CAPTURE_BYTES = '200';
      const small = await captureRequest('convo', BODY);
      const huge = await captureRequest('convo', sized(5000));
      // The oversized one is on the ring and marked, and it did not evict what came before it
      // trying to make room it could never have.
      expect(capturedRequests().map((h) => [h.seq, h.dropped])).toEqual([
        [small.seq, false],
        [huge.seq, true],
      ]);
      expect(capturedRequest(huge.seq)).toBeUndefined();
      expect(capturedRequest(small.seq)).toBeDefined();
    });

    it('forgets everything when a workspace closes', async () => {
      await captureRequest('convo', BODY);
      clearCaptures();
      expect(capturedRequests()).toEqual([]);
    });
  });

  describe('a snapshot', () => {
    it('does not move when the ring does', async () => {
      process.env.VN_CAPTURE_COUNT = '2';
      const first = await captureRequest('convo', BODY);
      const snapshot = captureSnapshot();

      // Two more requests evict the first one out of the live ring entirely.
      await captureRequest('convo', { n: 2 });
      await captureRequest('convo', { n: 3 });

      expect(capturedRequest(first.seq)).toBeUndefined();
      expect(snapshot.headers().map((h) => h.seq)).toEqual([first.seq]);
      expect(JSON.parse(snapshot.body(first.seq) ?? '')).toEqual(BODY);
    });

    it('carries no body on its headers either', async () => {
      await captureRequest('convo', BODY);
      expect(captureSnapshot().headers()[0]).not.toHaveProperty('json');
    });
  });

  describe('a caller that says not to record', () => {
    it('is not recorded, on disk or in memory', async () => {
      process.env.VN_DUMP_REQUESTS = dir;
      const capture = await captureRequest('convo', BODY, { record: false });
      await capture.failed(new Error('400 from the API'));
      expect(capture.seq).toBe(0);
      expect(capturedRequests()).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
    });
  });

  describe('the disk half', () => {
    it('writes nothing at all unless the env var names a directory', async () => {
      delete process.env.VN_DUMP_REQUESTS;
      const capture = await captureRequest('convo', BODY);
      await capture.failed(new Error('400 from the API'));
      expect(await readdir(dir)).toEqual([]);
    });

    it('writes the body before the call, so a failure that never returns is still captured', async () => {
      process.env.VN_DUMP_REQUESTS = dir;
      await captureRequest('convo', BODY);
      const [name = ''] = await readdir(dir);
      // Pid then sequence, so two runs against one directory cannot overwrite each other.
      expect(name).toMatch(/^convo-\d+-\d{3}\.json$/);
      expect(JSON.parse(await readFile(join(dir, name), 'utf8'))).toEqual(BODY);
    });

    it('files what went wrong beside it', async () => {
      process.env.VN_DUMP_REQUESTS = dir;
      const capture = await captureRequest('convo', BODY);
      await capture.failed(new Error('unexpected `tool_use_id`'));
      const errors = (await readdir(dir)).filter((f) => f.endsWith('.error.txt'));
      expect(errors).toHaveLength(1);
      expect(await readFile(join(dir, errors[0]!), 'utf8')).toContain('unexpected `tool_use_id`');
    });

    it('swallows an unwritable directory rather than failing the turn it was watching', async () => {
      process.env.VN_DUMP_REQUESTS = join(dir, 'a-file-not-a-directory', '\0bad');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const capture = await captureRequest('convo', BODY);
      await expect(capture.failed(new Error('boom'))).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      // The ring is unaffected by the disk half failing
      expect(capturedRequests()).toHaveLength(1);
      warn.mockRestore();
    });
  });
});

/**
 * The Gemini backend has no assembled conversation body — but its `contents`/`config` pair is
 * still the thing a positional error indexes into, and it is built inside the backend rather than
 * written out at the call site, so it is captured on the same terms.
 */
describe('the Gemini backend', () => {
  const sdk =
    (fail?: unknown): GeminiClient =>
    () =>
      Promise.resolve({
        models: {
          generateContent: () => (fail ? Promise.reject(fail) : Promise.resolve({ text: 'hi' })),
        },
      });

  beforeEach(() => clearCaptures());
  afterEach(() => clearCaptures());

  it('captures the vendor body rather than the two strings above it', async () => {
    await createGeminiChat('k', 'gemini-2.5-flash', sdk()).message({
      system: 'be brief',
      prompt: 'hello',
    });
    const [header] = capturedRequests();
    const body = JSON.parse(capturedRequest(header!.seq) ?? '');
    expect(header!.label).toBe('gemini');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
    expect(body.config).toEqual({ systemInstruction: 'be brief' });
  });

  it('files the failure on it once, not once per retry', async () => {
    const chat = createGeminiChat('k', 'gemini-2.5-flash', sdk(new Error('400 bad request')));
    await expect(chat.message({ prompt: 'hello' })).rejects.toThrow();
    const kept = capturedRequests();
    expect(kept).toHaveLength(1);
    expect(kept[0]!.error).toContain('400 bad request');
  });

  it('records nothing when the caller says not to', async () => {
    await createGeminiChat('k', 'gemini-2.5-flash', sdk(), { record: false }).message({
      prompt: 'hello',
    });
    expect(capturedRequests()).toEqual([]);
  });
});
