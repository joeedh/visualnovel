import type { Button, Container } from 'pathux';
import { api } from '../../api.js';
import { ASSETSTRIP_CSS, renderAssetStrip } from '../assetstrip.js';
import { onInvalidate, onWrote } from '../bridge.js';
import { DocBuffer, WRITE_SUPPLIES } from '../docbuffer.js';
import { redrawing } from '../anchors.js';
import { assetGroups } from '../doctree.js';
import { VnEditor, registerEditor } from '../editor.js';
import { assetNode, openNode } from '../open.js';
import type { VnScreen } from '../screen.js';
import WIKI_CSS from '../../styles/wiki.css?inline';
import type { DocTree } from '../../../src/shared/ipc.js';

/**
 * One markdown document, as text. The story bible, a character sheet or a location sheet (whatever
 * `ui.docPath` names) is read through `doc.read` and saved through `doc.write`, so saving also
 * commits to git with no machinery of its own.
 *
 * This is not a form over `Character`. The author edits the markdown, so the front-matter sits in
 * the box with the prose and the model's reading of it arrives afterwards on the footer line. A
 * sheet whose fields are half-typed saves and says so, and a save is refused only when it would
 * destroy identity (unparseable front-matter, or a dropped `type:` tag). All three rules live in
 * the command; nothing here re-decides them.
 *
 * It does not read through `@vn/bible` either. That interface has no whole-file call, which is
 * what keeps whole documents out of a context window; a human reading their own note on screen is
 * a different case.
 *
 * Under the text sits what was drawn from this document: the assets bound to whatever subject the
 * file is, found by `DocTree.pathIndex`. For a lore note that is usually nothing, and the sentence
 * saying so is how an author sees that no art comes from the page. Which notes mention the subject
 * is a separate, ranked and budgeted question answered by `bible.search`, and is deliberately not
 * asked here.
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
   * The document in the box, which trails `ui.docPath` by one async read. The draft, the
   * `seenHash` refusal and the quit guard all live in `docbuffer.ts`; this pane owns the widgets
   * and nothing about the text.
   */
  private readonly buf = new DocBuffer(() => this.paint());

  static override define() {
    return {
      tagname: 'vn-wiki-editor-x',
      areaname: 'wiki',
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
    // Built once with the rest of this bar. The toggle keeps its own state, so it does not need
    // redrawing when the document changes underneath it.
    this.pinToggle(bar);
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
    // keys hands Ctrl+Z and the shell's other gestures away mid-edit. Ctrl+S is caught here so it saves the
    // document rather than reaching the browser's own save.
    this.text.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.buf.save();
      }
    });
    this.surface.appendChild(this.text);

    // The strip sits below the text and is height-bounded, so it cannot crowd the page text off
    // the screen
    this.strip = el('div', 'wk-strip') as HTMLDivElement;
    this.surface.appendChild(this.strip);

    const foot = el('div', 'wk-foot');
    this.pathEl = el('span', 'wk-path') as HTMLSpanElement;
    this.badge = el('span', 'wk-badge', 'unsaved') as HTMLSpanElement;
    this.noteEl = el('span', 'wk-note') as HTMLSpanElement;
    foot.append(this.pathEl, this.badge, this.noteEl);
    this.surface.appendChild(foot);

    this.appendSurface(this.surface);

    // A file this pane is showing can be written by something else: `gate.approve` rewrites
    // `character.md`, and so does the agent, whose writes are not commands at all.
    // `DocBuffer.wrote` decides what a clean buffer and a dirty buffer each do about it.
    this.watch(
      () => onWrote((paths) => this.buf.wrote(paths)),
      // The paths that moved while the pane was off screen are unknown, so the one it is showing
      // is re-read on the same terms
      () => this.buf.wrote([this.buf.path]),
    );

    // Generating a portrait while the character's sheet is open should make the portrait appear,
    // and generation does not write the open file, so the strip follows the coarser signal
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
   * Refetches the tree the strip reads. A failure stays silent, because the pane displays the
   * document in the box, not backlinks, and an author cannot act on a backlink panel that could
   * not be built while typing.
   */
  private async loadTree(): Promise<void> {
    try {
      this.tree = await api.invoke('workspace:doctree');
    } catch {
      this.tree = undefined;
    }
    this.paintStrip();
  }

  /** Opens the picture for a hash. The strip carries hashes where the tree carries rows. */
  private openAsset(hash: string): void {
    this.ui.assetHash = hash;
    this.announce();
    openNode(this.ctx?.screen as VnScreen | undefined, assetNode(hash));
  }

  private paint(): void {
    const open = this.buf.path !== '';
    this.empty.style.display = open ? 'none' : 'flex';
    this.text.style.display = open ? 'block' : 'none';
    // Assigned only when it differs, because assigning `value` moves the caret and the buffer
    // already holds what the author is typing
    if (this.text.value !== this.buf.text) this.text.value = this.buf.text;
    this.pathEl.textContent = open ? this.buf.path : '';
    this.pathEl.title = this.pathEl.textContent;
    this.badge.style.display = this.buf.dirty ? 'inline-block' : 'none';
    const save = this.buf.saveOffer;
    this.saveBtn.disabled = !save.ok;
    this.saveBtn.description = save.ok
      ? 'Write this document back to disk, and commit it'
      : save.reason;
    // Re-recorded on every paint rather than once with the bar: the bar is built at init and
    // the offer changes with the buffer, so a record kept from init would say `Nothing to save`
    // for the life of the pane.
    redrawing('wiki', 'bar').act(this.saveBtn, save, () => void this.buf.save(), {
      supplies: WRITE_SUPPLIES,
    });
    this.noteEl.textContent = this.buf.note;
    this.noteEl.className = this.buf.bad ? 'wk-note bad' : 'wk-note';
    this.noteEl.title = this.buf.note;
    this.paintStrip();
  }

  /**
   * What was drawn from the open document. `pathIndex` turns the path (the one thing this pane
   * knows) into the backlink key, so the editor needs no convention of its own. A file that is not
   * a subject has no key, and gets the `EMPTY` sentence instead.
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
 * Shown for most of the bible, because every binding in the manifest names a character, a
 * location, a scene or a shot, so no asset binds to a plain lore note. Saying so is clearer than
 * a strip that is sometimes missing with no stated reason.
 */
const EMPTY = 'Nothing has been drawn from this page.';

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(WikiEditor, 'vn.WikiEditor');
