import { DocBuffer, draftCount, type DocIo } from '../docbuffer.js';
import type { DocFile, DocSaveResult } from '../../../../src/shared/ipc.js';

/** Let every queued microtask and timer settle — `wrote` starts a read it does not return. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/**
 * A fake disk. `read` answers from `files`, and `write` refuses on a hash mismatch the way
 * `doc.write` does, which is what `seenHash` exists for.
 */
class FakeIo implements DocIo {
  readonly files = new Map<string, { text: string; hash: string }>();
  /** While true a read parks, so a test can interleave a second one in front of it. */
  hold = false;
  private readonly parked: Array<() => void> = [];
  reads = 0;
  diagnostic: string | undefined;

  set(path: string, text: string, hash = `h:${text.length}`): void {
    this.files.set(path, { text, hash });
  }

  /** Let every parked read finish, in the order they arrived. */
  release(): void {
    for (const done of this.parked.splice(0)) done();
  }

  async read(path: string): Promise<{ ok: true; file: DocFile } | { ok: false; error: string }> {
    this.reads++;
    if (this.hold) await new Promise<void>((done) => this.parked.push(done));
    const file = this.files.get(path);
    if (!file) return { ok: false, error: `no such document: ${path}` };
    return { ok: true, file: { path, text: file.text, hash: file.hash, bytes: file.text.length } };
  }

  async write(
    path: string,
    text: string,
    seenHash: string,
  ): Promise<{ ok: true; saved: DocSaveResult } | { ok: false; error: string }> {
    const current = this.files.get(path);
    if (current && current.hash !== seenHash) {
      return { ok: false, error: `${path} changed underneath you — reload before saving` };
    }
    const hash = `h:${text.length}:w`;
    this.files.set(path, { text, hash });
    const saved: DocSaveResult = { path, hash, bytes: text.length };
    if (this.diagnostic) saved.diagnostic = this.diagnostic;
    return { ok: true, saved };
  }
}

const buffer = (io: DocIo): { buf: DocBuffer; painted: () => number } => {
  let paints = 0;
  const buf = new DocBuffer(() => void paints++, io);
  return { buf, painted: () => paints };
};

// Drafts are module-level on purpose — one map, so the same document open twice is one draft. That
// makes them leak between tests, so every test uses a path of its own.
let n = 0;
const uniq = (): string => `wiki/note-${++n}.md`;

describe('DocBuffer', () => {
  it('reads a document and repaints', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, 'hello');
    const { buf, painted } = buffer(io);

    await buf.open(path);

    expect(buf.path).toBe(path);
    expect(buf.text).toBe('hello');
    expect(buf.dirty).toBe(false);
    expect(painted()).toBeGreaterThan(0);
  });

  it('keeps a failed read in note, marked bad, with nothing in the box', async () => {
    const io = new FakeIo();
    const { buf } = buffer(io);

    await buf.open('wiki/missing.md');

    expect(buf.text).toBe('');
    expect(buf.bad).toBe(true);
    expect(buf.note).toContain('no such document');
  });

  it('restores an unsaved draft on reopen rather than re-reading', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, 'on disk');
    const { buf } = buffer(io);

    await buf.open(path);
    buf.text = 'typed but not saved';
    expect(buf.dirty).toBe(true);

    // A pane switch reaches the buffer as a close followed by a reopen
    await buf.open('');
    const before = io.reads;
    await buf.open(path);

    expect(buf.text).toBe('typed but not saved');
    expect(buf.dirty).toBe(true);
    expect(io.reads).toBe(before);
  });

  it('drops a read the author already left', async () => {
    const io = new FakeIo();
    const slow = uniq();
    const quick = uniq();
    io.set(slow, 'the slow one');
    io.set(quick, 'the one on screen');
    const { buf } = buffer(io);

    io.hold = true;
    const first = buf.open(slow);
    io.hold = false;
    await buf.open(quick);
    io.release();
    await first;

    expect(buf.path).toBe(quick);
    expect(buf.text).toBe('the one on screen');
  });

  it('refuses a save over a file that changed underneath, and keeps the refusal', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, 'original');
    const { buf } = buffer(io);

    await buf.open(path);
    buf.text = 'mine';
    io.set(path, 'somebody else got there first');

    expect(await buf.save()).toBe(false);
    expect(buf.bad).toBe(true);
    expect(buf.note).toContain('changed underneath');
    // Still dirty and still the author's text: a refusal must not discard the typing it refused
    expect(buf.dirty).toBe(true);
    expect(buf.text).toBe('mine');
  });

  it('clears the draft on a save that landed, and carries a diagnostic through', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, 'original');
    io.diagnostic = 'front-matter has no `type:` — saved anyway';
    const { buf } = buffer(io);

    await buf.open(path);
    buf.text = 'revised';
    const before = draftCount();
    expect(before).toBeGreaterThan(0);

    expect(await buf.save()).toBe(true);
    expect(buf.dirty).toBe(false);
    expect(buf.note).toBe('front-matter has no `type:` — saved anyway');
    expect(buf.bad).toBe(false);
    expect(draftCount()).toBe(before - 1);
  });

  it('says so rather than writing when nothing changed', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, 'unchanged');
    const { buf } = buffer(io);

    await buf.open(path);
    expect(await buf.save()).toBe(false);
    expect(buf.note).toBe('no changes');
    expect(buf.bad).toBe(false);
  });

  it('reload discards the draft and says it did', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, 'on disk');
    const { buf } = buffer(io);

    await buf.open(path);
    buf.text = 'typed';
    await buf.reload();

    expect(buf.text).toBe('on disk');
    expect(buf.dirty).toBe(false);
    expect(buf.note).toBe('reloaded — unsaved draft discarded');
  });

  it('reload over a clean buffer says nothing', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, 'on disk');
    const { buf } = buffer(io);

    await buf.open(path);
    io.set(path, 'rewritten elsewhere');
    await buf.reload();

    expect(buf.text).toBe('rewritten elsewhere');
    expect(buf.note).toBe('');
  });

  it('a clean buffer follows a write it did not make', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, 'before');
    const { buf } = buffer(io);

    await buf.open(path);
    io.set(path, 'after');
    buf.wrote([path]);
    await settle();

    expect(buf.text).toBe('after');
  });

  it('a dirty buffer does not — its next save earns the refusal instead', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, 'before');
    const { buf } = buffer(io);

    await buf.open(path);
    buf.text = 'mine';
    io.set(path, 'after');
    buf.wrote([path]);
    await settle();

    expect(buf.text).toBe('mine');
    expect(await buf.save()).toBe(false);
    expect(buf.note).toContain('changed underneath');
  });

  it('ignores a write to some other file', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, 'before');
    const { buf } = buffer(io);

    await buf.open(path);
    io.set(path, 'after');
    buf.wrote(['characters/aiko/character.md']);
    await settle();

    expect(buf.text).toBe('before');
  });

  it('typing into no document at all is not a draft', async () => {
    const io = new FakeIo();
    const { buf } = buffer(io);
    const before = draftCount();

    buf.text = 'nowhere to put this';

    expect(buf.text).toBe('');
    expect(buf.dirty).toBe(false);
    expect(draftCount()).toBe(before);
  });
});
