import type { Container } from 'pathux';
import { api } from '../../api.js';
import { ASSETSTRIP_CSS, renderAssetStrip } from '../assetstrip.js';
import { exec, onInvalidate } from '../bridge.js';
import type { VnContext } from '../context.js';
import {
  assetGroups,
  backlinkSubject,
  defaultExpanded,
  filterTree,
  findNode,
  flattenTree,
  menuFor,
  nodeIsSelected,
  renameOf,
  rowTitle,
  selectionForNode,
  toggleExpanded,
  type DocRow,
} from '../doctree.js';
import { VnEditor, registerEditor } from '../editor.js';
import { VN_ICONS } from '../icons.js';
import { assetNode, openNode } from '../open.js';
import { layoutChanged } from '../persist.js';
import type { VnScreen } from '../screen.js';
import { menuIsOpen, showContextMenu } from '../showmenu.js';
import type { Selection } from '../selection.js';
import { TREEVIEW_CSS, armDismissLatch, renderTree, rowElementFor } from '../treeview.js';
import DOCUMENTS_CSS from '../../styles/documents.css?inline';
import type { DocNode, DocTree } from '../../../src/shared/ipc.js';

/** Which tree the pane is drawing. Remembered per pane, so two of them can differ. */
type DocMode = 'documents' | 'files';

/**
 * The sidebar, as a pane: the project's five branches — Story → scenes → shots, Characters,
 * Locations, Wiki, Assets by kind — over the tree `workspace:doctree` already builds, or every
 * file on disk when it is switched to file mode. It is an editor rather than fixed chrome, so it
 * can be torn out, put on either side, or opened twice — once per mode.
 *
 * It holds no selection of its own. A click publishes `ui.sceneId` / `ui.shotId` /
 * `ui.characterId` / `ui.docPath`, which every other editor already observes, so the tree steers
 * the app without knowing what is open, and a scene picked in the branch graph highlights here.
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
  /** The node being renamed right now, so a rebuild underneath the box cannot start a second one. */
  private renaming = '';
  /**
   * What the search box holds. Not remembered across sessions: a filter is a question about right
   * now, and a project reopening on three visible rows would read as a project that lost its files.
   */
  private query = '';

  static override define() {
    return {
      tagname: 'vn-documents-editor-x',
      areaname: 'documents',
      icon: -1,
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
    return this.mode === 'files' ? this.files : this.tree?.roots;
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
    layoutChanged();
    this.rebuild();
    if (!this.roots()) void this.load();
  }

  private selection(): Selection {
    const ui = this.ui;
    return {
      sceneId: ui.sceneId,
      shotId: ui.shotId,
      characterId: ui.characterId,
      docPath: ui.docPath,
      assetHash: ui.assetHash,
    };
  }

  private stateKey(): string {
    const ui = this.ui;
    return [
      this.mode,
      this.failure,
      this.token,
      this.picked,
      this.query,
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
    this.drawn = this.stateKey();
    this.rebuildBar();
    this.rebuildRows();
    this.rebuildPanel();
  }

  private rebuildBar(): void {
    const files = this.mode === 'files';
    this.bar.clear();
    // Labelled with the mode it is in rather than the one it would switch to, matching the
    // header's own PLAN/EXECUTE button.
    this.bar.button(files ? 'FILES' : 'DOCUMENTS', () =>
      this.setMode(files ? 'documents' : 'files'),
    ).description = files
      ? 'Showing every file on disk. Click to group by what the documents are instead.'
      : 'Showing cast, locations and scenes. Click to see the folders they live in instead.';
    this.bar.button('New…', () => this.showNewRow()).description =
      'Add a character, location, page or skill to this project';
    this.bar.button('Refresh', () => void this.load()).description =
      'Re-read the project from disk';
    // Folding the tree back up is not the same as reloading: expansion survives every refetch, so
    // without this button a tree left with dozens of open branches has to be closed row by row.
    const shut =
      VN_ICONS.collapse >= 0
        ? this.bar.iconbutton(VN_ICONS.collapse, '', () => this.collapseAll())
        : this.bar.button('Close all', () => this.collapseAll());
    shut.description = 'Fold every branch of the tree shut';
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
    // keys opens the palette on the first `/` of a query.
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
    // keys opens the palette on the first `/` of a name.
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

  private rebuildRows(): void {
    // A rename box is thrown away with the row it sat in, so clearing this here keeps a refetch
    // from blocking every later rename.
    this.renaming = '';
    this.rows.textContent = '';

    if (this.failure) {
      this.rows.appendChild(el('div', 'dt-note', this.failure));
      return;
    }
    const roots = this.roots();
    if (!roots) {
      this.rows.appendChild(el('div', 'dt-note', 'Reading the workspace…'));
      return;
    }

    // The filter's own open branches are added to the author's rather than replacing them, so a
    // matched node they had already expanded still shows what is under it.
    const filtered = filterTree(roots, this.query);
    const rows = flattenTree(filtered.roots, new Set([...this.expanded, ...filtered.expanded]));
    if (rows.length === 0) {
      const note = this.query.trim()
        ? `Nothing here is called “${this.query.trim()}”.`
        : 'Nothing in this workspace yet.';
      this.rows.appendChild(el('div', 'dt-note', note));
      return;
    }

    const selection = this.selection();
    renderTree(this.rows, rows, {
      look: (row) => ({
        selected: nodeIsSelected(row.node, selection),
        title: rowTitle(row.node, {
          renamable: renameOf(row.node) !== undefined,
          sheetless: this.sheetless(row.node),
          expanded: row.expanded,
        }),
      }),
      onToggle: (id) => this.toggle(id),
      onClick: (row) => this.pick(row),
      // A location mined from a heading has no sheet, so its second click writes one rather than
      // renaming — the only place in the tree where a second click authors a file.
      onSecondClick: (row) => {
        const renamable = renameOf(row.node);
        if (renamable) this.beginRename(row.node.id, renamable);
        else if (this.sheetless(row.node)) void this.writeSheet(row.node.label);
      },
      onMenu: (row, x, y) => this.openMenu(row, x, y),
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

    const id = backlinkSubject(this.picked, this.selection());
    const links = id ? this.tree?.backlinks[id] : undefined;
    if (!links || !this.tree) return;

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
      const label = links.wiki ? 'in the story bible' : 'sheet';
      this.panel.appendChild(
        this.linkRow(`${label} · ${links.sheet}`, `Open ${links.sheet}`, () =>
          this.openDoc(links.sheet!),
        ),
      );
    }

    // The strip gets no empty-state sentence: the panel heading already names the subject, and the
    // scene and shot rows below are the rest of the answer. Saying a strip is empty earns its
    // place only in a pane showing one document.
    const strip = el('div', 'dt-strip');
    renderAssetStrip(strip, assetGroups(links), '', { onPick: (hash) => this.openAsset(hash) });
    this.panel.appendChild(strip);

    if (links.scenes.length > 0) {
      this.panel.appendChild(el('div', 'dt-section', 'SCENES'));
      for (const scene of links.scenes) {
        this.panel.appendChild(
          this.linkRow(scene, `Go to ${scene}`, () =>
            this.publish({ ...this.selection(), sceneId: scene, shotId: '' }),
          ),
        );
      }
    }

    if (links.shots.length > 0) {
      this.panel.appendChild(el('div', 'dt-section', 'SHOTS'));
      for (const { scene, shot } of links.shots) {
        this.panel.appendChild(
          this.linkRow(shot, `Go to this shot of ${scene}`, () =>
            this.publish({ ...this.selection(), sceneId: scene, shotId: shot }),
          ),
        );
      }
    }
  }

  private linkRow(text: string, tip: string, onClick: () => void): HTMLElement {
    const row = el('div', 'dt-link', text);
    row.title = tip;
    row.addEventListener('click', onClick);
    return row;
  }

  // -------------------------------------------------------------------------
  // Navigating
  // -------------------------------------------------------------------------

  private toggle(id: string): void {
    this.expanded = toggleExpanded(this.expanded, id);
    this.rebuild();
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
   * Rename in place: the label becomes a text box over the row it was drawn in, Enter commits and
   * Escape leaves it alone. It is undoable like every other document write, because it is one —
   * `doc.rename` rewrites the field the name was read from, and the file never moves.
   *
   * The row is found by node id rather than held onto, because the click that opened this rebuilt
   * the rows and the element the author double-clicked no longer exists.
   */
  private beginRename(id: string, target: { path: string; name: string }): void {
    if (this.renaming) return;
    // `dataset.id` and `.tv-label` are `renderTree`'s stated contract, which is what lets the
    // rename box land in a row this pane did not build and no longer holds a reference to.
    const line = rowElementFor(this.rows, id);
    const label = line?.querySelector('.tv-label');
    if (!line || !label) return;

    this.renaming = id;
    const box = document.createElement('input');
    box.className = 'tv-rename';
    box.value = target.name;
    box.title = 'Type the new name — Enter renames the document, Escape leaves it as it was';
    line.replaceChild(box, label);

    let settled = false;
    const finish = (name?: string): void => {
      if (settled) return;
      settled = true;
      this.renaming = '';
      // The name is only sent if it changed: renaming a document to what it is already called
      // would cost a commit, an undo point and a rewritten file for nothing.
      if (name !== undefined && name !== '' && name !== target.name) {
        void exec('doc.rename', { path: target.path, name }).then(() => void this.load());
      } else {
        this.rebuild();
      }
    };

    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys opens the palette on the first `/` of a name.
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
    box.select();
  }

  /**
   * Open the right-click menu. The node under the cursor is selected first, so that "Regenerate"
   * and whatever the asset pane is showing cannot disagree about which asset is meant. It is not
   * routed to: opening a pane is what a left click does, and a menu should not rearrange the
   * screen before the author has chosen anything.
   */
  private openMenu(row: DocRow, x: number, y: number): void {
    const entries = menuFor(row.node);
    if (entries.length === 0) return;

    this.picked = row.node.kind === 'location' ? row.node.id : '';
    const current = this.selection();
    const next = selectionForNode(row.node, current);
    if (next === current) this.rebuild();
    else this.publish(next);

    void showContextMenu(this.ctx as VnContext, x, y, row.node.label, entries);
  }

  /**
   * Show the editor that answers for a node. `openNode` decides which editor and which pane; its
   * `elsewhere` arithmetic means any pane but the one asking, so opening an asset cannot replace
   * the tree it was clicked in.
   */
  private route(node: DocNode): void {
    openNode(this.ctx?.screen as VnScreen | undefined, node);
  }

  private publish(next: Selection): void {
    const ui = this.ui;
    ui.sceneId = next.sceneId;
    ui.shotId = next.shotId;
    ui.characterId = next.characterId;
    ui.docPath = next.docPath;
    ui.assetHash = next.assetHash;
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

registerEditor(DocumentsEditor, 'vn.DocumentsEditor', ['mode : string']);
