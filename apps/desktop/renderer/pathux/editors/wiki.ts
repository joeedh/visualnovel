import { UIBase, type Button, type Container, type ContextLike, type RichTextEditor } from 'pathux';
import { MarkdownProvider } from 'pathux-richtext-markdown';
import { nativeFormWidgets } from 'pathux-richtext-forms';
import type { DocRange, DocumentSession, JsonValue, MdDoc } from 'pathux-richtext-headless';
import { frontmatterCodec } from '@vn/parse';
import { api } from '../../api.js';
import { ASSETSTRIP_CSS, renderAssetStrip } from '../assets/assetstrip.js';
import { cellAction } from '../../rules/assetstrip.js';
import { RELOAD_TIP, TEXT_TIP, discardOffer } from '../../rules/wiki.js';
import { reloadOffer, textBox } from '../../rules/docbuffer.js';
import { visibleEditors } from '../panes/route.js';
import { panesOf } from '../panes/view.js';
import { onInvalidate, onWrote } from '../app/bridge.js';
import { AUTOSAVE_MS, BRIDGE_IO, DocBuffer } from '../doctree/docbuffer.js';
import { selectForm, type DocForm } from '../doctree/docforms.js';
import { redrawing } from '../tour/anchors.js';
import { assetGroups } from '../doctree/doctree.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import { assetNode, openNode } from '../panes/open.js';
import type { VnScreen } from '../app/screen.js';
import WIKI_CSS from '../../styles/wiki.css?inline';
import type { DocTree } from '../../../src/shared/ipc.js';

/**
 * One markdown document, in path.ux's rich text editor. The story bible, a character sheet or a
 * location sheet (whatever `ui.docPath` names) is read through `doc.read` into a session held by
 * `docbuffer.ts`, edited in place, and saved through `doc.write`, so saving also commits to git
 * with no machinery of its own.
 *
 * A sheet's front matter is shown as a form in the place the YAML block occupies, over the same
 * session and undo history as the prose: `nativeFormWidgets` mounts it when `selectForm` picks
 * one for the document's kind, and the app's codec patches the YAML in place so comments, quoting
 * and unknown keys survive an edit made through the form. A note, a sheet whose location and tag
 * disagree, and a file whose fence is not on its first line keep the raw block, and the footer says
 * why. The model's own reading of a saved sheet still arrives afterwards on the same footer line.
 *
 * It does not read through `@vn/bible`. That interface has no whole-file call, which is what keeps
 * whole documents out of a context window; a human reading their own note on screen is a
 * different case.
 *
 * Under the text sits what was drawn from this document: the assets bound to whatever subject the
 * file is, found by `DocTree.pathIndex`. For a lore note that is usually nothing, and the sentence
 * saying so is how an author sees that no art comes from the page. Which notes mention the subject
 * is a separate, ranked and budgeted question answered by `bible.search`, and is deliberately not
 * asked here.
 */
export class WikiEditor extends VnEditor {
  private surface!: HTMLDivElement;
  private editor!: RichTextEditor<ContextLike, MdDoc>;
  private empty!: HTMLDivElement;
  private strip!: HTMLDivElement;
  private pathEl!: HTMLSpanElement;
  private badge!: HTMLSpanElement;
  private noteEl!: HTMLSpanElement;
  private discardBtn!: HTMLButtonElement;
  private saveBtn!: Button;

  /** The tree the strip is read out of. One fetch per invalidation, not one per document. */
  private tree: DocTree | undefined;

  /**
   * The document in the editor, which trails `ui.docPath` by one async read. The session, the
   * `seenHash` refusal, autosave and the quit guard all live in `docbuffer.ts`; this pane owns the
   * widgets and nothing about the text.
   */
  private readonly buf = new DocBuffer(() => this.paint(), BRIDGE_IO, {
    rich    : new MarkdownProvider(),
    autosave: AUTOSAVE_MS,
  });

  /** The path the editor was last bound for, so a swap on the same path keeps the view state. */
  private bound = '';

  /** What path.ux said about the front-matter block of the session on screen, or nothing. */
  private formNote = '';

  /** What `selectForm` last answered, which decides whether a diagnostic is news (D1). */
  private picked: 'note' | 'sheet' | 'conflict' | undefined;

  static override define() {
    return {
      tagname : 'vn-wiki-editor-x',
      areaname: 'wiki',
      icon    : -1,
    };
  }

  override init() {
    super.init();

    const bar = (this.header as Container).row();
    bar.label('DOCUMENT').style['padding'] = '0px 8px';
    this.saveBtn = bar.button('Save', () => void this.buf.save());
    this.saveBtn.description = 'Write this document back to disk, and commit it';
    // Its own pass: the button is built once with the pane, so a record in the bar's pass would be
    // dropped by the bar's next paint
    const reload = reloadOffer(RELOAD_TIP);
    redrawing('wiki', 'reload').act(
      bar.button(reload.label, () => {}),
      reload,
      () => void this.buf.reload(),
    );
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

    this.editor = UIBase.constructElement<RichTextEditor<ContextLike, MdDoc>>(
      'rich-text-x',
      this.ctx,
    );
    this.editor.parentWidget = this.container;
    this.editor.className = 'wk-rich';
    this.editor.widgetOptions = nativeFormWidgets({
      codec: {
        // Every resolve reads before it selects, so the answer recorded is the one for this block
        read: (source) => {
          this.picked = undefined;
          return frontmatterCodec.read(source);
        },
        patch: frontmatterCodec.patch,
      },
      select      : (values) => this.select(values),
      onDiagnostic: (_block, message) => this.diagnose(message),
    });
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys hands the shell's gestures away mid-edit; the editor's own chords (Ctrl+Z among them)
    // ran already, in its shadow root. Ctrl+S is caught here so it saves the document rather
    // than reaching the browser's own save.
    this.editor.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.buf.save();
      }
    });
    this.surface.appendChild(this.editor);

    // The strip sits below the text and is height-bounded, so it cannot crowd the page text off
    // the screen
    this.strip = el('div', 'wk-strip') as HTMLDivElement;
    this.surface.appendChild(this.strip);

    const foot = el('div', 'wk-foot');
    this.pathEl = el('span', 'wk-path') as HTMLSpanElement;
    this.badge = el('span', 'wk-badge', 'unsaved') as HTMLSpanElement;
    this.noteEl = el('span', 'wk-note') as HTMLSpanElement;
    this.discardBtn = el('button', 'wk-discard', 'Discard pending edits') as HTMLButtonElement;
    this.discardBtn.type = 'button';
    foot.append(this.pathEl, this.badge, this.noteEl, this.discardBtn);
    this.surface.appendChild(foot);

    this.appendSurface(this.surface);

    // A file this pane is showing can be written by something else: `gate.approve` rewrites
    // `character.md`, and so does the agent, whose writes are not commands at all.
    // `DocBuffer.wrote` decides what a clean buffer and a dirty buffer each do about it.
    this.watch(
      () => {
        const off = onWrote((paths) => this.buf.wrote(paths));
        // Off screen the buffer lets go of its session; a dirty one lives on for the quit guard
        return () => {
          off();
          this.buf.close();
        };
      },
      // The paths that moved while the pane was off screen are unknown, so the one it is showing
      // is opened again: a session with unsaved edits is found, a clean document re-read
      () => void this.buf.open(this.buf.path),
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
  // The form
  // -------------------------------------------------------------------------

  /**
   * The `select` of `nativeFormWidgets` for the document on screen. A fence that is not on the
   * file's first line is refused before the kind is asked, because `parseFrontMatter` would not
   * read it as front matter and a form over it would write a block the loader ignores.
   */
  private select(values: JsonValue): DocForm | undefined {
    const prefix = this.buf.session?.doc.blocks[0]?.retainedSource?.prefix ?? '';
    if (prefix.replace(BOM, '') !== '') {
      this.picked = 'conflict';
      throw new Error('Not front matter: the fence must open at the first line');
    }
    try {
      const form = selectForm(this.buf.implied, values);
      this.picked = form ? 'sheet' : 'note';
      return form;
    } catch (error) {
      this.picked = 'conflict';
      throw error;
    }
  }

  /** Shows a diagnostic in the footer, except the expected "no form" of a note. */
  private diagnose(message: string): void {
    if (this.picked === 'note') return;
    this.formNote = message;
    this.paintFoot();
  }

  /** Drop the answers a closed form left on the session, which its save was refused over. */
  private discard(): void {
    const session = this.buf.session;
    if (!session) return;
    for (const draft of session.pendingDrafts) if (draft.detached) session.discardDraft(draft.id);
    this.paint();
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

  /**
   * Point the editor at the buffer's session. A swap on the same path — the buffer following a
   * write that was not its own — keeps the caret and the scroll position, remapped by block
   * index, because the document underneath changed but the author's place in it did not.
   */
  private bind(): void {
    const next = this.buf.session;
    const shown = this.editor.session;
    if (shown === next) return;
    const same = shown !== undefined && next !== undefined && this.bound === this.buf.path;
    const state = same ? this.editor.viewState : undefined;
    // Cleared before the swap: path.ux reports on the new session's block while it renders
    this.formNote = '';
    this.picked = undefined;
    this.editor.session = next;
    this.bound = this.buf.path;
    if (state && shown && next) this.editor.viewState = remap(state, shown, next);
  }

  private paint(): void {
    const open = this.buf.path !== '';
    this.empty.style.display = open ? 'none' : 'flex';
    this.editor.style.display = open ? '' : 'none';
    this.bind();
    // Re-recorded on every paint rather than once with the bar: the bar is built at init and
    // the offer changes with the buffer, so a record kept from init would say `Nothing to save`
    // for the life of the pane.
    const anchors = redrawing('wiki', 'bar');
    anchors.act(this.saveBtn, this.buf.saveOffer, () => void this.buf.save());
    // The whole editor, toolbar and any form inside it, is one control: the box Save reads (D8)
    anchors.record(this.editor, textBox(this.buf.path, TEXT_TIP));
    this.paintFoot(anchors);
    this.paintStrip();
  }

  /**
   * The footer line: the path, the unsaved badge, and one note — a refusal or diagnostic from the
   * buffer first, else what path.ux said about the front-matter block, else the answers a closed
   * form left behind, beside the control that discards them.
   */
  private paintFoot(anchors = redrawing('wiki', 'foot')): void {
    const open = this.buf.path !== '';
    this.pathEl.textContent = open ? this.buf.path : '';
    this.pathEl.title = this.pathEl.textContent;
    this.badge.style.display = this.buf.dirty ? 'inline-block' : 'none';

    const detached = this.buf.session?.pendingDrafts.filter((d) => d.detached).length ?? 0;
    const note = this.buf.note || this.formNote || (detached > 0 ? DETACHED : '');
    const bad = this.buf.note ? this.buf.bad : this.formNote !== '' || detached > 0;
    this.noteEl.textContent = note;
    this.noteEl.className = bad ? 'wk-note bad' : 'wk-note';
    this.noteEl.title = note;

    this.discardBtn.hidden = detached === 0;
    if (detached > 0) anchors.act(this.discardBtn, discardOffer(detached), () => this.discard());
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
    const screen = this.ctx?.screen as VnScreen | undefined;
    const visible = visibleEditors(screen ? panesOf(screen) : []);
    const anchors = redrawing('wiki', 'strip');
    renderAssetStrip(this.strip, links ? assetGroups(links) : [], EMPTY, {
      onPick: (hash) => this.openAsset(hash),
      anchor: (box, asset, run) => anchors.act(box, cellAction(asset, visible), run),
    });
  }
}

/** The only prefix allowed before the fence, matching what `parseFrontMatter` skips. */
const BOM = '﻿';

/** Said while a closed form's answers sit on the session, where they refuse every save. */
const DETACHED = 'A form that has closed left answers unapplied; discard them to save';

/**
 * Shown for most of the bible, because every binding in the manifest names a character, a
 * location, a scene or a shot, so no asset binds to a plain lore note. Saying so is clearer than
 * a strip that is sometimes missing with no stated reason.
 */
const EMPTY = 'Nothing has been drawn from this page.';

/**
 * The view state of one session carried over to a re-parse of the same document: block ids are
 * fresh per parse, so the selection is mapped by block index and clamped to the new block's text.
 * A block the new document no longer has drops the selection and keeps the scroll.
 */
function remap(
  state: { selection?: DocRange; scrollTop: number },
  from: DocumentSession<MdDoc>,
  to: DocumentSession<MdDoc>,
): { selection?: DocRange; scrollTop: number } {
  if (!state.selection) return { scrollTop: state.scrollTop };
  const at = (pos: DocRange['anchor']): DocRange['anchor'] | undefined => {
    const index = from.doc.blocks.findIndex((b) => b.id === pos.block);
    const block = index === -1 ? undefined : to.doc.blocks[index];
    if (!block) return undefined;
    const length = to.provider.blockText(to.doc, block.id).length;
    return { block: block.id, offset: Math.min(pos.offset, length) };
  };
  const anchor = at(state.selection.anchor);
  const head = at(state.selection.head);
  return anchor && head
    ? { scrollTop: state.scrollTop, selection: { anchor, head } }
    : { scrollTop: state.scrollTop };
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(WikiEditor, 'vn.WikiEditor');
