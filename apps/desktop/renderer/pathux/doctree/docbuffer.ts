/**
 * One markdown document, held as text or as a rich session: `doc.read` in, `doc.write` out, and
 * the four rules that make that safe. The Wiki pane and the Skills pane are both read → edit →
 * write, so this is shared for correctness rather than for looks — every rule here loses an
 * author's typing when a copy of it drifts:
 *
 * - A save is refused by content. `seenHash` is what the read returned, so a file something else
 *   rewrote underneath is refused rather than overwritten. The buffer is never authoritative.
 * - An unsaved draft outlives the pane. Saving is an explicit act, so an unsaved buffer is a real
 *   state the author is in. The drafts map is module-level and there is exactly one of it, and
 *   the rich sessions of `docsession.ts` are kept the same way.
 * - The `beforeunload` guard counts that one map and those sessions. Two copies would each report
 *   their own, and quitting with an unsaved draft in the other one would ask nothing.
 * - A read that lost its race is dropped. `token` rises per open, so a slow read for a document
 *   the author already left cannot land on top of the one they are looking at.
 *
 * A buffer built with `rich` holds its document as a path.ux `DocumentSession` from
 * `docsession.ts` rather than as text: the pane binds `session` to the editor, `text` is derived
 * on demand, and `dirty` is the session's. The save, reload and quit rules are the same ones.
 *
 * The `io` seam exists so tests need no module mock: the desktop jest project is node-only, and
 * `bridge.js` reaches `window` through `api.js`.
 */
import type { DocumentProvider, DocumentSession, MdDoc } from 'pathux-richtext-headless';
import { touches } from '../../../src/shared/writes.js';
import type { Offer } from '../../rules/anchors.js';
import { saveOffer } from '../../rules/docbuffer.js';
import type { DocFile, DocSaveResult } from '../../../src/shared/ipc.js';
import {
  dirtySessionCount,
  dirtySessionPaths,
  dirtySessions,
  findSession,
  openSession,
  type DocSession,
  type SaveResult,
  type SessionHolder,
} from './docsession.js';

/** The only two document commands a buffer needs from the app: reading and writing a file. */
export interface DocIo {
  read(path: string): Promise<{ ok: true; file: DocFile } | { ok: false; error: string }>;
  write(
    path: string,
    text: string,
    seenHash: string,
    auto: boolean,
  ): Promise<{ ok: true; saved: DocSaveResult } | { ok: false; error: string }>;
}

/**
 * The real implementation: the two commands, over the command bridge.
 *
 * `bridge.js` is reached by `await import` rather than at the top of this file so that a test can
 * construct a `DocBuffer` at all: `bridge.js` → `api.js` reads `window.api` while its module body
 * runs, and the desktop jest project is node-only. A static import would make every `DocBuffer`
 * test a module mock, which is what the `io` seam exists to avoid. Nothing is code-split by it in
 * the app — every editor imports `bridge.js` outright, so it is already in the shell chunk.
 */
export const BRIDGE_IO: DocIo = {
  async read(path) {
    const { exec } = await import('../app/bridge.js');
    const outcome = await exec('doc.read', { path });
    return outcome.ok
      ? { ok: true, file: outcome.data as DocFile }
      : { ok: false, error: outcome.error };
  },
  async write(path, text, seenHash, auto) {
    const { exec } = await import('../app/bridge.js');
    const outcome = await exec('doc.write', { path, text, seenHash, auto });
    return outcome.ok
      ? { ok: true, saved: outcome.data as DocSaveResult }
      : { ok: false, error: outcome.error };
  },
};

/** How long a dirty buffer waits before saving itself. */
export const AUTOSAVE_MS = 60_000;

export interface DocBufferOptions {
  /**
   * Hold the document as a rich session rather than as text, rendered through the provider this
   * builds for its path. Called once per session, so a provider closes over the session's own
   * document and never over the pane's, which may be showing another one by the time a second
   * pane adopts the session.
   */
  rich?: (path: string) => DocumentProvider<MdDoc>;
  /** Save a dirty buffer every this many milliseconds; a clean one is left alone. */
  autosave?: number;
}

/**
 * Unsaved text, by path, outliving the pane that holds it — and shared by every buffer, so the
 * same document open in two panes is one draft rather than two that overwrite each other.
 */
const drafts = new Map<string, { text: string; seenHash: string }>();

/** How many documents have unsaved edits, as text drafts or dirty sessions. Read by the quit guard and by tests. */
export function draftCount(): number {
  return drafts.size + dirtySessionCount();
}

/** The workspace paths of every document with unsaved edits, text drafts first. */
export function draftPaths(): string[] {
  return [...new Set([...drafts.keys(), ...dirtySessionPaths()])];
}

/**
 * Every buffer built so far, weakly, so Save All can save through the buffer a pane holds — which
 * keeps that pane's `seenHash` and dirty flag right — and write the rest of the drafts directly.
 */
const buffers = new Set<WeakRef<DocBuffer>>();

/** The outcome of one Save All: the documents written, and the ones refused, each with the reason. */
export interface SaveAllResult {
  saved: string[];
  refused: { path: string; reason: string }[];
}

/**
 * Save every unsaved document: each dirty rich session, each text draft through the buffer
 * showing it, and each text draft whose pane has closed through `io` directly. A refusal on one
 * document does not stop the others.
 */
export async function saveAllDrafts(io: DocIo = BRIDGE_IO): Promise<SaveAllResult> {
  const result: SaveAllResult = { saved: [], refused: [] };
  const held = new Set<string>();
  for (const ref of buffers) {
    const buffer = ref.deref();
    if (buffer === undefined) {
      buffers.delete(ref);
      continue;
    }
    if (buffer.path === '' || !buffer.dirty) continue;
    held.add(buffer.path);
    if (await buffer.save()) result.saved.push(buffer.path);
    else result.refused.push({ path: buffer.path, reason: buffer.note || 'the save was refused' });
  }
  for (const entry of dirtySessions()) {
    if (held.has(entry.path)) continue;
    const saved = await entry.save(false);
    if (saved.status === 'saved') result.saved.push(entry.path);
    else if (saved.status === 'refused')
      result.refused.push({ path: entry.path, reason: saved.reason });
  }
  for (const [path, draft] of [...drafts]) {
    if (held.has(path)) continue;
    const outcome = await io.write(path, draft.text, draft.seenHash, false);
    if (outcome.ok) {
      drafts.delete(path);
      result.saved.push(path);
    } else {
      result.refused.push({ path, reason: outcome.error });
    }
  }
  return result;
}

/**
 * What the shell does when a quit was refused over unsaved edits, given their paths: it points
 * the author at the pane holding them. Installed by the shell, since this module cannot reach
 * the screen.
 */
let onUnloadRefused: ((paths: string[]) => void) | undefined;

export function setUnloadRefusedHook(hook: ((paths: string[]) => void) | undefined): void {
  onUnloadRefused = hook;
}

// Quitting is the one place a draft can still be lost: `on_remove` cannot refuse, but a
// `beforeunload` listener can, and `preventDefault` alone is the prompt in Chromium 119+ (Electron
// 33 is well past it). The check is for the node-only jest project importing this module, where
// path.ux's headless polyfill has aliased `window` to a `globalThis` with no events
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', (event) => {
    if (draftCount() === 0) return;
    event.preventDefault();
    onUnloadRefused?.(draftPaths());
  });
}

export class DocBuffer implements SessionHolder {
  private shown = '';
  private buffer = '';
  private seenHash = '';
  private isDirty = false;
  private message = '';
  private isBad = false;
  /** Rising with every open, so a slow read for a document the author already left is dropped. */
  private token = 0;
  /** The session entry held under `rich`, from the open that last landed. */
  private entry: DocSession | undefined;
  /** The text buffer's own autosave; a rich buffer's is its session entry's. */
  private timer: ReturnType<typeof setInterval> | undefined;

  /** `onChange` asks the host to repaint: the buffer never touches the DOM and owns no widget. */
  constructor(
    private readonly onChange: () => void,
    private readonly io: DocIo = BRIDGE_IO,
    private readonly options: DocBufferOptions = {},
  ) {
    buffers.add(new WeakRef(this));
  }

  /** The document last asked for, which `text` catches up to when the read lands. */
  get path(): string {
    return this.shown;
  }

  get dirty(): boolean {
    return this.entry ? this.entry.dirty : this.isDirty;
  }

  /** The most recent message about this buffer: a refusal, a diagnostic, or an empty string. */
  get note(): string {
    return this.message;
  }

  /**
   * What Save would run, or the sentence for why it is greyed. The host hands it to `act`, which
   * greys and titles the button from it, so the anchor cannot describe a save the click is not.
   * The text and the hash it was read at are the buffer's rather than the bar's, so the click
   * supplies them.
   */
  get saveOffer(): Offer {
    return saveOffer(this.shown, this.dirty);
  }

  /** Whether `note` is a refusal rather than news. The host paints the two differently. */
  get bad(): boolean {
    return this.isBad;
  }

  /** The session the pane binds its editor to; undefined with no document open, or as text. */
  get session(): DocumentSession<MdDoc> | undefined {
    return this.entry?.session;
  }

  /** The kind the open document's location implies, for the form selection. */
  get implied(): DocFile['implied'] {
    return this.entry?.implied;
  }

  get text(): string {
    return this.entry ? this.entry.text : this.buffer;
  }

  /** Typing. Marks the buffer dirty and files the draft, which is what survives a pane switch. */
  set text(next: string) {
    if (this.options.rich) throw new Error('A rich buffer is edited through its session');
    if (this.shown === '') return;
    this.buffer = next;
    this.isDirty = true;
    drafts.set(this.shown, { text: next, seenHash: this.seenHash });
    this.say('');
  }

  /**
   * Show a document. A buffer the author had typed into and not saved is restored instead of
   * re-read: a pane that switched editors and came back would otherwise eat the edit silently,
   * and `on_remove` cannot veto its own removal to ask about it. Under `rich` the restored state
   * is the session entry, which a pane on the same path may already hold.
   */
  async open(path: string): Promise<void> {
    const mine = ++this.token;
    this.shown = path;
    this.message = '';
    this.isBad = false;
    this.leave();

    if (path === '') {
      this.seenHash = '';
      this.buffer = '';
      this.isDirty = false;
      this.disarm();
      this.onChange();
      return;
    }

    if (this.options.rich) {
      const held = findSession(path);
      if (held) {
        this.adopt(held);
        return;
      }
    } else {
      const draft = drafts.get(path);
      if (draft) {
        this.seenHash = draft.seenHash;
        this.buffer = draft.text;
        this.isDirty = true;
        this.arm();
        this.onChange();
        return;
      }
    }

    const outcome = await this.io.read(path);
    if (mine !== this.token) return;
    if (!outcome.ok) {
      this.seenHash = '';
      this.buffer = '';
      this.isDirty = false;
      this.say(outcome.error, true);
      return;
    }

    if (this.options.rich) {
      this.adopt(this.entryFor(path, outcome.file));
      return;
    }
    this.seenHash = outcome.file.hash;
    this.buffer = outcome.file.text;
    this.isDirty = false;
    this.arm();
    this.onChange();
  }

  /**
   * The pane holding this buffer went off screen. A text buffer stops its autosave; a rich one
   * lets go of its session entry, which is disposed if nothing else holds it and it is clean.
   * `open` resumes either.
   */
  close(): void {
    this.leave();
    this.disarm();
  }

  /**
   * Re-read from disk. Over a dirty buffer this drops the draft — that is what reload means, and
   * refusing would leave the author with no way back to what is on the file. It is an explicit
   * gesture, so it only says what it did rather than asking first. Under `rich` the session goes
   * with the draft, undo history included, and another pane on the same path reopens it.
   */
  async reload(): Promise<void> {
    const path = this.shown;
    if (path === '') return;
    const discarded = this.dirty;
    drafts.delete(path);
    this.isDirty = false;
    const entry = this.entry;
    this.leave();
    entry?.dispose();
    await this.open(path);
    // A read that failed already left its own message, which is the more useful one
    if (discarded && this.message === '') this.say('reloaded — unsaved draft discarded');
  }

  /**
   * Write it back. `true` when the file is on disk, which is what a host needs to know before it
   * does anything else about the save. A refusal is kept in `note` rather than thrown: the
   * author's next act is to decide what to do about the file, not to retype it. `auto` marks an
   * autosave tick, which the commit then says.
   */
  async save(auto = false): Promise<boolean> {
    if (this.entry) return (await this.entry.save(auto)).status === 'saved';

    const offer = this.saveOffer;
    if (!offer.ok) {
      // Spoken only over an open file: with nothing on screen there is no document to say it about
      if (this.shown !== '') this.say(offer.refusal.reason);
      return false;
    }

    const path = this.shown;
    const outcome = await this.io.write(path, this.buffer, this.seenHash, auto);
    if (!outcome.ok) {
      this.say(outcome.error, true);
      return false;
    }
    // The author left while the write was in flight. The write stands, but nothing about the
    // document now on screen may be overwritten by an answer about a different one
    if (this.shown !== path) return true;

    this.seenHash = outcome.saved.hash;
    this.isDirty = false;
    drafts.delete(path);
    // Nothing is said here on success: `doc.write` is mutating, so main files the save and pushes
    // it back, and that push carries the message. A second one would show the same save twice
    this.say(outcome.saved.diagnostic ?? '');
    return true;
  }

  /**
   * Something else wrote to disk. A file this pane is showing can be written by anything —
   * `gate.approve` rewrites `character.md`, and so does the agent, whose writes are not commands at
   * all. A clean buffer re-reads; a dirty one does not, and its next save gets the
   * changed-underneath refusal. A rich buffer keeps its session, undo history and all, when what
   * came back is its own last save, which is the commonest write it hears about.
   */
  wrote(paths: readonly string[]): void {
    if (this.dirty || this.shown === '' || !touches(paths, this.shown)) return;
    if (!this.entry) {
      void this.open(this.shown);
      return;
    }
    void this.follow(this.entry);
  }

  private async follow(entry: DocSession): Promise<void> {
    const mine = this.token;
    const outcome = await this.io.read(entry.path);
    if (mine !== this.token || this.entry !== entry) return;
    if (!outcome.ok) {
      this.say(outcome.error, true);
      return;
    }
    if (outcome.file.hash === entry.seenHash) return;
    this.leave();
    entry.dispose();
    this.adopt(this.entryFor(entry.path, outcome.file));
  }

  /** The entry to hold for `path`: the one a pane already holds, or one made from `file`. */
  private entryFor(path: string, file: DocFile): DocSession {
    return openSession(
      path,
      file,
      () => this.options.rich!(path),
      (target, text, seenHash, auto) => this.io.write(target, text, seenHash, auto),
      this.options.autosave,
    );
  }

  private adopt(entry: DocSession): void {
    this.entry = entry;
    entry.hold(this);
    this.onChange();
  }

  private leave(): void {
    const entry = this.entry;
    this.entry = undefined;
    entry?.release(this);
  }

  /** Start the text buffer's autosave, once, while a document is open. */
  private arm(): void {
    if (this.options.autosave === undefined || this.timer !== undefined) return;
    this.timer = setInterval(() => {
      if (this.isDirty) void this.save(true);
    }, this.options.autosave);
  }

  private disarm(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The session took an edit: the note is stale, as it is after a keystroke in the text form. */
  changed(): void {
    this.say('');
  }

  /** A save ran on the session, this buffer's own or the tick's; the note says what it came to. */
  saved(result: SaveResult): void {
    switch (result.status) {
      case 'saved':
        // Nothing more is said on success: main files the save and pushes it back with its message
        this.say(result.diagnostic ?? '');
        return;
      case 'clean': {
        const offer = this.saveOffer;
        this.say(offer.ok ? '' : offer.refusal.reason);
        return;
      }
      case 'refused':
        this.say(result.reason, true);
    }
  }

  /** Another pane reloaded the document out from under this one, so it is opened again. */
  evicted(): void {
    this.entry = undefined;
    void this.open(this.shown);
  }

  private say(text: string, bad = false): void {
    this.message = text;
    this.isBad = bad;
    this.onChange();
  }
}
