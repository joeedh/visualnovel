import type { Button, Container } from 'pathux';
import { api } from '../../api.js';
import { ASSETSTRIP_CSS, renderAssetStrip } from '../assetstrip.js';
import { exec, onInvalidate, onWrote } from '../bridge.js';
import { assetGroups } from '../doctree.js';
import { VnEditor, registerEditor } from '../editor.js';
import { assetNode, openNode } from '../open.js';
import type { VnScreen } from '../screen.js';
import { touches } from '../../../src/shared/writes.js';
import WIKI_CSS from '../../styles/wiki.css?inline';
import type { DocFile, DocSaveResult, DocTree } from '../../../src/shared/ipc.js';

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
 *
 * Under the text sits what was *drawn from* this document — the assets bound to whatever subject
 * the file is, found by `DocTree.pathIndex`. For a lore note that is honestly nothing, and the
 * sentence saying so is the feature: it is how an author sees that a page no art comes from is
 * exactly that. Which notes merely *mention* the subject is `bible.search` — ranked, budgeted, a
 * different question — and is deliberately not asked here.
 */
export class WikiEditor extends VnEditor {
  private surface!: HTMLDivElement;
  private text!: HTMLTextAreaElement;
  private empty!: HTMLDivElement;
  private strip!: HTMLDivElement;
  private pathEl!: HTMLSpanElement;
  private badge!: HTMLSpanElement;
  private noteEl!: HTMLSpanElement;
  private saveBtn!: Button;

  /** The tree the strip is read out of. One fetch per invalidation, not one per document. */
  private tree: DocTree | undefined;
  private unwatchTree: (() => void) | undefined;

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
    this.saveBtn.description = 'Write this document back to disk, and commit it';
    const reload = bar.button('⟳', () => void this.reload());
    reload.description = 'Re-read this document from disk (discards an unsaved draft)';
    bar.flushUpdate();

    this.adoptStyle(WIKI_CSS);
    this.adoptStyle(ASSETSTRIP_CSS);
    this.surface = el('div', 'wk-surface') as HTMLDivElement;

    this.empty = el(
      'div',
      'wk-empty',
      'No document selected. Open one from the palette: view.open(editor=wiki subject=wiki/…)',
    ) as HTMLDivElement;
    this.surface.appendChild(this.empty);

    this.text = document.createElement('textarea');
    this.text.className = 'wk-text';
    this.text.title =
      'Edit the document as markdown, front-matter and all. Ctrl+S saves and commits.';
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

    // Bounded and below: what was drawn from a page must never grow until the page has nowhere
    // left to be read.
    this.strip = el('div', 'wk-strip') as HTMLDivElement;
    this.surface.appendChild(this.strip);

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

    // Generating a portrait while the character's sheet is open should make the portrait appear,
    // and generation is not a write to *this* file — so the strip follows the coarser signal.
    this.unwatchTree = onInvalidate(() => void this.loadTree());
    void this.loadTree();

    this.paint();
  }

  override on_remove() {
    this.unwatch?.();
    this.unwatch = undefined;
    this.unwatchTree?.();
    this.unwatchTree = undefined;
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
    // No sentence from here: `doc.save` is mutating, so main filed it and pushed it back, and the
    // push is what says it. A second one here would show the same save twice.
    this.note(saved.diagnostic ?? '');
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

  /**
   * Refetch the tree the strip reads. A failure is silence rather than a message: the pane's job
   * is the document in the box, and a backlink panel that could not be built is not news the
   * author can act on while typing.
   */
  private async loadTree(): Promise<void> {
    try {
      this.tree = await api.invoke('workspace:doctree');
    } catch {
      this.tree = undefined;
    }
    this.paintStrip();
  }

  /** The picture, for a strip that has a hash where the tree has a row. */
  private openAsset(hash: string): void {
    this.ui.assetHash = hash;
    this.announce();
    openNode(this.ctx?.screen as VnScreen | undefined, assetNode(hash));
  }

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
    this.paintStrip();
  }

  /**
   * What was drawn from the open document. `pathIndex` turns the one thing this pane knows — a
   * path — into the backlink key, so the editor needs no convention of its own; a file that is not
   * a subject has no key, and gets the sentence.
   */
  private paintStrip(): void {
    if (this.shown === '') {
      this.strip.style.display = 'none';
      return;
    }
    this.strip.style.display = 'block';
    const key = this.tree?.pathIndex[this.shown];
    const links = key === undefined ? undefined : this.tree?.backlinks[key];
    renderAssetStrip(this.strip, links ? assetGroups(links) : [], EMPTY, {
      onPick: (hash) => this.openAsset(hash),
    });
  }
}

/**
 * Unsaved text, by path, outliving the pane that holds it. Saving is an explicit act (decision 10
 * of the plan) so an unsaved buffer is a real state the author is in, and losing it to a pane
 * switch would make the explicit act a trap rather than a choice.
 */
const drafts = new Map<string, { text: string; seenHash: string }>();

/**
 * No asset binds to a plain lore note, and none ever will: every binding in the manifest names a
 * character, a location, a scene or a shot. So this is the honest answer for most of the bible,
 * and saying it is better than a strip that is sometimes missing for no stated reason.
 */
const EMPTY = 'Nothing has been drawn from this page.';

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
