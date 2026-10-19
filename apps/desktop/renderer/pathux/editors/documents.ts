import { KeyMap, type Container } from 'pathux';
import { api } from '../../api.js';
import { ASSETSTRIP_CSS, renderAssetStrip } from '../assets/assetstrip.js';
import { exec, onInvalidate, report, say } from '../app/bridge.js';
import { onMoved, onReveal } from '../app/docseffect.js';
import type { VnContext } from '../app/context.js';
import {
  assetGroups,
  backlinkSubject,
  defaultExpanded,
  deleteFor,
  filterTree,
  findNode,
  flattenTree,
  markable,
  menuFor,
  NO_MENU_CONTEXT,
  nodeIsSelected,
  pasteEntry,
  pasteInto,
  renameEntry,
  renameOf,
  renamePathOf,
  revealIds,
  rowTitle,
  selectionForNode,
  toggleExpanded,
  type DocRow,
  type MenuContext,
} from '../doctree/doctree.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import { VN_ICONS } from '../app/icons.js';
import {
  collapseAction,
  createAction,
  fileRenameAction,
  modeAction,
  reloadAction,
  renameAction,
  rowAction,
  sceneLinkAction,
  sheetLinkAction,
  shotLinkAction,
  storyInOrder,
  type FileRename,
  type SceneOrder,
} from '../../rules/documents.js';
import type { Offer } from '../../rules/anchors.js';
import { unsavedRefusal } from '../../rules/docbuffer.js';
import { cellAction } from '../../rules/assetstrip.js';
import { redrawing, watchKeymap } from '../tour/anchors.js';
import { hotkeys } from '../app/keymap.js';
import { assetNode, openNode } from '../panes/open.js';
import { visibleEditors } from '../panes/route.js';
import { panesOf } from '../panes/view.js';
import { layoutChanged } from '../app/persist.js';
import type { VnScreen } from '../app/screen.js';
import { menuIsOpen, showContextMenu } from '../chrome/showmenu.js';
import { openCommandDialog } from '../chrome/dialog.js';
import type { Selection } from '../../rules/selection.js';
import {
  TREEVIEW_CSS,
  armDismissLatch,
  renderTree,
  rowElementFor,
  type ClickMods,
} from '../doctree/treeview.js';
import {
  NO_MARKS,
  markClick,
  menuTargets,
  movedId,
  pruneMarks,
  remapMarks,
  revealMarks,
  type MarkState,
} from '../doctree/marks.js';
import { clipboard, isCut, onClip, pasted, setClip, type ClipMode } from '../doctree/clipboard.js';
import { draftPaths } from '../doctree/docbuffer.js';
import DOCUMENTS_CSS from '../../styles/documents.css?inline';
import type { DocNode, DocTree, PropValue } from '../../../src/shared/ipc.js';
import type { FileMove } from '../../../src/shared/fileops.js';

/** Which tree the pane is drawing. Remembered per pane, so two of them can differ. */
type DocMode = 'documents' | 'files';

/**
 * The sidebar, as a pane: the project's five branches — Story → scenes → shots, Characters,
 * Locations, Wiki, Assets by kind — over the tree `workspace:doctree` already builds, or every
 * file on disk when it is switched to file mode. It is an editor rather than fixed chrome, so it
 * can be torn out, put on either side, or opened twice — once per mode.
 *
 * It holds no app-wide selection of its own. A click publishes `ui.sceneId` / `ui.shotId` /
 * `ui.characterId` / `ui.docPath`, which every other editor already observes, so the tree steers
 * the app without knowing what is open, and a scene picked in the branch graph highlights here.
 * What it does hold is its marked rows (`marks.ts`): the pages, files and folders gathered by
 * Ctrl-click and Shift-click for Cut and Copy, which fill the window's clipboard (`clipboard.ts`).
 *
 * The panel under the tree lists what points at the selected entity: its sheet, its art, and the
 * scenes and shots it appears in, from `DocTree.backlinks`. It is here rather than in the
 * Inspector because the Inspector's subject is `ui.taskHash`, a different axis, and "which scenes
 * is this character in" should not cost a second pane.
 */
export class DocumentsEditor extends VnEditor {
  private bar!: Container;
  private surface!: HTMLDivElement;
  private rows!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private newRow!: HTMLDivElement;
  private newKind!: HTMLSelectElement;
  private newName!: HTMLInputElement;
  private search!: HTMLInputElement;

  /**
   * The one field this pane remembers, declared to nstructjs at the bottom of this file. Public
   * and a plain string on purpose: a restored layout writes it straight back.
   */
  mode: DocMode = 'documents';
  /** How the Story branch sorts its scenes. Remembered the same way `mode` is. */
  order: SceneOrder = 'stored';

  private tree: DocTree | undefined;
  private files: DocNode[] | undefined;
  private failure = '';
  private expanded: ReadonlySet<string> = new Set();
  /** Rising with every fetch, so a slow read for a workspace that has moved on is dropped. */
  private token = 0;
  private pending = false;
  private drawn = '';
  /** The last location clicked here. Nothing else records that a location is selected. */
  private picked = '';
  /** The row last clicked or right-clicked, of any kind, which the Delete key acts on. */
  private clicked = '';
  /** The node being renamed right now, so a rebuild underneath the box cannot start a second one. */
  private renaming = '';
  /**
   * What the search box holds. Not remembered across sessions: a filter is a question about right
   * now, and a project reopening on three visible rows would read as a project that lost its files.
   */
  private query = '';
  /**
   * The marked rows and the anchor a Shift-click extends from. Not remembered across sessions: the
   * paths may be gone by then, and marks the author cannot see must not be acted on.
   */
  private marking: MarkState = NO_MARKS;
  /** The rows last drawn, in draw order, which a Shift-click's range is taken from. */
  private shown: readonly DocRow[] = [];
  /** Paths a `reveal` push named, marked once the refetch it started draws them. */
  private revealed: readonly string[] | undefined;

  static override define() {
    return {
      tagname : 'vn-documents-editor-x',
      areaname: 'documents',
      icon    : -1,
    };
  }

  override init() {
    super.init();

    this.bar = (this.header as Container).row();

    this.adoptStyle(DOCUMENTS_CSS);
    this.adoptStyle(TREEVIEW_CSS);
    this.adoptStyle(ASSETSTRIP_CSS);
    this.surface = el('div', 'dt-surface') as HTMLDivElement;
    this.rows = el('div', 'tv-rows') as HTMLDivElement;
    this.panel = el('div', 'dt-panel') as HTMLDivElement;
    this.surface.append(this.buildSearchRow(), this.buildNewRow(), this.rows, this.panel);
    // Latching on the surface rather than on the rows also covers the backlink panel below them.
    armDismissLatch(this.surface, menuIsOpen);
    this.appendSurface(this.surface);

    // Coarse on purpose (decision 7 of the plan): there is no write effect to listen for, a tree
    // is one cached `loadProject` away, and a stale tree is worse than a redundant fetch. A tab
    // switch tears the watch down, so it is re-armed and refetched on the way back on screen.
    this.watch(
      () => onInvalidate(() => void this.load()),
      () => void this.load(),
    );
    this.watch(() => onReveal((paths) => this.reveal(paths)));
    this.watch(() => onMoved((moves) => this.followMove(moves)));
    // Every pane in the window dims the rows a Cut took, not only the pane it was made in
    this.watch(() => onClip(() => this.rebuild()));

    // The search box and the inline boxes stop their own keys, so these reach only the tree
    this.keymap = new KeyMap(
      hotkeys('documents', {
        'Clear marks': () => this.clearMarks(),
        Copy         : () => this.clipMarks('copy'),
        Cut          : () => this.clipMarks('cut'),
        Delete       : () => this.deleteAtKey(),
        Paste        : () => this.pasteAtAnchor(),
        Rename       : () => this.renameAtAnchor(),
      }),
    );
    watchKeymap('documents', () => this.keymap);

    void this.load();
  }

  override update() {
    super.update();

    // A restored layout writes `mode` straight into the instance, and whether that lands before
    // or after `init` is path.ux's business — so the fetch is asked for here rather than assumed.
    if (!this.roots() && !this.pending && !this.failure) void this.load();
    if (this.stateKey() !== this.drawn) this.rebuild();
  }

  /** The tree currently being drawn, or undefined until the fetch for its mode returns. */
  private roots(): readonly DocNode[] | undefined {
    if (this.mode === 'files') return this.files;
    return this.tree && storyInOrder(this.tree.roots, this.order, this.tree.storyOrder);
  }

  private async load(): Promise<void> {
    const mine = ++this.token;
    const mode = this.mode;
    const first = mode === 'files' ? !this.files : !this.tree;
    this.pending = true;
    try {
      let roots: DocNode[];
      if (mode === 'files') {
        roots = await api.invoke('workspace:filetree');
        if (mine !== this.token) return;
        this.files = roots;
      } else {
        const tree = await api.invoke('workspace:doctree');
        if (mine !== this.token) return;
        this.tree = tree;
        roots = tree.roots;
      }
      // The expanded set belongs to the author and survives every refetch after the first; a tree
      // that collapsed whenever something wrote a file would be unusable while working. One set
      // serves both modes: their node ids share no prefix, so neither can close the other.
      if (first) this.expanded = new Set([...this.expanded, ...defaultExpanded(roots)]);
      this.failure = '';
      if (this.revealed) {
        this.marking = revealMarks(this.flatRows(this.roots() ?? []), this.revealed);
        this.revealed = undefined;
      }
    } catch (err) {
      if (mine !== this.token) return;
      this.failure = err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === this.token) this.pending = false;
    }
    this.rebuild();
  }

  /**
   * Switch trees. The mode is a remembered field, so the change is reported to persistence —
   * nothing about the screen's shape moved, and `onLayoutChange` would never fire for it.
   */
  private setMode(mode: DocMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.failure = '';
    // The two modes' node ids share no prefix, so no mark could survive the switch
    this.marking = NO_MARKS;
    layoutChanged();
    this.rebuild();
    if (!this.roots()) void this.load();
  }

  /** Switch how the Story branch is sorted. Remembered, so it is reported like `mode`. */
  private setOrder(order: SceneOrder): void {
    if (order === this.order) return;
    this.order = order;
    layoutChanged();
    this.rebuild();
  }

  private selection(): Selection {
    const ui = this.ui;
    return {
      sceneId    : ui.sceneId,
      shotId     : ui.shotId,
      characterId: ui.characterId,
      docPath    : ui.docPath,
      assetHash  : ui.assetHash,
      graphSlug  : ui.graphSlug,
    };
  }

  private stateKey(): string {
    const ui = this.ui;
    return [
      this.mode,
      this.order,
      this.failure,
      this.token,
      this.picked,
      this.query,
      this.marking.marks.join(','),
      this.marking.anchor,
      this.expanded.size,
      [...this.expanded].join(','),
      ui.sceneId,
      ui.shotId,
      ui.characterId,
      ui.docPath,
      ui.assetHash,
    ].join('|');
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private rebuild(): void {
    const roots = this.failure ? undefined : this.roots();
    const rows = roots && this.flatRows(roots);
    // Pruned before the state key is taken, so dropping a hidden mark does not cost a second draw.
    // Not while a fetch is out: marks a move carried to new ids wait for the tree that has them
    if (rows && !this.pending) this.marking = pruneMarks(this.marking, rows);
    this.drawn = this.stateKey();
    this.rebuildBar();
    this.rebuildRows(rows);
    this.rebuildPanel();
  }

  /**
   * The rows on screen, in draw order. The filter's own open branches are added to the author's
   * rather than replacing them, so a matched node they had already expanded still shows what is
   * under it.
   */
  private flatRows(roots: readonly DocNode[]): DocRow[] {
    const filtered = filterTree(roots, this.query);
    return flattenTree(filtered.roots, new Set([...this.expanded, ...filtered.expanded]));
  }

  private rebuildBar(): void {
    const files = this.mode === 'files';
    this.bar.clear();
    const anchors = redrawing('documents', 'bar');
    const mode = modeAction(this.mode);
    anchors.act(
      this.bar.button(mode.label, () => {}),
      mode,
      () => this.setMode(files ? 'documents' : 'files'),
    );
    // The button rather than the row it opens: pressing it is where writing a document starts, and
    // the kind and the name are both typed after it.
    const create = createAction();
    anchors.act(
      this.bar.button(create.label, () => {}),
      create,
      () => this.showNewRow(),
    );
    const reload = reloadAction();
    anchors.act(
      this.bar.button(reload.label, () => {}),
      reload,
      () => void this.load(),
    );
    const shut = collapseAction();
    anchors.act(
      VN_ICONS.collapse >= 0
        ? this.bar.iconbutton(VN_ICONS.collapse, '', () => {})
        : this.bar.button(shut.label, () => {}),
      shut,
      () => this.collapseAll(),
    );
    this.bar.flushUpdate();
  }

  /**
   * The search box. It sits outside the rows it filters, so it keeps the caret through the rebuild
   * every keystroke causes. Filtering is local to the tree already fetched: everything the pane
   * draws is in hand, and a round trip per keystroke would answer later than the author types.
   */
  private buildSearchRow(): HTMLElement {
    const row = el('div', 'dt-search') as HTMLDivElement;
    this.search = document.createElement('input');
    this.search.className = 'dt-search-box';
    this.search.placeholder = 'filter';
    this.search.title =
      'Show only the rows whose names contain what you type — Escape clears it again';
    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.rebuild();
    });
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys hands Ctrl+Z and the shell's other gestures away mid-edit.
    this.search.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key !== 'Escape' || this.query === '') return;
      this.query = this.search.value = '';
      this.rebuild();
    });
    row.appendChild(this.search);
    return row;
  }

  /**
   * Scaffold a sheet or a note from a name and open what it wrote — the one authored act the tree
   * itself performs. It is a row rather than a dialog because path.ux has no prompt and this
   * pane's surface is already raw DOM in its shadow root.
   */
  private buildNewRow(): HTMLElement {
    this.newRow = el('div', 'dt-new') as HTMLDivElement;
    this.newRow.style.display = 'none';

    this.newKind = document.createElement('select');
    this.newKind.className = 'dt-new-kind';
    this.newKind.title =
      'Which kind of document to scaffold — it decides the folder and the fields';
    for (const kind of ['character', 'location', 'note', 'skill'] as const) {
      const option = document.createElement('option');
      option.value = kind;
      option.textContent = kind;
      this.newKind.appendChild(option);
    }

    this.newName = document.createElement('input');
    this.newName.className = 'dt-new-name';
    this.newName.placeholder = 'name';
    this.newName.title = 'Name the document — Enter writes it and opens it, Escape gives up';
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys hands Ctrl+Z and the shell's other gestures away mid-edit.
    this.newName.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') void this.create();
      if (event.key === 'Escape') this.hideNewRow();
    });

    this.newRow.append(this.newKind, this.newName);
    return this.newRow;
  }

  private showNewRow(): void {
    this.newRow.style.display = 'flex';
    this.newName.value = '';
    this.newName.focus();
  }

  private hideNewRow(): void {
    this.newRow.style.display = 'none';
  }

  private async create(): Promise<void> {
    const name = this.newName.value.trim();
    if (name === '') return;

    const outcome = await exec('doc.create', { kind: this.newKind.value, name });
    // A refusal (a document already at that path) is already reported in the note frame, so the
    // row stays open with the name still in it rather than making the author retype it.
    if (!outcome.ok) return;

    this.hideNewRow();
    this.openDoc((outcome.data as { path: string }).path);
  }

  /**
   * Write the sheet for a location mined from a scene heading, then open it. `doc.create` derives
   * the id from the name and heading mining derives it the same way (both are `slug(name)`), so
   * this writes that location's sheet rather than creating a second location beside it.
   */
  private async writeSheet(name: string): Promise<void> {
    const outcome = await exec('doc.create', { kind: 'location', name });
    if (!outcome.ok) return;
    this.openDoc((outcome.data as { path: string }).path);
  }

  private rebuildRows(rows: readonly DocRow[] | undefined): void {
    // A rename box is thrown away with the row it sat in, so clearing this here keeps a refetch
    // from blocking every later rename.
    this.renaming = '';
    this.rows.textContent = '';
    this.shown = rows ?? [];

    if (this.failure) {
      this.rows.appendChild(el('div', 'dt-note', this.failure));
      return;
    }
    if (!rows) {
      this.rows.appendChild(el('div', 'dt-note', 'Reading the workspace…'));
      return;
    }

    if (rows.length === 0) {
      const note = this.query.trim()
        ? `Nothing here is called “${this.query.trim()}”.`
        : 'Nothing in this workspace yet.';
      this.rows.appendChild(el('div', 'dt-note', note));
      return;
    }

    const selection = this.selection();
    const screen = this.ctx?.screen as VnScreen | undefined;
    const visible = visibleEditors(screen ? panesOf(screen) : []);
    const anchors = redrawing('documents', 'rows');
    const marked = new Set(this.marking.marks);
    const clip = clipboard();
    renderTree(this.rows, rows, {
      look: (row) => ({
        selected: nodeIsSelected(row.node, selection),
        marked  : marked.has(row.node.id),
        cut     : isCut(clip, row.node.path),
        title: rowTitle(row.node, {
          renamable: renameOf(row.node) !== undefined,
          markable : markable(row.node),
          sheetless: this.sheetless(row.node),
          expanded : row.expanded,
        }),
      }),
      onToggle     : (id) => this.toggle(id),
      onClick      : (row, mods) => this.rowClick(row, mods),
      // A location mined from a heading has no sheet, so its second click writes one rather than
      // renaming — the only place in the tree where a second click authors a file. A file's label
      // is its name, so its second click renames the file on disk. A shot's second click opens the
      // frame it was drawn as, and a shot with no frame yet does nothing, as its tooltip says.
      onSecondClick: (row) => {
        const renamable = renameOf(row.node);
        if (renamable) this.beginRename(row.node.id, renamable);
        else if (row.node.kind === 'file' && markable(row.node)) this.renameFile(row.node);
        else if (this.sheetless(row.node)) void this.writeSheet(row.node.label);
        else if (row.node.kind === 'shot' && row.node.hash) this.openAsset(row.node.hash);
      },
      onMenu       : (row, x, y) => this.openMenu(row, x, y),
      // Records every row, the headings that only expand included, so a tour pointing at one still
      // has somewhere to draw its ring. The click itself is `pick`, which `onClick` installs.
      onRow        : (row, line) => anchors.record(line, rowAction(row, selection, visible)),
    });
  }

  /** A location known only from a scene heading: named, drawn, and with no file behind it. */
  private sheetless(node: DocNode): boolean {
    return node.kind === 'location' && node.path === undefined;
  }

  /**
   * Draw what points at the selected entity. The document tree supplies the backlinks even in
   * file mode, because the walk is the same either way and switching to file mode does not change
   * which scenes a character is in.
   */
  private rebuildPanel(): void {
    this.panel.textContent = '';
    const anchors = redrawing('documents', 'panel');

    const id = backlinkSubject(this.picked, this.selection());
    const links = id ? this.tree?.backlinks[id] : undefined;
    if (!links || !this.tree) return;
    const screen = this.ctx?.screen as VnScreen | undefined;
    const visible = visibleEditors(screen ? panesOf(screen) : []);

    const node = findNode(this.tree.roots, id);
    const head = el('div', 'dt-subject');
    head.append(
      el('span', 'dt-name', node?.label ?? id.slice(id.indexOf(':') + 1)),
      el('span', 'dt-kind', id.startsWith('location:') ? 'LOCATION' : 'CHARACTER'),
    );
    this.panel.appendChild(head);

    // The sheet row is labelled by where the sheet lives, because a character filed in the story
    // bible is still a character and the author would otherwise not know which of the two it is.
    if (links.sheet) {
      const sheet = links.sheet;
      const link = sheetLinkAction({ path: sheet, wiki: links.wiki !== undefined }, visible);
      this.panel.appendChild(
        anchors.act(el('div', 'dt-link', link.label), link, () => this.openDoc(sheet)),
      );
    }

    // The strip gets no empty-state sentence: the panel heading already names the subject, and the
    // scene and shot rows below are the rest of the answer. Saying a strip is empty earns its
    // place only in a pane showing one document.
    const strip = el('div', 'dt-strip');
    renderAssetStrip(strip, assetGroups(links), '', {
      onPick: (hash) => this.openAsset(hash),
      anchor: (box, asset, run) => anchors.act(box, cellAction(asset, visible), run),
    });
    this.panel.appendChild(strip);

    if (links.scenes.length > 0) {
      this.panel.appendChild(el('div', 'dt-section', 'SCENES'));
      for (const scene of links.scenes) {
        const link = sceneLinkAction(scene);
        this.panel.appendChild(
          anchors.act(el('div', 'dt-link', link.label), link, () =>
            this.publish({ ...this.selection(), sceneId: scene, shotId: '' }),
          ),
        );
      }
    }

    if (links.shots.length > 0) {
      this.panel.appendChild(el('div', 'dt-section', 'SHOTS'));
      for (const { scene, shot } of links.shots) {
        const link = shotLinkAction(scene, shot);
        this.panel.appendChild(
          anchors.act(el('div', 'dt-link', link.label), link, () =>
            this.publish({ ...this.selection(), sceneId: scene, shotId: shot }),
          ),
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Navigating
  // -------------------------------------------------------------------------

  private toggle(id: string): void {
    this.expanded = toggleExpanded(this.expanded, id);
    this.rebuild();
  }

  /**
   * Open every folder above `paths`, in both modes' ids, and refetch so the new rows are drawn and
   * marked. Added to the author's own expanded set rather than replacing it.
   */
  private reveal(paths: readonly string[]): void {
    this.expanded = new Set([...this.expanded, ...revealIds(paths)]);
    this.revealed = paths;
    void this.load();
  }

  /**
   * Shut everything, headings included. The set is emptied rather than reset to `defaultExpanded`,
   * because a request to close the tree means the whole tree and the five headings cost one click
   * each to reopen. An already-empty set is not a change, so it does not cost a rebuild.
   */
  private collapseAll(): void {
    if (this.expanded.size === 0) return;
    this.expanded = new Set();
    this.rebuild();
  }

  /** Applies a click to the marks, then does what a plain click does unless the click only marked. */
  private rowClick(row: DocRow, mods: ClickMods): void {
    this.clicked = row.node.id;
    const { next, plain } = markClick(this.marking, row, this.shown, mods);
    this.marking = next;
    if (plain) this.pick(row);
    else this.rebuild();
  }

  /**
   * Carries the expanded folders and the marks to where `doc.move` put their files, then refetches
   * the tree that has them. A move run from any window arrives here, not only this one's.
   */
  private followMove(moves: readonly FileMove[]): void {
    this.expanded = new Set([...this.expanded].map((id) => movedId(id, moves)));
    this.marking = remapMarks(this.marking, moves);
    void this.load();
  }

  /** Answers the paths of the drawn rows with these ids, in the order given. */
  private pathsOf(ids: readonly string[]): string[] {
    return ids.flatMap((id) => this.shown.find((row) => row.node.id === id)?.node.path ?? []);
  }

  /** Puts the marked rows on the window's clipboard. Bound to Ctrl+C and Ctrl+X. */
  private clipMarks(mode: ClipMode): void {
    const paths = this.pathsOf(this.marking.marks);
    if (paths.length > 0) setClip({ paths, mode });
  }

  /**
   * Pastes into the anchor row's folder, refused with the menu's own sentence where Paste would be
   * greyed. With no anchor drawn there is no folder to paste into, and nothing happens.
   */
  private pasteAtAnchor(): void {
    const anchor = this.shown.find((row) => row.node.id === this.marking.anchor);
    const into = anchor && pasteInto(anchor.node);
    if (into === undefined) return;
    const entry = pasteEntry(into, { clip: clipboard(), marked: [], dirty: draftPaths() });
    if (entry.refused !== undefined) say(entry.refused, true);
    else this.paste(entry.id, entry.props ?? {});
  }

  /** Runs a Paste. A Cut is used up once its move lands; a Copy stays to be pasted again. */
  private paste(id: string, props: Record<string, PropValue>): void {
    const clip = clipboard();
    void exec(id, props).then((outcome) => {
      report(outcome);
      if (outcome.ok && clipboard() === clip) setClip(pasted(clip));
    });
  }

  /**
   * Opens the Delete form a right-click would: over every marked row when two or more are marked,
   * else for the row last clicked. A greyed entry reports its sentence instead, and a row whose
   * menu offers no Delete does nothing. Bound to Delete.
   */
  private deleteAtKey(): void {
    const paths = this.pathsOf(this.marking.marks);
    const several = paths.length >= 2;
    const id = several ? this.marking.marks[0] : this.clicked;
    const row = this.shown.find((r) => r.node.id === id);
    if (!row) return;
    const entry = deleteFor(row.node, { ...NO_MENU_CONTEXT, marked: several ? paths : [] });
    if (entry === undefined) return;
    if (entry.refused !== undefined) say(entry.refused, true);
    else openCommandDialog(entry.id, entry.props);
  }

  /** Opens the file-name box on the anchor row when it is the only mark. Bound to F2. */
  private renameAtAnchor(): void {
    const { marks, anchor } = this.marking;
    if (marks.length !== 1 || marks[0] !== anchor) return;
    const row = this.shown.find((r) => r.node.id === anchor);
    if (row) this.renameFile(row.node);
  }

  /** Opens the file-name box on a row, or reports why the row's Rename… entry is greyed. */
  private renameFile(node: DocNode): void {
    const entry = renameEntry(node, { ...NO_MENU_CONTEXT, dirty: draftPaths() });
    const target = renamePathOf(node);
    if (entry === undefined || target === undefined) return;
    if (entry.refused !== undefined) say(entry.refused, true);
    else this.beginFileRename(node.id, target);
  }

  /** Takes every mark off and keeps the anchor. Bound to Escape while the tree has the keyboard. */
  private clearMarks(): void {
    if (this.marking.marks.length === 0) return;
    this.marking = { ...this.marking, marks: [] };
    this.rebuild();
  }

  private pick(row: DocRow): void {
    // A location is remembered here and nowhere else — there is no `ui.locationId` — and it is
    // remembered before the selection is compared, because a location with no sheet of its own
    // changes nothing about the selection and would otherwise never reach the panel.
    this.picked = row.node.kind === 'location' ? row.node.id : '';

    const current = this.selection();
    const next = selectionForNode(row.node, current);
    if (next === current) {
      // A grouping row names no subject, so clicking anywhere in it expands the row; otherwise
      // clicking the word "Characters" would do nothing at all. A counted `more` row expands on a
      // click for the same reason: it names nothing, and what it hides is the answer.
      if (row.expandable) this.toggle(row.node.id);
      else this.rebuild();
      return;
    }

    // An asset row is a slot and its children are that slot's earlier takes, so clicking the
    // already-selected row expands it instead of reselecting it. Assets only: a scene is
    // expandable too, and its shots must not appear and vanish as the author clicks around.
    if (row.node.kind === 'asset' && row.expandable && nodeIsSelected(row.node, current)) {
      this.toggle(row.node.id);
      return;
    }

    // The selection is published before routing: a shot needs two fields to name it and
    // `view.open` carries one string, so an editor opens on the selection it already sees.
    this.publish(next);
    this.route(row.node);
  }

  /**
   * Retitle a document in place. It is undoable like every other document write, because it is
   * one: `doc.rename` rewrites the field the name was read from, and the file never moves.
   */
  private beginRename(id: string, target: { path: string; name: string }): void {
    this.openBox(id, target.name, target.name.length, renameAction(target), (name) => {
      void exec('doc.rename', { path: target.path, name }).then(() => void this.load());
    });
  }

  /**
   * Rename a page, file or folder on disk: `doc.move` with `name`, into the folder it is already
   * in. The box starts with the file name and its stem selected. A path with unsaved edits is
   * refused before `exec`, since a move does not carry a draft along.
   */
  private beginFileRename(id: string, target: FileRename): void {
    const dot = target.folder ? -1 : target.name.lastIndexOf('.');
    const stem = dot > 0 ? dot : target.name.length;
    this.openBox(id, target.name, stem, fileRenameAction(target), (name) => {
      const refused = unsavedRefusal([target.path], draftPaths());
      if (refused !== undefined) {
        say(refused, true);
        this.rebuild();
        return;
      }
      void exec('doc.move', { paths: [target.path], into: target.into, name }).then((outcome) => {
        if (outcome.ok) report(outcome);
        void this.load();
      });
    });
  }

  /**
   * Turns a row's label into a text box: Enter commits and Escape leaves it alone. `commit` gets
   * the trimmed text, and only when it is not empty and differs from `value`, since an unchanged
   * name would cost a commit and an undo point for nothing. `select` is how much of `value` starts
   * selected.
   *
   * The row is found by node id rather than held onto, because the click that opened this rebuilt
   * the rows and the element the author double-clicked no longer exists.
   */
  private openBox(
    id: string,
    value: string,
    select: number,
    offer: Offer,
    commit: (name: string) => void,
  ): void {
    if (this.renaming) return;
    // `dataset.id` and `.tv-label` are `renderTree`'s stated contract, which is what lets the
    // rename box land in a row this pane did not build and no longer holds a reference to.
    const line = rowElementFor(this.rows, id);
    const label = line?.querySelector('.tv-label');
    if (!line || !label) return;

    this.renaming = id;
    const box = document.createElement('input');
    box.className = 'tv-rename';
    box.value = value;
    line.replaceChild(box, label);
    // Its own pass: the box appears and vanishes without the rows around it being redrawn, and a
    // detached node is dropped from the live set rather than reported as scrolled away.
    redrawing('documents', 'rename').record(box, offer);

    let settled = false;
    const finish = (name?: string): void => {
      if (settled) return;
      settled = true;
      this.renaming = '';
      if (name !== undefined && name !== '' && name !== value) commit(name);
      else this.rebuild();
    };

    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys hands Ctrl+Z and the shell's other gestures away mid-edit.
    box.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(box.value.trim());
      if (event.key === 'Escape') finish();
    });
    // Clicking away cancels the rename rather than committing it
    box.addEventListener('blur', () => finish());
    // Without this the click that puts the caret in the box counts as a third click on the row
    box.addEventListener('click', (event) => event.stopPropagation());

    box.focus();
    box.setSelectionRange(0, select);
  }

  /**
   * Open the right-click menu. The node under the cursor is selected first, so that "Regenerate"
   * and whatever the asset pane is showing cannot disagree about which asset is meant. It is not
   * routed to: opening a pane is what a left click does, and a menu should not rearrange the
   * screen before the author has chosen anything. A row marked among several keeps the other
   * marks, and the menu covers all of them; any other row becomes the only one.
   */
  private openMenu(row: DocRow, x: number, y: number): void {
    const { next: marking, targets } = menuTargets(this.marking, row);
    const paths = this.pathsOf(targets);
    const several = targets.length >= 2;
    const ctx: MenuContext = {
      clip  : clipboard(),
      marked: several ? paths : [],
      dirty : draftPaths(),
    };
    const entries = menuFor(row.node, this.order, ctx);
    this.clicked = row.node.id;
    if (entries.length === 0) return;

    this.marking = marking;
    this.picked = row.node.kind === 'location' ? row.node.id : '';
    const current = this.selection();
    const next = selectionForNode(row.node, current);
    if (next === current) this.rebuild();
    else this.publish(next);

    const title = several ? `${targets.length} items` : row.node.label;
    void showContextMenu(this.ctx as VnContext, x, y, title, entries, {
      'pane.view#order': () => this.setOrder(this.order === 'story' ? 'stored' : 'story'),
      'pane.view#cut'  : () => setClip({ paths, mode: 'cut' }),
      'pane.view#copy' : () => setClip({ paths, mode: 'copy' }),
      'doc.move#paste' : (props) => this.paste('doc.move', props),
      'doc.copy#paste' : (props) => this.paste('doc.copy', props),
      'doc.move#rename': () => {
        const target = renamePathOf(row.node);
        if (target) this.beginFileRename(row.node.id, target);
      },
    });
  }

  /**
   * Show the editor that answers for a node. `openNode` decides which editor and which pane; its
   * `elsewhere` arithmetic means any pane but the one asking, so opening an asset cannot replace
   * the tree it was clicked in.
   */
  private route(node: DocNode): void {
    openNode(this.ctx?.screen as VnScreen | undefined, node, this.ui.shotId);
  }

  private publish(next: Selection): void {
    const ui = this.ui;
    ui.sceneId = next.sceneId;
    ui.shotId = next.shotId;
    ui.characterId = next.characterId;
    ui.docPath = next.docPath;
    ui.assetHash = next.assetHash;
    ui.graphSlug = next.graphSlug;
    this.announce();
    this.rebuild();
  }

  /**
   * Show a document by path, which is what the backlink rows and the New… row have instead of a
   * node. It routes over a node standing in for the path, so exactly one place decides where a
   * document opens.
   */
  private openDoc(path: string): void {
    this.publish({ ...this.selection(), docPath: path });
    this.route({ id: `wiki:${path}`, kind: 'wiki', label: path, path });
  }

  /** Show an asset by hash, which is what the asset strip has instead of a node. */
  private openAsset(hash: string): void {
    this.publish({ ...this.selection(), assetHash: hash });
    this.route(assetNode(hash));
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(DocumentsEditor, 'vn.DocumentsEditor', ['mode : string', 'order : string']);
