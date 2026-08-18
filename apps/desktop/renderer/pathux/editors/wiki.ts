import type { Button, Container } from 'pathux';
import { api } from '../../api.js';
import { ASSETSTRIP_CSS, renderAssetStrip } from '../assetstrip.js';
import { onInvalidate, onWrote } from '../bridge.js';
import { DocBuffer } from '../docbuffer.js';
import { assetGroups } from '../doctree.js';
import { VnEditor, registerEditor } from '../editor.js';
import { assetNode, openNode } from '../open.js';
import type { VnScreen } from '../screen.js';
import WIKI_CSS from '../../styles/wiki.css?inline';
import type { DocTree } from '../../../src/shared/ipc.js';

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

  /**
   * The document in the box, which trails `ui.docPath` by one async read. The draft it files, the
   * `seenHash` refusal it earns and the quit guard behind it are `docbuffer.ts`'s — this pane owns
   * the widgets and nothing about the text.
   */
  private readonly buf = new DocBuffer(() => this.paint());

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
    this.saveBtn = bar.button('Save', () => void this.buf.save());
    this.saveBtn.description = 'Write this document back to disk, and commit it';
    const reload = bar.button('⟳', () => void this.buf.reload());
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
    this.text.addEventListener('input', () => {
      this.buf.text = this.text.value;
    });
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys opens the palette on the first `/` of a sentence. Ctrl+S is caught here for the same
    // reason: it is the save gesture, and the browser's own is not.
    this.text.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.buf.save();
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
    // rewrites `character.md`, and so does the agent, whose writes are not commands at all. What
    // a clean and a dirty buffer each do about that is `DocBuffer.wrote`.
    this.watch(
      () => onWrote((paths) => this.buf.wrote(paths)),
      // Which paths moved while the pane was off screen is unknowable, so the one it is showing
      // is re-read on the same terms.
      () => this.buf.wrote([this.buf.path]),
    );

    // Generating a portrait while the character's sheet is open should make the portrait appear,
    // and generation is not a write to *this* file — so the strip follows the coarser signal.
    this.watch(
      () => onInvalidate(() => void this.loadTree()),
      () => void this.loadTree(),
    );
    void this.loadTree();

    this.paint();
  }

  override update() {
    super.update();

    if (this.ui.docPath !== this.buf.path) void this.buf.open(this.ui.docPath);
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

  private paint(): void {
    const open = this.buf.path !== '';
    this.empty.style.display = open ? 'none' : 'flex';
    this.text.style.display = open ? 'block' : 'none';
    // Only when it actually differs: assigning `value` moves the caret, and the buffer already
    // holds what the author is typing.
    if (this.text.value !== this.buf.text) this.text.value = this.buf.text;
    this.pathEl.textContent = open ? this.buf.path : '';
    this.pathEl.title = this.pathEl.textContent;
    this.badge.style.display = this.buf.dirty ? 'inline-block' : 'none';
    this.saveBtn.disabled = !this.buf.dirty;
    this.noteEl.textContent = this.buf.note;
    this.noteEl.className = this.buf.bad ? 'wk-note bad' : 'wk-note';
    this.noteEl.title = this.buf.note;
    this.paintStrip();
  }

  /**
   * What was drawn from the open document. `pathIndex` turns the one thing this pane knows — a
   * path — into the backlink key, so the editor needs no convention of its own; a file that is not
   * a subject has no key, and gets the sentence.
   */
  private paintStrip(): void {
    if (this.buf.path === '') {
      this.strip.style.display = 'none';
      return;
    }
    this.strip.style.display = 'block';
    const key = this.tree?.pathIndex[this.buf.path];
    const links = key === undefined ? undefined : this.tree?.backlinks[key];
    renderAssetStrip(this.strip, links ? assetGroups(links) : [], EMPTY, {
      onPick: (hash) => this.openAsset(hash),
    });
  }
}

/**
 * No asset binds to a plain lore note, and none ever will: every binding in the manifest names a
 * character, a location, a scene or a shot. So this is the honest answer for most of the bible,
 * and saying it is better than a strip that is sometimes missing for no stated reason.
 */
const EMPTY = 'Nothing has been drawn from this page.';

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(WikiEditor, 'vn.WikiEditor');
