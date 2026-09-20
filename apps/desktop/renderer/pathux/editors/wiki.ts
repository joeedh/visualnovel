import { UIBase, type Button, type Container, type ContextLike, type RichTextEditor } from 'pathux';
import { nativeFormWidgets } from 'pathux-richtext-forms';
import {
  markdownSourceCommand,
  markdownText,
  type DocRange,
  type DocumentSession,
  type DraftController,
  type DraftPreparation,
  type JsonValue,
  type LinkClick,
  type MdDoc,
} from 'pathux-richtext-headless';
import type { WikilinkStart } from 'pathux-richtext-markdown';
import { frontmatterCodec } from '@vn/parse';
import { api } from '../../api.js';
import { ASSETSTRIP_CSS, renderAssetStrip } from '../assets/assetstrip.js';
import { cellAction } from '../../rules/assetstrip.js';
import {
  RAW_TIP,
  RELOAD_TIP,
  TEXT_TIP,
  discardOffer,
  pictureOffer,
  rawOffer,
} from '../../rules/wiki.js';
import { reloadOffer, textBox } from '../../rules/docbuffer.js';
import { visibleEditors } from '../panes/route.js';
import { panesOf } from '../panes/view.js';
import { onInvalidate, onWrote } from '../app/bridge.js';
import { AUTOSAVE_MS, BRIDGE_IO, DocBuffer } from '../doctree/docbuffer.js';
import { parseOptionsFor, refusalOf } from '../doctree/docsession.js';
import type { DocForm } from '../doctree/docforms.js';
import { SheetForms, sheetControls } from '../doctree/sheetform.js';
import { redrawing } from '../tour/anchors.js';
import { assetGroups } from '../doctree/doctree.js';
import { linkedNode } from '../doctree/doclinks.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import { assetNode, openNode } from '../panes/open.js';
import { PICTURE_BUTTON, WikiProvider } from './wikiprovider.js';
import { LinkCompletion } from './wikilinks.js';
import type { VnScreen } from '../app/screen.js';
import WIKI_CSS from '../../styles/wiki.css?inline';
import type { DocTree, EntityLinks } from '../../../src/shared/ipc.js';
import type { EditorId } from '../../../src/shared/editors.js';

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
 * The bar's Raw switch shows the same session as Markdown source in a textarea, registered on the
 * session as a draft the way a form is: what is typed there is applied as one undoable edit when
 * the view switches back or the document saves. The switch is per pane and forgotten when the
 * pane closes.
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
 *
 * Links between documents are ordinary markdown links to document-relative paths. Typing `[[`
 * opens a completion over the tree's documents (`wikilinks.ts`), and Ctrl+click (Cmd on macOS),
 * or a plain click while the document cannot be written, follows a link that names a document or
 * a stored picture through the same route a tree click takes; a plain click keeps path.ux's own
 * popup, which edits the link. A `[[marker]]` the screenplay uses, or a url, leads nowhere here.
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
  private rawBtn!: Button;
  private rawBox!: HTMLTextAreaElement;

  /** The tree the strip is read out of. One fetch per invalidation, not one per document. */
  private tree: DocTree | undefined;

  /** Whether the source textarea stands in for the rich editor. In memory only, off on open. */
  private raw = false;

  /** The document the raw view was switched on for; showing another one switches it off. */
  private rawPath = '';

  /** The path `show` is on its way to, so a frame's `update` does not start a second trip. */
  private showing: string | undefined;

  override unsavedDoc(): string | undefined {
    return this.buf.dirty ? this.buf.path : undefined;
  }

  /** The draft the textarea is typed into, on the buffer's session, and what unregisters it. */
  private rawDraft: RawDraft | undefined;
  private rawOff: (() => void) | undefined;

  /**
   * The document in the editor, which trails `ui.docPath` by one async read. The session, the
   * `seenHash` refusal, autosave and the quit guard all live in `docbuffer.ts`; this pane owns the
   * widgets and nothing about the text.
   */
  private readonly buf = new DocBuffer(() => this.paint(), BRIDGE_IO, {
    // One provider serves every pane on the session, so the `[[` finds its pane from the key
    rich: (path) =>
      new WikiProvider(path, {
        onWikilinkStart: (start) => paneOf(start)?.completion.show(start),
      }),
    autosave: AUTOSAVE_MS,
  });

  /** The popup a typed `[[` opens, over the documents in the tree. Built with the pane, read late. */
  private readonly completion = new LinkCompletion({
    editor : () => this.editor,
    screen : () => this.ctx?.screen as VnScreen | undefined,
    path   : () => this.buf.path,
    roots  : () => this.tree?.roots ?? [],
    visible: () => this.visible(),
    anchors: () => redrawing('wiki', 'complete'),
  });

  /** This pane's forms: the schemas with its own controls, and the form path.ux has mounted. */
  private readonly forms = new SheetForms(
    sheetControls({
      path     : () => this.buf.path,
      ctx      : () => this.ctx,
      anchors  : (part) => redrawing('wiki', `form/${part}`),
      links    : () => this.links(),
      onLinks: (listener) => {
        this.linkListeners.add(listener);
        return () => this.linkListeners.delete(listener);
      },
      visible  : () => this.visible(),
      openAsset: (hash) => this.openAsset(hash),
      dirty    : () => this.buf.dirty,
      onPaint: (listener) => {
        this.paintListeners.add(listener);
        return () => this.paintListeners.delete(listener);
      },
    }),
  );

  /** The form controls drawing art from the tree, told when it is fetched again. */
  private readonly linkListeners = new Set<() => void>();

  /** The form controls reading the buffer's state, told on each of its paints. */
  private readonly paintListeners = new Set<() => void>();

  /** The path the editor was last bound for, so a swap on the same path keeps the view state. */
  private bound = '';

  /** What path.ux said about the front-matter block on screen, or why a switch of view was refused. */
  private viewNote = '';

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
    // Acted per paint like Save: its label and tooltip name the view a press shows
    this.rawBtn = bar.button('Raw', () => {});
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
      view        : (parts) => this.forms.view(parts),
      onDiagnostic: (_block, message) => this.diagnose(message),
    });
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys hands the shell's gestures away mid-edit; the editor's own chords (Ctrl+Z among them)
    // ran already, in its shadow root. Ctrl+S is caught here so it saves the document rather
    // than reaching the browser's own save.
    const keys = (event: KeyboardEvent) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.buf.save();
      }
    };
    this.editor.addEventListener('keydown', keys);
    this.editor.addEventListener('linkclick', (e) => this.follow(e as CustomEvent<LinkClick>));
    this.surface.appendChild(this.editor);

    // The raw view: the same session as source, shown in the editor's place
    this.rawBox = el('textarea', 'wk-raw') as HTMLTextAreaElement;
    this.rawBox.spellcheck = false;
    this.rawBox.wrap = 'soft';
    this.rawBox.addEventListener('keydown', keys);
    this.rawBox.addEventListener('input', () => {
      this.rawDraft?.typed(this.rawBox.value);
      this.paintFoot();
    });
    this.surface.appendChild(this.rawBox);

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

    if (this.ui.docPath !== this.buf.path && this.showing !== this.ui.docPath) {
      void this.show(this.ui.docPath);
    }
  }

  /**
   * Show another document. Source typed into the raw view is applied to the one leaving first,
   * so it is saved with the document rather than left detached; a refusal leaves it detached, as
   * a closed form's answers are.
   */
  private async show(path: string): Promise<void> {
    this.showing = path;
    try {
      const session = this.buf.session;
      if (this.raw && this.rawDraft?.pending() && session) await session.prepareSave();
      if (this.ui.docPath === path) await this.buf.open(path);
    } finally {
      this.showing = undefined;
    }
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
      const form = this.forms.select(this.buf.implied, values);
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
    this.viewNote = message;
    this.paintFoot();
  }

  /**
   * Drop what refuses the save: the answers a closed form left on the session, and source typed
   * into the raw view after the document moved under it.
   */
  private discard(): void {
    const session = this.buf.session;
    if (!session) return;
    for (const draft of session.pendingDrafts) if (draft.detached) session.discardDraft(draft.id);
    if (this.rawStale) this.rawDraft?.discard();
    this.paint();
  }

  // -------------------------------------------------------------------------
  // The raw view
  // -------------------------------------------------------------------------

  /**
   * Switch views. Either way the session's pending drafts are applied first — a form's answers
   * before the rich editor unmounts, the typed source before the rich view shows it — and a
   * refusal leaves the view as it is and says why.
   */
  private async toggleRaw(): Promise<void> {
    const session = this.buf.session;
    if (!session) return;
    const prepared = await session.prepareSave();
    if (this.buf.session !== session) return;
    if (prepared.status !== 'ready') {
      this.viewNote = refusalOf(prepared);
      this.paintFoot();
      return;
    }
    this.raw = !this.raw;
    this.rawPath = this.buf.path;
    this.viewNote = '';
    this.paint();
  }

  /** Whether the textarea holds typed source that the document has since moved out from under. */
  private get rawStale(): boolean {
    return this.rawDraft?.stale ?? false;
  }

  /** Register the textarea on a session as a draft, filled from that session's document. */
  private mountRaw(session: DocumentSession<MdDoc>): void {
    this.unmountRaw();
    this.rawBox.readOnly = !session.canWrite;
    this.rawDraft = new RawDraft(session, this.buf.path, (text) => this.filledRaw(text));
    this.rawOff = session.registerDraft(this.rawDraft, this.ctx);
  }

  /**
   * Take the textarea off its session. Source still typed into it stays on that session as a
   * detached draft, as a closed form's answers do, and is reported when the document is shown
   * again.
   */
  private unmountRaw(): void {
    this.rawOff?.();
    this.rawOff = undefined;
    this.rawDraft = undefined;
  }

  /**
   * The draft filled the textarea from the document. The value is only assigned when it differs,
   * because an assignment moves the caret to the end, and a commit of the typed source hands back
   * the same text. A refusal said about the source it replaces is over.
   */
  private filledRaw(text: string): void {
    this.viewNote = '';
    if (this.rawBox.value !== text) this.rawBox.value = text;
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
    for (const listener of this.linkListeners) listener();
  }

  /** What the open document is the subject of, out of the tree the strip reads. */
  private links(): EntityLinks | undefined {
    const key = this.tree?.pathIndex[this.buf.path];
    return key === undefined ? undefined : this.tree?.backlinks[key];
  }

  private visible(): readonly EditorId[] {
    const screen = this.ctx?.screen as VnScreen | undefined;
    return visibleEditors(screen ? panesOf(screen) : []);
  }

  /**
   * A click on a link in the text. Followed under a modifier, or on a plain click when the
   * document cannot be written, when the link names a document or a stored picture; anything
   * else is left to path.ux, whose edit-mode default is the popup that edits the link.
   */
  private follow(e: CustomEvent<LinkClick>): void {
    const link = e.detail;
    const readOnly = this.buf.session?.canWrite === false || this.editor.readOnly;
    const modified = link.event.ctrlKey || link.event.metaKey;
    if (link.kind !== 'url' || !(modified || readOnly)) return;
    const node = linkedNode(this.buf.path, link.target, this.tree?.roots ?? []);
    if (!node) return;
    e.preventDefault();
    openNode(this.ctx?.screen as VnScreen | undefined, node);
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
    // Under the raw view the editor is unbound: the two views never share a pane, so a form
    // cannot hold answers while the source is typed into
    const next = this.raw ? undefined : this.buf.session;
    const shown = this.editor.session;
    if (shown === next) return;
    const same = shown !== undefined && next !== undefined && this.bound === this.buf.path;
    const state = same ? this.editor.viewState : undefined;
    // Cleared before the swap: path.ux reports on the new session's block while it renders
    this.viewNote = '';
    this.picked = undefined;
    this.completion.close();
    this.editor.session = next;
    this.bound = this.buf.path;
    if (state && shown && next) this.editor.viewState = remap(state, shown, next);
  }

  /**
   * Keep the textarea on the buffer's session: registered on a new one, refilled when the
   * document changed and nothing was typed, off the session when the rich view is back.
   */
  private bindRaw(): void {
    const session = this.buf.session;
    if (!this.raw || !session) {
      if (this.rawDraft) this.unmountRaw();
      return;
    }
    if (this.rawDraft?.session !== session) this.mountRaw(session);
    else this.rawDraft.refresh();
  }

  private paint(): void {
    const open = this.buf.path !== '';
    if (this.raw && this.rawPath !== this.buf.path) this.raw = false;
    this.empty.style.display = open ? 'none' : 'flex';
    this.editor.style.display = open && !this.raw ? '' : 'none';
    this.rawBox.style.display = open && this.raw ? '' : 'none';
    this.bind();
    this.bindRaw();
    // Re-recorded on every paint rather than once with the bar: the bar is built at init and
    // the offer changes with the buffer, so a record kept from init would say `Nothing to save`
    // for the life of the pane.
    const anchors = redrawing('wiki', 'bar');
    anchors.act(this.saveBtn, this.buf.saveOffer, () => void this.buf.save());
    const raw = rawOffer(this.raw, this.buf.path);
    this.rawBtn.name = raw.label;
    anchors.act(this.rawBtn, raw, () => void this.toggleRaw());
    // The whole editor, toolbar and any form inside it, is one control: the box Save reads (D8)
    if (this.raw) anchors.record(this.rawBox, textBox(this.buf.path, RAW_TIP));
    else anchors.record(this.editor, textBox(this.buf.path, TEXT_TIP));
    // Recorded rather than acted: the provider wires the press, and the toolbar row it sits in
    // was built by `bind` above, so the node is this paint's
    const toolbar = this.editor.shadow.querySelector<UIBase>('[data-richtext-toolbar]');
    const picture = toolbar?.shadow.querySelector<HTMLElement>(`[data-testid="${PICTURE_BUTTON}"]`);
    if (picture) {
      const readOnly = this.buf.session?.canWrite === false;
      anchors.record(picture, pictureOffer(this.buf.path, readOnly));
    }
    this.paintFoot(anchors);
    this.paintStrip();
    for (const listener of this.paintListeners) listener();
  }

  /**
   * The footer line: the path, the unsaved badge, and one note — a refusal or diagnostic from the
   * buffer first, else what path.ux said about the front-matter block, else what refuses the save
   * (the answers a closed form left behind, or typed source the document moved under), beside the
   * control that discards it.
   */
  private paintFoot(anchors = redrawing('wiki', 'foot')): void {
    const open = this.buf.path !== '';
    this.pathEl.textContent = open ? this.buf.path : '';
    this.pathEl.title = this.pathEl.textContent;

    // A closed form's answers go back into the form that replaced it when the values still
    // match; what cannot go back is reported below, with the control that drops it
    const session = this.buf.session;
    if (session && !this.raw) this.forms.recover(session);
    this.badge.style.display = this.buf.dirty ? 'inline-block' : 'none';

    const detached = session?.pendingDrafts.filter((d) => d.detached).length ?? 0;
    const stale = this.rawStale;
    const blocked = detached > 0 ? DETACHED : stale ? RAW_STALE : '';
    const note = this.buf.note || this.viewNote || blocked;
    const bad = this.buf.note ? this.buf.bad : this.viewNote !== '' || blocked !== '';
    this.noteEl.textContent = note;
    this.noteEl.className = bad ? 'wk-note bad' : 'wk-note';
    this.noteEl.title = note;

    this.discardBtn.hidden = blocked === '';
    if (blocked !== '') {
      anchors.act(this.discardBtn, discardOffer(detached, stale), () => this.discard());
    }
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
    const links = this.links();
    const visible = this.visible();
    const anchors = redrawing('wiki', 'strip');
    renderAssetStrip(this.strip, links ? assetGroups(links) : [], EMPTY, {
      onPick: (hash) => this.openAsset(hash),
      anchor: (box, asset, run) => anchors.act(box, cellAction(asset, visible), run),
    });
  }
}

/**
 * The pane a `[[` was typed in. The provider that hears the key is the session's, not any pane's,
 * and the key's path crosses the editor's shadow root up to the pane's host, so the event is what
 * names the pane.
 */
function paneOf(start: WikilinkStart): WikiEditor | undefined {
  return start.event.composedPath().find((n): n is WikiEditor => n instanceof WikiEditor);
}

/** The only prefix allowed before the fence, matching what `parseFrontMatter` skips. */
const BOM = '﻿';

/** Said while a closed form's answers sit on the session, where they refuse every save. */
const DETACHED = 'A form that has closed left answers unapplied; discard them to save';

/** Said while the raw view holds typed source that another edit to the document has overtaken. */
const RAW_STALE = 'The document changed under the source typed here; discard it to save';

/**
 * The raw view's draft on a session: the source typed into the textarea, applied as one edit
 * under the precondition that the document still reads as it did when the textarea was filled.
 * It keeps the typed text itself, so once the textarea moves on to another document the draft
 * stays pending on this session, detached, the way a closed form's answers do.
 */
class RawDraft implements DraftController {
  readonly key = 'raw-source';
  /** What the textarea holds, kept here so the draft outlives the textarea's reuse. */
  private text = '';
  /** Whether anything was typed since the last fill. */
  private dirty = false;
  /** The source the textarea was filled from, which `prepare` expects the document to still hold. */
  private base = '';
  /** The session revision at the fill; a later one means the document moved under the text. */
  private revision = 0;
  /** Bumped by every keystroke and every fill, so a save prepared over older text is refused. */
  private edits = 0;

  constructor(
    readonly session: DocumentSession<MdDoc>,
    /** The document's path, which decides how its paragraphs are read back. */
    private readonly path: string,
    /** Called with the text each fill puts in the textarea. */
    private readonly filled: (text: string) => void,
  ) {
    this.reset();
  }

  /** Whether typed source is now behind an edit to the document, which `prepare` will refuse. */
  get stale(): boolean {
    return this.dirty && this.session.revision !== this.revision;
  }

  typed(text: string): void {
    this.text = text;
    this.dirty = true;
    this.edits++;
  }

  /** Refill from the document if it moved and nothing was typed; typed text is kept as it is. */
  refresh(): void {
    if (!this.dirty && this.session.revision !== this.revision) this.reset();
  }

  pending(): boolean {
    return this.dirty;
  }

  version(): number {
    return this.edits;
  }

  prepare(): DraftPreparation {
    if (this.session.revision !== this.revision) return { status: 'conflict', reason: RAW_STALE };
    return {
      status : 'ready',
      command: markdownSourceCommand(
        this.session.doc,
        this.base,
        this.text,
        parseOptionsFor(this.path),
      ),
    };
  }

  committed(): void {
    this.reset();
  }

  discard(): void {
    this.reset();
  }

  recover(): string {
    return this.text;
  }

  private reset(): void {
    this.dirty = false;
    this.text = this.base = markdownText(this.session.doc);
    this.revision = this.session.revision;
    this.edits++;
    this.filled(this.text);
  }
}

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
