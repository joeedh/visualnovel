/**
 * One markdown document, held as text: `doc.read` in, `doc.write` out, and the four rules that
 * make that safe. The Wiki pane and the Skills pane are both read → textarea → write, so this is
 * shared for correctness rather than for looks — every rule here loses an author's typing when a
 * copy of it drifts:
 *
 * - A save is refused by content. `seenHash` is what the read returned, so a file something else
 *   rewrote underneath is refused rather than overwritten. The buffer is never authoritative.
 * - An unsaved draft outlives the pane. Saving is an explicit act, so an unsaved buffer is a real
 *   state the author is in. The drafts map is module-level and there is exactly one of it.
 * - The `beforeunload` guard counts that one map. Two copies would each report their own
 *   `drafts.size`, and quitting with an unsaved draft in the other one would ask nothing.
 * - A read that lost its race is dropped. `token` rises per open, so a slow read for a document
 *   the author already left cannot land on top of the one they are looking at.
 *
 * The `io` seam exists so tests need no module mock: the desktop jest project is node-only, and
 * `bridge.js` reaches `window` through `api.js`.
 */
import { touches } from '../../../src/shared/writes.js';
import type { Offer } from '../../rules/anchors.js';
import type { DocFile, DocSaveResult } from '../../../src/shared/ipc.js';

/** The only two document commands a buffer needs from the app: reading and writing a file. */
export interface DocIo {
  read(path: string): Promise<{ ok: true; file: DocFile } | { ok: false; error: string }>;
  write(
    path: string,
    text: string,
    seenHash: string,
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
  async write(path, text, seenHash) {
    const { exec } = await import('../app/bridge.js');
    const outcome = await exec('doc.write', { path, text, seenHash });
    return outcome.ok
      ? { ok: true, saved: outcome.data as DocSaveResult }
      : { ok: false, error: outcome.error };
  },
};

/**
 * Unsaved text, by path, outliving the pane that holds it — and shared by every buffer, so the
 * same document open in two panes is one draft rather than two that overwrite each other.
 */
const drafts = new Map<string, { text: string; seenHash: string }>();

/** How many documents have unsaved text in them. Read by the quit guard and by tests. */
export function draftCount(): number {
  return drafts.size;
}

// Quitting is the one place a draft can still be lost: `on_remove` cannot refuse, but a
// `beforeunload` listener can, and `preventDefault` alone is the prompt in Chromium 119+ (Electron
// 33 is well past it). The `window` check is for the node-only jest project importing this module
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (drafts.size > 0) event.preventDefault();
  });
}

/** The text and the hash it was read at, both of which the buffer holds rather than the bar. */
export const WRITE_SUPPLIES = ['text', 'seenHash'];

export class DocBuffer {
  private shown = '';
  private buffer = '';
  private seenHash = '';
  private isDirty = false;
  private message = '';
  private isBad = false;
  /** Rising with every open, so a slow read for a document the author already left is dropped. */
  private token = 0;

  /** `onChange` asks the host to repaint: the buffer never touches the DOM and owns no widget. */
  constructor(
    private readonly onChange: () => void,
    private readonly io: DocIo = BRIDGE_IO,
  ) {}

  /** The document last asked for, which `text` catches up to when the read lands. */
  get path(): string {
    return this.shown;
  }

  get dirty(): boolean {
    return this.isDirty;
  }

  /** The most recent message about this buffer: a refusal, a diagnostic, or an empty string. */
  get note(): string {
    return this.message;
  }

  /**
   * What Save would run, or the sentence for why it is greyed. The host reads this for the button's
   * state and hands the same value to `act`, so the anchor cannot describe a save the click is not.
   */
  get saveOffer(): Offer {
    if (this.shown === '') return { ok: false, id: 'doc.write', reason: 'No document is open.' };
    if (!this.isDirty) return { ok: false, id: 'doc.write', reason: 'Nothing to save' };
    return { ok: true, id: 'doc.write', props: { path: this.shown }, label: 'Save' };
  }

  /** Whether `note` is a refusal rather than news. The host paints the two differently. */
  get bad(): boolean {
    return this.isBad;
  }

  get text(): string {
    return this.buffer;
  }

  /** Typing. Marks the buffer dirty and files the draft, which is what survives a pane switch. */
  set text(next: string) {
    if (this.shown === '') return;
    this.buffer = next;
    this.isDirty = true;
    drafts.set(this.shown, { text: next, seenHash: this.seenHash });
    this.say('');
  }

  /**
   * Show a document. A buffer the author had typed into and not saved is restored instead of
   * re-read: a pane that switched editors and came back would otherwise eat the edit silently,
   * and `on_remove` cannot veto its own removal to ask about it.
   */
  async open(path: string): Promise<void> {
    const mine = ++this.token;
    this.shown = path;
    this.message = '';
    this.isBad = false;

    if (path === '') {
      this.seenHash = '';
      this.buffer = '';
      this.isDirty = false;
      this.onChange();
      return;
    }

    const draft = drafts.get(path);
    if (draft) {
      this.seenHash = draft.seenHash;
      this.buffer = draft.text;
      this.isDirty = true;
      this.onChange();
      return;
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

    this.seenHash = outcome.file.hash;
    this.buffer = outcome.file.text;
    this.isDirty = false;
    this.onChange();
  }

  /**
   * Re-read from disk. Over a dirty buffer this drops the draft — that is what reload means, and
   * refusing would leave the author with no way back to what is on the file. It is an explicit
   * gesture, so it only says what it did rather than asking first.
   */
  async reload(): Promise<void> {
    const path = this.shown;
    if (path === '') return;
    const discarded = this.isDirty;
    drafts.delete(path);
    this.isDirty = false;
    await this.open(path);
    // A read that failed already left its own message, which is the more useful one
    if (discarded && this.message === '') this.say('reloaded — unsaved draft discarded');
  }

  /**
   * Write it back. `true` when the file is on disk, which is what a host needs to know before it
   * does anything else about the save. A refusal is kept in `note` rather than thrown: the
   * author's next act is to decide what to do about the file, not to retype it.
   */
  async save(): Promise<boolean> {
    if (this.shown === '') return false;
    if (!this.isDirty) {
      this.say('no changes');
      return false;
    }

    const path = this.shown;
    const outcome = await this.io.write(path, this.buffer, this.seenHash);
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
   * changed-underneath refusal.
   */
  wrote(paths: readonly string[]): void {
    if (!this.isDirty && this.shown !== '' && touches(paths, this.shown))
      void this.open(this.shown);
  }

  private say(text: string, bad = false): void {
    this.message = text;
    this.isBad = bad;
    this.onChange();
  }
}
