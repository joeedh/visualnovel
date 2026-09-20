/**
 * The rich `DocBuffer` over `docsession.ts`: sessions shared by path, the save that runs
 * `prepareSave` first, the session kept across the buffer's own write, and autosave. Drives the
 * real `DocumentSession` and `ToolStack` from path.ux's headless entry through a provider that
 * supports only the whole-document replacement `markdownSourceCommand` issues.
 */
import {
  markdownSourceCommand,
  type BlockId,
  type BlockSnapshot,
  type DocumentProvider,
  type DraftController,
  type DraftPreparation,
  type EditOp,
  type MdBlock,
  type MdDoc,
} from 'pathux-richtext-headless';
import { AUTOSAVE_MS, DocBuffer, draftCount, type DocIo } from '../docbuffer.js';
import { dirtySessionCount, findSession } from '../docsession.js';
import type { DocFile, DocSaveResult } from '../../../../src/shared/ipc.js';

/** Let every queued microtask and zero-delay timer settle. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

class ReplaceOnlyProvider implements DocumentProvider<MdDoc> {
  blocks(doc: MdDoc) {
    return doc.blocks.map((b) => b.id);
  }
  blockText() {
    return '';
  }
  isOpaque() {
    return true;
  }
  marks() {
    return [];
  }
  renderBlock(): HTMLElement {
    throw new Error('headless');
  }
  applyEdit(doc: MdDoc, op: EditOp) {
    if (op.type !== 'replaceBlocks') throw new Error(`unsupported edit ${op.type}`);
    const removing = new Set(op.remove);
    const removed = doc.blocks.filter((b) => removing.has(b.id)).map((b) => b.id);
    doc.blocks = doc.blocks.filter((b) => !removing.has(b.id));
    const restored = op.blocks.map((s) => structuredClone(s.state) as MdBlock);
    const index = op.after === null ? 0 : doc.blocks.findIndex((b) => b.id === op.after) + 1;
    doc.blocks.splice(index, 0, ...restored);
    return { dirtyBlocks: restored.map((b) => b.id), removedBlocks: removed };
  }
  inverse(doc: MdDoc, op: EditOp): EditOp {
    if (op.type !== 'replaceBlocks') throw new Error(`unsupported edit ${op.type}`);
    return {
      type  : 'replaceBlocks',
      after : null,
      blocks: this.snapshots(doc),
      remove: [...this.blocks(doc), ...op.blocks.map((b) => b.id)],
    };
  }
  snapshots(doc: MdDoc, blocks: readonly BlockId[] = this.blocks(doc)): BlockSnapshot[] {
    return blocks.map((id) => ({
      id,
      state: structuredClone(doc.blocks.find((b) => b.id === id)),
    }));
  }
  toClipboard() {
    return { blocks: [] };
  }
  fromClipboard() {
    return undefined;
  }
  emitDocFile(doc: MdDoc) {
    return new Blob([JSON.stringify(doc)], { type: 'text/markdown' });
  }
}

/**
 * A fake disk that also records how each write was marked, and can park a write so a test can
 * edit while it is in flight.
 */
class FakeIo implements DocIo {
  readonly files = new Map<string, { text: string; hash: string }>();
  readonly writes: { text: string; auto: boolean }[] = [];
  reads = 0;
  hold = false;
  private readonly parked: Array<() => void> = [];
  private readonly waiting: Array<() => void> = [];
  diagnostic: string | undefined;

  set(path: string, text: string, hash = `h:${text.length}`): void {
    this.files.set(path, { text, hash });
  }

  /** Resolves once a write has parked, so a test can act while it is in flight. */
  parkedWrite(): Promise<void> {
    if (this.parked.length > 0) return Promise.resolve();
    return new Promise((done) => this.waiting.push(done));
  }

  release(): void {
    for (const done of this.parked.splice(0)) done();
  }

  async read(path: string): Promise<{ ok: true; file: DocFile } | { ok: false; error: string }> {
    this.reads++;
    const file = this.files.get(path);
    if (!file) return { ok: false, error: `no such document: ${path}` };
    return {
      ok  : true,
      file: {
        path,
        text   : file.text,
        hash   : file.hash,
        bytes  : file.text.length,
        implied: 'character',
      },
    };
  }

  async write(
    path: string,
    text: string,
    seenHash: string,
    auto: boolean,
  ): Promise<{ ok: true; saved: DocSaveResult } | { ok: false; error: string }> {
    if (this.hold) {
      await new Promise<void>((done) => {
        this.parked.push(done);
        for (const woken of this.waiting.splice(0)) woken();
      });
    }
    const current = this.files.get(path);
    if (current && current.hash !== seenHash) {
      return { ok: false, error: `${path} changed underneath you — reload before saving` };
    }
    this.writes.push({ text, auto });
    const hash = `h:${text.length}:w${this.writes.length}`;
    this.files.set(path, { text, hash });
    const saved: DocSaveResult = { path, hash, bytes: text.length };
    if (this.diagnostic) saved.diagnostic = this.diagnostic;
    return { ok: true, saved };
  }
}

const ORIGINAL = '---\nname: Ada # keep\n---\n\n# Ada\n\nSome *prose*.\n';
const EDITED = ORIGINAL.replace('Some *prose*.', 'More prose.');
const provider = new ReplaceOnlyProvider();

const rich = (io: DocIo, autosave?: number): { buf: DocBuffer; painted: () => number } => {
  let paints = 0;
  const buf = new DocBuffer(() => void paints++, io, { rich: () => provider, autosave });
  return { buf, painted: () => paints };
};

/** An edit as the raw view or the rich editor would commit it: through the session's command. */
async function edit(buf: DocBuffer, from: string, to: string): Promise<void> {
  const session = buf.session!;
  const ctx = { api: {} as never, screen: {} as never, state: {}, toolstack: session.toolstack };
  const result = await session.command(markdownSourceCommand(session.doc, from, to), ctx);
  expect(result.status).toBe('applied');
}

/** Undo on the document's own stack, which the entry types more tightly than the session does. */
const undo = (buf: DocBuffer): Promise<void> => findSession(buf.path)!.stack.undo();

/** A form draft that is still pending when the save runs, and answers `prepare` as told. */
function draft(buf: DocBuffer, prepare: DraftPreparation): void {
  const controller: DraftController = {
    key      : 'frontmatter',
    pending  : () => true,
    version  : () => 1,
    prepare  : () => prepare,
    committed: () => {},
    discard  : () => {},
    recover  : () => undefined,
  };
  const session = buf.session!;
  session.registerDraft(controller, {
    api      : {} as never,
    screen   : {} as never,
    state    : {},
    toolstack: session.toolstack,
  });
}

// Sessions are module-level on purpose, so every test uses a path of its own and closes what it
// opened
let n = 0;
const uniq = (): string => `characters/ada-${++n}/character.md`;

afterEach(() => {
  jest.useRealTimers();
});

describe('a rich DocBuffer', () => {
  it('opens the document as a session, and derives text and dirt from it', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const { buf, painted } = rich(io);

    await buf.open(path);
    expect(buf.session).toBeDefined();
    expect(buf.implied).toBe('character');
    expect(buf.text).toBe(ORIGINAL);
    expect(buf.dirty).toBe(false);
    expect(() => {
      buf.text = 'typed';
    }).toThrow('edited through its session');

    const before = painted();
    await edit(buf, ORIGINAL, EDITED);
    expect(buf.text).toBe(EDITED);
    expect(buf.dirty).toBe(true);
    expect(painted()).toBeGreaterThan(before);

    buf.close();
    findSession(path)?.dispose();
  });

  it('shares one session between two buffers on one path, undo included', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const a = rich(io).buf;
    const b = rich(io).buf;

    await a.open(path);
    await b.open(path);
    expect(b.session).toBe(a.session);
    expect(io.reads).toBe(1);

    await edit(a, ORIGINAL, EDITED);
    expect(b.text).toBe(EDITED);
    expect(b.dirty).toBe(true);

    await undo(b);
    expect(a.text).toBe(ORIGINAL);
    // Dirt counts revisions rather than comparing text, so undoing back to what is on disk still
    // reads as unsaved; the save then writes the same bytes and commit-on-save records nothing
    expect(a.dirty).toBe(true);
    expect(await a.save()).toBe(true);
    expect(b.dirty).toBe(false);

    a.close();
    b.close();
    expect(findSession(path)).toBeUndefined();
  });

  it('saves through prepareSave, and refuses when a pending draft does', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const { buf } = rich(io);
    await buf.open(path);

    draft(buf, { status: 'conflict' });
    expect(buf.dirty).toBe(true);
    expect(await buf.save()).toBe(false);
    expect(buf.bad).toBe(true);
    expect(buf.note).toContain('conflict');
    expect(io.writes).toEqual([]);

    // A reason path.ux supplies reaches the note unchanged
    await buf.reload();
    draft(buf, { status: 'refused', reason: 'palette[0] is not a colour' });
    expect(await buf.save()).toBe(false);
    expect(buf.note).toBe('palette[0] is not a colour');

    await buf.reload();
    expect(buf.dirty).toBe(false);
    buf.close();
  });

  it('leaves the buffer dirty when an edit lands while the write is in flight', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const { buf } = rich(io);
    await buf.open(path);
    await edit(buf, ORIGINAL, EDITED);

    io.hold = true;
    const saving = buf.save();
    await io.parkedWrite();
    const later = EDITED.replace('More prose.', 'Even more.');
    await edit(buf, EDITED, later);
    io.hold = false;
    io.release();
    expect(await saving).toBe(true);

    expect(io.writes.map((w) => w.text)).toEqual([EDITED]);
    expect(buf.dirty).toBe(true);
    expect(await buf.save()).toBe(true);
    expect(io.writes.map((w) => w.text)).toEqual([EDITED, later]);
    expect(buf.dirty).toBe(false);
    buf.close();
  });

  it('refuses a save over a file that changed underneath, and keeps the edit', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const { buf } = rich(io);
    await buf.open(path);
    await edit(buf, ORIGINAL, EDITED);
    io.set(path, 'somebody else got there first');

    expect(await buf.save()).toBe(false);
    expect(buf.bad).toBe(true);
    expect(buf.note).toContain('changed underneath');
    expect(buf.text).toBe(EDITED);
    expect(buf.dirty).toBe(true);

    await buf.reload();
    buf.close();
  });

  it('says so rather than writing when nothing changed', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const { buf } = rich(io);
    await buf.open(path);

    expect(await buf.save()).toBe(false);
    expect(buf.note).toBe('Nothing to save');
    expect(buf.bad).toBe(false);
    buf.close();
  });

  it('keeps the session across its own write, and replaces it after another', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const { buf } = rich(io);
    await buf.open(path);
    await edit(buf, ORIGINAL, EDITED);
    expect(await buf.save()).toBe(true);

    // What main pushes back after the save is the buffer's own write
    const own = buf.session;
    buf.wrote([path]);
    await settle();
    expect(buf.session).toBe(own);
    await undo(buf);
    expect(buf.text).toBe(ORIGINAL);
    expect(buf.dirty).toBe(true);

    // A dirty buffer does not follow a write at all
    io.set(path, 'the agent rewrote it');
    buf.wrote([path]);
    await settle();
    expect(buf.text).toBe(ORIGINAL);
    expect(buf.session).toBe(own);

    // A clean one follows a write that is not its own, with a fresh session
    await buf.reload();
    const reloaded = buf.session;
    expect(reloaded).not.toBe(own);
    expect(own!.disposed).toBe(true);
    io.set(path, 'and again');
    buf.wrote([path]);
    await settle();
    expect(buf.session).not.toBe(reloaded);
    expect(reloaded!.disposed).toBe(true);
    expect(buf.text).toBe('and again');
    buf.close();
  });

  it('reload drops the session, and a second buffer on the path is reopened', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const a = rich(io).buf;
    const b = rich(io).buf;
    await a.open(path);
    await b.open(path);
    await edit(a, ORIGINAL, EDITED);
    const shared = a.session!;

    io.set(path, 'rewritten elsewhere');
    await a.reload();
    await settle();

    expect(shared.disposed).toBe(true);
    expect(a.text).toBe('rewritten elsewhere');
    expect(a.note).toBe('reloaded — unsaved draft discarded');
    expect(b.session).toBe(a.session);
    expect(b.text).toBe('rewritten elsewhere');
    a.close();
    b.close();
  });

  it('is counted by the quit guard while dirty, even after its pane closed', async () => {
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const { buf } = rich(io);
    await buf.open(path);
    const before = draftCount();

    await edit(buf, ORIGINAL, EDITED);
    expect(draftCount()).toBe(before + 1);

    buf.close();
    expect(findSession(path)).toBeDefined();
    expect(dirtySessionCount()).toBeGreaterThan(0);

    // Coming back finds the same session, edit and undo history intact
    await buf.open(path);
    expect(buf.text).toBe(EDITED);
    expect(io.reads).toBe(1);
    await undo(buf);
    expect(buf.text).toBe(ORIGINAL);
    expect(await buf.save()).toBe(true);
    expect(draftCount()).toBe(before);
    buf.close();
    expect(findSession(path)).toBeUndefined();
  });
});

describe('autosave', () => {
  it('saves a dirty rich buffer on the tick, marked auto, and leaves a clean one alone', async () => {
    jest.useFakeTimers();
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const { buf } = rich(io, AUTOSAVE_MS);
    await buf.open(path);

    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(io.writes).toEqual([]);

    await edit(buf, ORIGINAL, EDITED);
    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(io.writes).toEqual([{ text: EDITED, auto: true }]);
    expect(buf.dirty).toBe(false);

    // The undo history survives the autosave
    await undo(buf);
    expect(buf.text).toBe(ORIGINAL);
    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(io.writes).toHaveLength(2);
    buf.close();
  });

  it('skips a tick a pending draft refuses, and says why', async () => {
    jest.useFakeTimers();
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const { buf } = rich(io, AUTOSAVE_MS);
    await buf.open(path);
    draft(buf, { status: 'unencodable', reason: 'outfits is not valid JSON' });

    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(io.writes).toEqual([]);
    expect(buf.note).toBe('outfits is not valid JSON');
    expect(buf.bad).toBe(true);
    await buf.reload();
    buf.close();
  });

  it('still saves a document whose pane went away, then lets the session go', async () => {
    jest.useFakeTimers();
    const io = new FakeIo();
    const path = uniq();
    io.set(path, ORIGINAL);
    const { buf } = rich(io, AUTOSAVE_MS);
    await buf.open(path);
    await edit(buf, ORIGINAL, EDITED);
    buf.close();

    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(io.writes).toEqual([{ text: EDITED, auto: true }]);
    expect(findSession(path)).toBeUndefined();

    // A disposed entry ticks no more
    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    expect(io.writes).toHaveLength(1);
  });

  it('ticks a text buffer while its pane is open and stops when it closes', async () => {
    jest.useFakeTimers();
    const io = new FakeIo();
    const path = uniq();
    io.set(path, 'on disk');
    const buf = new DocBuffer(() => {}, io, { autosave: AUTOSAVE_MS });
    await buf.open(path);
    buf.text = 'typed';

    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(io.writes).toEqual([{ text: 'typed', auto: true }]);
    expect(buf.dirty).toBe(false);

    buf.text = 'typed more';
    buf.close();
    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    expect(io.writes).toHaveLength(1);
    expect(buf.dirty).toBe(true);

    // Coming back restores the draft and the timer with it
    await buf.open(path);
    expect(buf.text).toBe('typed more');
    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(io.writes).toHaveLength(2);
    expect(io.writes[1]).toEqual({ text: 'typed more', auto: true });
    buf.close();
  });
});
