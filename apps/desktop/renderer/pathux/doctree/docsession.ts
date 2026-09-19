/**
 * One rich document per path, outliving the panes that show it: path.ux's `DocumentSession` on a
 * toolstack of its own, the hash the file was read at, the revision last written to disk, and the
 * autosave timer. Two buffers on one path hold one entry, so they see each other's edits live and
 * share one undo history. An entry is disposed when nothing holds it and nothing in it is unsaved;
 * a dirty one outlives its panes, so a document the author typed into and switched away from is
 * still autosaved, and still counted by the quit guard.
 *
 * Imports only path.ux's DOM-free entry, so the rules here run under the node-only jest project.
 * The provider, which renders and so reaches the DOM, is handed in by the pane.
 */
import {
  DocumentSession,
  ToolStack,
  markdownSourceDoc,
  markdownText,
  type DocumentProvider,
  type MdDoc,
  type PrepareSaveResult,
} from 'pathux-richtext-headless';
import type { DocFile, DocSaveResult } from '../../../src/shared/ipc.js';

/** `doc.write`, as an entry calls it: `auto` marks an autosave tick, and the commit says so. */
export type DocWrite = (
  path: string,
  text: string,
  seenHash: string,
  auto: boolean,
) => Promise<{ ok: true; saved: DocSaveResult } | { ok: false; error: string }>;

/** What one save attempt came to, reported to every buffer holding the entry. */
export type SaveResult =
  | { status: 'saved'; diagnostic: string | undefined }
  | { status: 'clean' }
  | { status: 'refused'; reason: string };

/** A buffer holding an entry, told what happens to the document while it holds it. */
export interface SessionHolder {
  /** An edit, undo or redo landed on the session. */
  changed(): void;
  /** A save ran, this holder's own or a tick's. */
  saved(result: SaveResult): void;
  /** Another holder disposed the entry, so this one must open the path again. */
  evicted(): void;
}

const sessions = new Map<string, DocSession>();

/** The entry open on `path`, if any buffer holds one or a dirty one survives its panes. */
export function findSession(path: string): DocSession | undefined {
  return sessions.get(path);
}

/** How many documents have unsaved edits in a session. Read by the quit guard and by tests. */
export function dirtySessionCount(): number {
  let count = 0;
  for (const entry of sessions.values()) if (entry.dirty) count++;
  return count;
}

/**
 * The entry for `path`, created from `file` when none exists. A buffer whose read lands second
 * adopts the first buffer's entry, so two panes opening one document at once still share it.
 */
export function openSession(
  path: string,
  file: DocFile,
  provider: DocumentProvider<MdDoc>,
  write: DocWrite,
  autosave: number | undefined,
): DocSession {
  const existing = sessions.get(path);
  if (existing) return existing;
  const entry = new DocSession(path, file, provider, write, autosave);
  sessions.set(path, entry);
  return entry;
}

/** The sentence a save refused by `prepareSave` carries into the footer. */
export function refusalOf(prepared: Exclude<PrepareSaveResult, { status: 'ready' }>): string {
  if (prepared.reason) return prepared.reason;
  switch (prepared.status) {
    case 'refused':
      return 'Answers typed into a form that has since closed could not be applied; discard them or open the form again';
    case 'conflict':
      return 'Pending answers conflict with a change to the document; check them and save again';
    case 'unencodable':
      return 'A pending answer cannot be written into the front matter';
  }
}

export class DocSession {
  readonly session: DocumentSession<MdDoc>;
  readonly stack = new ToolStack();
  readonly implied: DocFile['implied'];
  /** What the file hashed to when it was last read or written, which the next write presents. */
  seenHash: string;
  /** The session revision that is on disk. */
  private loaded = 0;
  private readonly holders = new Set<SessionHolder>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private saving: Promise<SaveResult> | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    readonly path: string,
    file: DocFile,
    provider: DocumentProvider<MdDoc>,
    private readonly write: DocWrite,
    autosave: number | undefined,
  ) {
    this.session = new DocumentSession(markdownSourceDoc(file.text), provider, this.stack);
    this.seenHash = file.hash;
    this.implied = file.implied;
    this.unsubscribe = this.session.onChange((_change, info) => {
      if (info.origin === 'policy') return;
      for (const holder of this.holders) holder.changed();
    });
    if (autosave !== undefined) {
      this.timer = setInterval(() => {
        if (this.dirty && !this.saving) void this.save(true);
      }, autosave);
    }
  }

  get disposed(): boolean {
    return this.session.disposed;
  }

  /** Whether an edit or a pending form answer is not yet on disk. */
  get dirty(): boolean {
    return this.session.revision !== this.loaded || this.session.pendingDrafts.length > 0;
  }

  /** The document as Markdown source, serialized on demand rather than per keystroke. */
  get text(): string {
    return markdownText(this.session.doc);
  }

  hold(holder: SessionHolder): void {
    this.holders.add(holder);
  }

  /** Let go. The entry stays while a pane holds it or an edit is unsaved, and is disposed otherwise. */
  release(holder: SessionHolder): void {
    this.holders.delete(holder);
    if (this.holders.size === 0 && !this.dirty) this.dispose();
  }

  /**
   * Write the document back. Pending form answers are applied first through `prepareSave`, and a
   * refusal there is the result. Only a write that landed advances `seenHash` and the revision on
   * disk; an edit that arrived while the write was in flight leaves the entry dirty. Two callers at
   * once, the tick and the button, share one attempt.
   */
  save(auto: boolean): Promise<SaveResult> {
    return (this.saving ??= this.attempt(auto).finally(() => {
      this.saving = undefined;
    }));
  }

  private async attempt(auto: boolean): Promise<SaveResult> {
    const result = await this.run(auto);
    for (const holder of this.holders) holder.saved(result);
    // A tick that left a dirty, unheld entry clean is the last thing keeping it
    if (this.holders.size === 0 && !this.dirty) this.dispose();
    return result;
  }

  private async run(auto: boolean): Promise<SaveResult> {
    const prepared = await this.session.prepareSave();
    if (this.disposed) return { status: 'refused', reason: 'The document was closed' };
    if (prepared.status !== 'ready') return { status: 'refused', reason: refusalOf(prepared) };
    if (prepared.revision === this.loaded) return { status: 'clean' };
    const outcome = await this.write(this.path, this.text, this.seenHash, auto);
    if (!outcome.ok) return { status: 'refused', reason: outcome.error };
    this.seenHash = outcome.saved.hash;
    this.loaded = prepared.revision;
    return { status: 'saved', diagnostic: outcome.saved.diagnostic };
  }

  /** Close the document: its undo history and any pending answers go with it. */
  dispose(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe();
    this.session.dispose();
    if (sessions.get(this.path) === this) sessions.delete(this.path);
    const evicted = [...this.holders];
    this.holders.clear();
    for (const holder of evicted) holder.evicted();
  }
}
