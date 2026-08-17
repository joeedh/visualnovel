import type { Container } from 'pathux';
import { api } from '../../api.js';
import { ASSETSTRIP_CSS, renderAssetStrip } from '../assetstrip.js';
import { exec, onInvalidate } from '../bridge.js';
import type { VnContext } from '../context.js';
import {
  assetGroups,
  backlinkSubject,
  defaultExpanded,
  findNode,
  flattenTree,
  menuFor,
  nodeIsSelected,
  renameOf,
  selectionForNode,
  toggleExpanded,
  type DocRow,
} from '../doctree.js';
import { VnEditor, registerEditor } from '../editor.js';
import { assetNode, openNode } from '../open.js';
import { layoutChanged } from '../persist.js';
import type { VnScreen } from '../screen.js';
import { menuIsOpen, showContextMenu } from '../showmenu.js';
import type { Selection } from '../selection.js';
import DOCUMENTS_CSS from '../../styles/documents.css?inline';
import type { DocNode, DocTree } from '../../../src/shared/ipc.js';

/** Which tree the pane is drawing. Remembered per pane, so two of them can differ. */
type DocMode = 'documents' | 'files';

/** How close two clicks on one row have to be to mean "rename this". The platform default. */
const DOUBLE_CLICK_MS = 500;

/**
 * The sidebar, as a pane: the project's five branches — Story → scenes → shots, Characters,
 * Locations, Wiki, Assets by kind — over the tree `workspace:doctree` already builds, or every
 * file on disk when it is switched to file mode. A tenth editor rather than fixed chrome, so it
 * can be torn out, put on either side, or opened twice — once per mode.
 *
 * It owns no selection of its own. A click publishes `ui.sceneId` / `ui.shotId` /
 * `ui.characterId` / `ui.docPath` — which every other editor already observes — so the tree
 * steers the app without knowing what is open, and a scene picked in the branch graph lights here
 * without either editor knowing the other exists.
 *
 * Under the tree sits what points **at** the selected entity: her sheet, her art, the scenes and
 * shots she is in, straight out of `DocTree.backlinks`. It is here rather than in the Inspector
 * because the Inspector's subject is `ui.taskHash` — machine identity, a different axis — and
 * "which scenes is she in" should not cost a second pane.
 */
export class DocumentsEditor extends VnEditor {
  private bar!: Container;
  private surface!: HTMLDivElement;
  private rows!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private newRow!: HTMLDivElement;
  private newKind!: HTMLSelectElement;
  private newName!: HTMLInputElement;

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
  /** The last location clicked here, which is the only thing that knows one is selected. */
  private picked = '';
  /** A menu was up when the pointer went down, so the click it becomes is a dismissal. */
  private dismissing = false;
  /** The last row clicked and when, which is how a second click on the same one is recognised. */
  private lastClick = { id: '', at: -1 };
  /** The node being renamed right now, so a rebuild underneath the box cannot start a second one. */
  private renaming = '';
  private unwatch: (() => void) | undefined;

  static override define() {
    return {
      tagname: 'vn-documents-editor-x',
      areaname: 'documents',
      uiname: 'Documents',
      icon: -1,
    };
  }

  override init() {
    super.init();

    this.bar = (this.header as Container).row();

    this.adoptStyle(DOCUMENTS_CSS);
    this.adoptStyle(ASSETSTRIP_CSS);
    this.surface = el('div', 'dt-surface') as HTMLDivElement;
    this.rows = el('div', 'dt-rows') as HTMLDivElement;
    this.panel = el('div', 'dt-panel') as HTMLDivElement;
    this.surface.append(this.buildNewRow(), this.rows, this.panel);
    this.armDismissLatch();
    this.appendSurface(this.surface);

    // Coarse on purpose (decision 7 of the plan): there is no write effect to listen for, a tree
    // is one cached `loadProject` away, and a stale tree is worse than a redundant fetch.
    this.unwatch = onInvalidate(() => void this.load());

    void this.load();
  }

  override on_remove() {
    this.unwatch?.();
    this.unwatch = undefined;
    super.on_remove();
  }

  override update() {
    super.update();

    // A restored layout writes `mode` straight into the instance, and whether that lands before
    // or after `init` is path.ux's business — so the fetch is asked for here rather than assumed.
    if (!this.roots() && !this.pending && !this.failure) void this.load();
    if (this.stateKey() !== this.drawn) this.rebuild();
  }

  /** The tree currently being drawn, or undefined while its mode has yet to answer. */
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
      // Expansion is the author's, and survives every refetch after the first — a tree that
      // collapsed itself whenever something wrote a file would be unusable while working. One
      // set serves both modes: their node ids share no prefix, so neither can close the other.
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
    // Labelled with the mode it is in rather than the one it would switch to, which is the
    // reading the header's own PLAN/EXECUTE button already established.
    this.bar.button(files ? 'FILES' : 'DOCUMENTS', () =>
      this.setMode(files ? 'documents' : 'files'),
    );
    this.bar.button('New…', () => this.showNewRow());
    this.bar.button('Refresh', () => void this.load());
    this.bar.flushUpdate();
  }

  /**
   * Swallow the click that dismisses a context menu. path.ux closes a menu on mouse-up, so what
   * reaches the tree afterwards is an ordinary first click — and it selects, or toggles, whatever
   * row the pointer happened to be resting over. From the author's seat that is a right-click
   * rearranging the tree, which is exactly what a right-click must not do.
   *
   * Pointer-down is the only moment the question can be asked, because it is the last one at which
   * a menu is still open. Both listeners are capture-phase on the surface, so one latch covers
   * every row, twisty and backlink under it; and the latch is *assigned* on each pointer-down, so
   * a gesture that never becomes a click cannot leave it armed.
   */
  private armDismissLatch(): void {
    this.surface.addEventListener(
      'pointerdown',
      () => {
        this.dismissing = menuIsOpen();
      },
      true,
    );
    this.surface.addEventListener(
      'click',
      (event) => {
        if (!this.dismissing) return;
        this.dismissing = false;
        event.stopPropagation();
        event.preventDefault();
      },
      true,
    );
  }

  /**
   * The one authored act the tree itself performs: scaffold a sheet or a note from a name, and
   * open what it wrote. A row rather than a dialog — path.ux has no prompt, and the surface is
   * already raw DOM in this pane's shadow root.
   */
  private buildNewRow(): HTMLElement {
    this.newRow = el('div', 'dt-new') as HTMLDivElement;
    this.newRow.style.display = 'none';

    this.newKind = document.createElement('select');
    this.newKind.className = 'dt-new-kind';
    for (const kind of ['character', 'location', 'note'] as const) {
      const option = document.createElement('option');
      option.value = kind;
      option.textContent = kind;
      this.newKind.appendChild(option);
    }

    this.newName = document.createElement('input');
    this.newName.className = 'dt-new-name';
    this.newName.placeholder = 'name';
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
    // A refusal — a document already at that path — is already in the note frame, and the row
    // stays open over the name that earned it rather than making the author retype it.
    if (!outcome.ok) return;

    this.hideNewRow();
    this.openDoc((outcome.data as { path: string }).path);
  }

  private rebuildRows(): void {
    // Whatever was being renamed, its box is about to be thrown away with the row it sat in —
    // so the latch goes with it, rather than blocking every rename after the next refetch.
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

    const selection = this.selection();
    const rows = flattenTree(roots, this.expanded);
    if (rows.length === 0) {
      this.rows.appendChild(el('div', 'dt-note', 'Nothing in this workspace yet.'));
      return;
    }
    for (const row of rows) this.rows.appendChild(this.rowEl(row, selection));
  }

  private rowEl(row: DocRow, selection: Selection): HTMLElement {
    const { node } = row;
    const inert = node.kind === 'more';
    const group = node.kind === 'branch' || node.kind === 'assetkind';

    const line = el('div', 'dt-row') as HTMLDivElement;
    // The node's own id, so a rename opened by the second of two clicks can find the row the
    // first click's rebuild replaced. DOM identity does not survive a rebuild; this does.
    line.dataset['id'] = node.id;
    if (inert) line.classList.add('inert');
    if (group) line.classList.add('group');
    if (nodeIsSelected(node, selection)) line.classList.add('sel');
    line.style.paddingLeft = `${4 + row.depth * 13}px`;

    const twisty = el('span', 'dt-twisty', row.expandable ? (row.expanded ? '▾' : '▸') : '');
    line.appendChild(twisty);
    line.appendChild(el('span', 'dt-label', node.label));
    if (node.badge) {
      const badge = el('span', 'dt-badge', node.badge);
      if (node.badge === 'unreadable' || node.badge === 'unreachable') badge.classList.add('bad');
      line.appendChild(badge);
    }
    const renamable = renameOf(node);
    // A path is the useful thing to say where there is one; `note` is what a row with no file says
    // instead — a slot's own sentence — because no row may hover silently.
    if (node.path) {
      line.title = renamable ? `${node.path} — double-click the name to rename it` : node.path;
    } else if (node.note) {
      line.title = node.note;
    }

    if (!inert) {
      // The twisty is its own target so a node that is both a place and a container — a scene
      // with shots under it — can be opened without being selected, and selected without being
      // opened. Everything else follows from whether the click named anything.
      twisty.addEventListener('click', (event) => {
        event.stopPropagation();
        if (row.expandable) this.toggle(node.id);
      });
      // A double click is counted rather than listened for: the first click rebuilds the rows, so
      // by the time a `dblclick` was dispatched the element both clicks landed on is gone.
      line.addEventListener('click', (event) => {
        const again =
          this.lastClick.id === node.id && event.timeStamp - this.lastClick.at < DOUBLE_CLICK_MS;
        this.lastClick = again ? { id: '', at: -1 } : { id: node.id, at: event.timeStamp };
        this.pick(row);
        if (again && renamable) this.beginRename(node.id, renamable);
      });
      line.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.openMenu(row, event.clientX, event.clientY);
      });
    }
    return line;
  }

  /**
   * What points at the selected entity. Drawn from the document tree even in file mode: the
   * backlinks are the same walk either way, and an author who switched to files to find a note
   * has not stopped caring which scenes the character is in.
   */
  private rebuildPanel(): void {
    this.panel.textContent = '';

    const id = backlinkSubject(this.picked, this.selection());
    const links = id ? this.tree?.backlinks[id] : undefined;
    if (!links || !this.tree) return;

    const node = findNode(this.tree.roots, id);
    const head = el('div', 'dt-subject');
    head.append(
      el('span', 'dt-label', node?.label ?? id.slice(id.indexOf(':') + 1)),
      el('span', 'dt-kind', id.startsWith('location:') ? 'LOCATION' : 'CHARACTER'),
    );
    this.panel.appendChild(head);

    // The sheet, said as what it is: a character filed in the story bible is still a character,
    // and which of the two the author is looking at is the thing that would otherwise surprise.
    if (links.sheet) {
      const label = links.wiki ? 'in the story bible' : 'sheet';
      this.panel.appendChild(
        this.linkRow(`${label} · ${links.sheet}`, () => this.openDoc(links.sheet!)),
      );
    }

    // No sentence here: the panel already says what it is about, and the rows under it — scenes,
    // shots — are the rest of the answer. Emptiness is worth saying in a pane showing one document.
    const strip = el('div', 'dt-strip');
    renderAssetStrip(strip, assetGroups(links), '', { onPick: (hash) => this.openAsset(hash) });
    this.panel.appendChild(strip);

    if (links.scenes.length > 0) {
      this.panel.appendChild(el('div', 'dt-section', 'SCENES'));
      for (const scene of links.scenes) {
        this.panel.appendChild(
          this.linkRow(scene, () =>
            this.publish({ ...this.selection(), sceneId: scene, shotId: '' }),
          ),
        );
      }
    }

    if (links.shots.length > 0) {
      this.panel.appendChild(el('div', 'dt-section', 'SHOTS'));
      for (const { scene, shot } of links.shots) {
        this.panel.appendChild(
          this.linkRow(shot, () =>
            this.publish({ ...this.selection(), sceneId: scene, shotId: shot }),
          ),
        );
      }
    }
  }

  private linkRow(text: string, onClick: () => void): HTMLElement {
    const row = el('div', 'dt-link', text);
    row.title = text;
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

  private pick(row: DocRow): void {
    // A location is remembered here and nowhere else — there is no `ui.locationId` — and it is
    // remembered before the selection is compared, because a location with no sheet of its own
    // changes nothing about the selection and would otherwise never reach the panel.
    this.picked = row.node.kind === 'location' ? row.node.id : '';

    const current = this.selection();
    const next = selectionForNode(row.node, current);
    if (next === current) {
      // A grouping names nothing, so its whole row opens it — otherwise clicking the word
      // "Characters" would be the one click in the tree that does nothing at all.
      if (row.expandable) this.toggle(row.node.id);
      else this.rebuild();
      return;
    }

    // Selection first, always: a shot needs two fields to name it and `view.open` carries one
    // string, so an editor whose subject cannot travel opens on the selection it already sees.
    this.publish(next);
    this.route(row.node);
  }

  /**
   * Rename in place: the label becomes a text box over the row it was drawn in, Enter commits and
   * Escape leaves it alone. Undoable like every other document write, because it *is* one —
   * `doc.rename` rewrites the field the name was read from, and the file never moves.
   *
   * The row is found by node id rather than held onto: the click that opened this rebuilt the
   * rows, so the element the author double-clicked no longer exists.
   */
  private beginRename(id: string, target: { path: string; name: string }): void {
    if (this.renaming) return;
    const line = [...this.rows.children].find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.dataset['id'] === id,
    );
    const label = line?.querySelector('.dt-label');
    if (!line || !label) return;

    this.renaming = id;
    const box = document.createElement('input');
    box.className = 'dt-rename';
    box.value = target.name;
    box.title = 'Type the new name — Enter renames the document, Escape leaves it as it was';
    line.replaceChild(box, label);

    let settled = false;
    const finish = (name?: string): void => {
      if (settled) return;
      settled = true;
      this.renaming = '';
      // The name only travels if it changed: renaming a document to what it is called already is
      // a commit, an undo point and a rewritten file for nothing.
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
    // Clicking away is walking away, and walking away from a rename is not renaming.
    box.addEventListener('blur', () => finish());
    // Otherwise the click that puts the caret in the box is the row's third click.
    box.addEventListener('click', (event) => event.stopPropagation());

    box.focus();
    box.select();
  }

  /**
   * Right-click. The node under the cursor is selected first — otherwise "Regenerate" and whatever
   * the asset pane happens to be showing could disagree about which asset is meant — but it is not
   * routed to: opening a pane is what a left click is for, and a menu that rearranged the screen
   * before the author chose anything would be answering a question they have not asked yet.
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
   * Show the editor that answers for a node. Which one, and where, is `openNode`'s — the pane
   * arithmetic behind `elsewhere` already means "anywhere but the one asking", so opening an
   * asset can never replace the tree it was clicked in.
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
   * Show a document by path — what the backlink rows and the New… row have instead of a node.
   * Routed like everything else, over a node standing in for the path, so there is exactly one
   * place that decides where a document opens.
   */
  private openDoc(path: string): void {
    this.publish({ ...this.selection(), docPath: path });
    this.route({ id: `wiki:${path}`, kind: 'wiki', label: path, path });
  }

  /** The same, for a picture: the strip has a hash and the tree has a node, and both route. */
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
