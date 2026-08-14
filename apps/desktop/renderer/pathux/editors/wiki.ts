import type { Button, Container } from 'pathux';
import { exec, onWrote, say } from '../bridge.js';
import { VnEditor, registerEditor } from '../editor.js';
import { touches } from '../../../src/shared/writes.js';
import WIKI_CSS from '../../styles/wiki.css?inline';
import type { DocFile, DocSaveResult } from '../../../src/shared/ipc.js';

/**
 * One markdown document, as text. The story bible, a character sheet, a location sheet — whatever
 * `ui.docPath` names — read through `doc.read` and saved through `doc.write`, which is what makes
 * "the user saves it, saving also commits to git" true with no machinery of its own.
 *
 * It is **not** a form over `Character`. The requirement is that the author edits the markdown, so
 * the front-matter is in the box with the prose and the model's opinion of it arrives afterwards,
 * on the footer line: a sheet whose fields are half-typed saves and says so, and only a save that
 * would destroy identity — unparseable front-matter, or a dropped `type:` tag — is refused. All
 * three rules live in the command; nothing here re-decides them.
 *
 * It does not read through `@vn/bible` either. That interface has no whole-file call and the
 * absence is the guarantee — a human reading their own note on screen is not the context window.
 */
export class WikiEditor extends VnEditor {
  private surface!: HTMLDivElement;
  private text!: HTMLTextAreaElement;
  private empty!: HTMLDivElement;
  private pathEl!: HTMLSpanElement;
  private badge!: HTMLSpanElement;
  private noteEl!: HTMLSpanElement;
  private saveBtn!: Button;

  /** The document in the box, which trails `ui.docPath` by one async read. */
  private shown = '';
  private seenHash = '';
  private dirty = false;
  /** Rising with every load, so a slow read for a document the author already left is dropped. */
  private token = 0;
  private unwatch: (() => void) | undefined;

  static override define() {
    return {
      tagname: 'vn-wiki-editor-x',
      areaname: 'wiki',
      uiname: 'Wiki',
      icon: -1,
    };
  }

  override init() {
    super.init();

    const bar = (this.header as Container).row();
    bar.label('DOCUMENT').style['padding'] = '0px 8px';
    this.saveBtn = bar.button('Save', () => void this.save());
    const reload = bar.button('⟳', () => void this.reload());
    reload.description = 'Re-read this document from disk (discards an unsaved draft)';
    bar.flushUpdate();

    this.adoptStyle(WIKI_CSS);
    this.surface = el('div', 'wk-surface') as HTMLDivElement;

    this.empty = el(
      'div',
      'wk-empty',
      'No document selected. Open one from the palette: view.open(editor=wiki subject=wiki/…)',
    ) as HTMLDivElement;
    this.surface.appendChild(this.empty);

    this.text = document.createElement('textarea');
    this.text.className = 'wk-text';
    this.text.spellcheck = false;
    this.text.style.display = 'none';
    this.text.addEventListener('input', () => this.touched());
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys opens the palette on the first `/` of a sentence. Ctrl+S is caught here for the same
    // reason: it is the save gesture, and the browser's own is not.
    this.text.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.save();
      }
    });
    this.surface.appendChild(this.text);

    const foot = el('div', 'wk-foot');
    this.pathEl = el('span', 'wk-path') as HTMLSpanElement;
    this.badge = el('span', 'wk-badge', 'unsaved') as HTMLSpanElement;
    this.noteEl = el('span', 'wk-note') as HTMLSpanElement;
    foot.append(this.pathEl, this.badge, this.noteEl);
    this.surface.appendChild(foot);

    this.appendSurface(this.surface);

    // A file this pane is showing can be written by something else entirely — `gate.approve`
    // rewrites `character.md`, and so does the agent, whose writes are not commands at all. A
    // clean buffer follows; a dirty one does not, and its next save earns the changed-underneath
    // refusal, which is the honest outcome.
    this.unwatch = onWrote((paths) => {
      if (!this.dirty && this.shown && touches(paths, this.shown)) void this.load(this.shown);
    });

    this.paint();
  }

  override on_remove() {
    this.unwatch?.();
    this.unwatch = undefined;
    super.on_remove();
  }

  override update() {
    super.update();

    if (this.ui.docPath !== this.shown) void this.load(this.ui.docPath);
  }

  // -------------------------------------------------------------------------
  // Reading and writing
  // -------------------------------------------------------------------------

  /**
   * Show a document. A buffer the author had typed into and not saved is restored instead of
   * re-read: a pane that switched editors and came back would otherwise eat the edit silently,
   * and `on_remove` cannot veto its own removal to ask about it.
   */
  private async load(path: string): Promise<void> {
    const mine = ++this.token;
    this.shown = path;
    this.note('');

    if (path === '') {
      this.seenHash = '';
      this.dirty = false;
      this.paint();
      return;
    }

    const draft = drafts.get(path);
    if (draft) {
      this.seenHash = draft.seenHash;
      this.text.value = draft.text;
      this.dirty = true;
      this.paint();
      return;
    }

    const outcome = await exec('doc.read', { path });
    if (mine !== this.token) return;
    if (!outcome.ok) {
      this.seenHash = '';
      this.text.value = '';
      this.dirty = false;
      this.note(outcome.error, true);
      this.paint();
      return;
    }

    const file = outcome.data as DocFile;
    this.seenHash = file.hash;
    this.text.value = file.text;
    this.dirty = false;
    this.paint();
  }

  /**
   * Re-read from disk. Over a dirty buffer this drops the draft — that is what reload means, and
   * refusing would leave the author with no way back to what is on the file. It is an explicit
   * gesture, so it only says what it did rather than asking first.
   */
  private async reload(): Promise<void> {
    const path = this.shown;
    if (path === '') return;
    const discarded = this.dirty;
    drafts.delete(path);
    this.dirty = false;
    await this.load(path);
    // A read that failed already said so, and that sentence is the more useful one.
    if (discarded && this.noteEl.textContent === '') {
      this.note('reloaded — unsaved draft discarded');
    }
  }

  /**
   * Ctrl+S, and the header button. `seenHash` is what the read returned, so a file something else
   * rewrote underneath is refused by content rather than overwritten — the editor holds no
   * authoritative buffer and never claims to.
   */
  private async save(): Promise<void> {
    if (this.shown === '') return;
    if (!this.dirty) {
      this.note('no changes');
      return;
    }

    const path = this.shown;
    const outcome = await exec('doc.write', {
      path,
      text: this.text.value,
      seenHash: this.seenHash,
    });
    if (!outcome.ok) {
      // `exec` already put the refusal in the note frame; the footer keeps it in front of the
      // author, whose next act is to decide what to do about the file rather than retype it.
      this.note(outcome.error, true);
      return;
    }
    if (this.shown !== path) return;

    const saved = outcome.data as DocSaveResult;
    this.seenHash = saved.hash;
    this.dirty = false;
    drafts.delete(path);
    this.note(saved.diagnostic ?? '');
    if (!saved.diagnostic) say(`Saved ${saved.path}`);
    this.paint();
  }

  private touched(): void {
    if (this.shown === '') return;
    this.dirty = true;
    drafts.set(this.shown, { text: this.text.value, seenHash: this.seenHash });
    this.note('');
    this.paint();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private note(text: string, bad = false): void {
    this.noteEl.textContent = text;
    this.noteEl.className = bad ? 'wk-note bad' : 'wk-note';
    this.noteEl.title = text;
  }

  private paint(): void {
    const open = this.shown !== '';
    this.empty.style.display = open ? 'none' : 'flex';
    this.text.style.display = open ? 'block' : 'none';
    this.pathEl.textContent = open ? this.shown : '';
    this.pathEl.title = this.pathEl.textContent;
    this.badge.style.display = this.dirty ? 'inline-block' : 'none';
    this.saveBtn.disabled = !this.dirty;
  }
}

/**
 * Unsaved text, by path, outliving the pane that holds it. Saving is an explicit act (decision 10
 * of the plan) so an unsaved buffer is a real state the author is in, and losing it to a pane
 * switch would make the explicit act a trap rather than a choice.
 */
const drafts = new Map<string, { text: string; seenHash: string }>();

// The one place a draft can still be lost: quitting. `on_remove` cannot refuse, but this can —
// `preventDefault` alone is the prompt in Chromium 119+, which Electron 33 is well past.
window.addEventListener('beforeunload', (event) => {
  if (drafts.size > 0) event.preventDefault();
});

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(WikiEditor, 'vn.WikiEditor');
