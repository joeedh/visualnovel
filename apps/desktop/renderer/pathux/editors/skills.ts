import type { Button, Container } from 'pathux';
import { api } from '../../api.js';
import { NEW_SKILL_PROMPT, underSkills } from '../../rules/skills.js';
import { onInvalidate, onWrote } from '../bridge.js';
import { openCommandDialog } from '../dialog.js';
import { DocBuffer, WRITE_SUPPLIES } from '../docbuffer.js';
import { redrawing } from '../anchors.js';
import {
  defaultExpanded,
  flattenTree,
  nodeIsSelected,
  rowTitle,
  toggleExpanded,
} from '../doctree.js';
import { VnEditor, registerEditor } from '../editor.js';
import { TREEVIEW_CSS, armDismissLatch, renderTree } from '../treeview.js';
import type { Selection } from '../selection.js';
import { menuIsOpen } from '../showmenu.js';
import SKILLS_CSS from '../../styles/skills.css?inline';
import type { DocNode } from '../../../src/shared/ipc.js';

/**
 * The project's skills — the playbooks under `.aiagent/skills`, as a tree of the files inside them
 * beside the file being edited. It is the one pane that shows the contents of a skill: the document
 * tree carries identity (one row per skill, `docs/reference/document-tree.md`), and the content is here.
 *
 * The text half is `DocBuffer`, exactly as Wiki's is — `doc.read` in, `doc.write` out, with the
 * draft, the `seenHash` refusal and the quit guard all coming from that one module rather than
 * being retyped here. What this pane owns is the tree beside it, its expansion, and the hint.
 *
 * The hint is functional rather than decorative. A skill is the one thing in the app the agent can
 * author, and an author who has not read `docs/` has no way to know that. So the sentence and its
 * button sit above the tree and are drawn whether or not any skill exists; an empty pane is exactly
 * when they are needed. The button opens the agent form (`agent.run` through
 * `openCommandDialog`) rather than running anything: `agent.run` is mutating and plan-first, so
 * what the author gets back is a proposed plan they still approve.
 *
 * `renderAssetStrip` is deliberately not reused. Nothing in the manifest binds to a skill file and
 * nothing ever will — every binding names a character, a location, a scene or a shot — so a strip
 * here would be permanently empty, which is worse than absent.
 */
export class SkillsEditor extends VnEditor {
  private surface!: HTMLDivElement;
  private rows!: HTMLDivElement;
  private text!: HTMLTextAreaElement;
  private pathEl!: HTMLSpanElement;
  private badge!: HTMLSpanElement;
  private noteEl!: HTMLSpanElement;
  private saveBtn!: Button;

  /**
   * The file in the box, which trails `ui.docPath` by one async read. The draft it files, the
   * `seenHash` refusal it earns and the quit guard behind it are `docbuffer.ts`'s — this pane owns
   * the widgets and nothing about the text.
   */
  private readonly buf = new DocBuffer(() => this.paint());

  /** The walk of `.aiagent/skills`, or undefined while it has yet to answer. */
  private roots: DocNode[] | undefined;
  private failure = '';
  /** The pane's own, not the tree widget's: `renderTree` draws rows and decides nothing. */
  private expanded: ReadonlySet<string> = new Set();
  /** Rising with every fetch, so a slow walk for a workspace that has moved on is dropped. */
  private token = 0;

  static override define() {
    return {
      tagname: 'vn-skills-editor-x',
      areaname: 'skills',
      icon: -1,
    };
  }

  override init() {
    super.init();

    const bar = (this.header as Container).row();
    bar.label('SKILLS').style['padding'] = '0px 8px';
    this.saveBtn = bar.button('Save', () => void this.buf.save());
    this.saveBtn.description = 'Write this skill file back to disk, and commit it';
    const reload = bar.button('⟳', () => void this.buf.reload());
    reload.description = 'Re-read this file from disk (discards an unsaved draft)';
    bar.flushUpdate();

    this.adoptStyle(SKILLS_CSS);
    this.adoptStyle(TREEVIEW_CSS);
    this.surface = el('div', 'sk-surface') as HTMLDivElement;
    this.surface.append(this.buildHint(), this.buildBody(), this.buildFoot());
    // The surface rather than the rows, so the latch covers the hint and the text box too.
    armDismissLatch(this.surface, menuIsOpen);
    this.appendSurface(this.surface);

    // A file this pane is showing can be written by something that is not this pane: `create_skill`
    // and `edit_skill` from the Convo pane, `doc.create kind='skill'` from the document tree, an
    // undo. What a clean and a dirty buffer each do about that is `DocBuffer.wrote`.
    this.watch(
      () => onWrote((paths) => this.buf.wrote(paths)),
      // Which paths moved while the pane was off screen is unknowable, so the one it is showing is
      // re-read on the same terms.
      () => this.buf.wrote([this.buf.path]),
    );
    // And the tree beside it, which a new skill changes without touching the open file at all.
    // Coarse on purpose: a walk is cheap and a stale tree is worse than a redundant fetch — which
    // is also why coming back on screen just walks it again rather than reasoning about the gap.
    this.watch(
      () => onInvalidate(() => void this.loadTree()),
      () => void this.loadTree(),
    );
    void this.loadTree();

    this.paint();
  }

  override update() {
    super.update();

    // Only a path under `.aiagent/skills` — a wiki note selected in another pane must not blank
    // this one, and the shared selection carries one `docPath` for every pane that watches it.
    const path = this.ui.docPath;
    if (underSkills(path) && path !== this.buf.path) void this.buf.open(path);
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  private buildHint(): HTMLElement {
    const hint = el('div', 'sk-hint');
    hint.appendChild(
      el('span', 'sk-hint-text', 'A skill is a playbook the agent can follow — and can write.'),
    );

    const button = el('button', 'sk-hint-button', 'Ask the agent for a skill…');
    button.title = 'Open the agent form with a request for a new skill — you say what it should do';
    button.addEventListener('click', () =>
      openCommandDialog('agent.run', { input: NEW_SKILL_PROMPT }),
    );
    hint.appendChild(button);
    return hint;
  }

  private buildBody(): HTMLElement {
    const body = el('div', 'sk-body');

    this.rows = el('div', 'sk-tree') as HTMLDivElement;
    body.appendChild(this.rows);

    this.text = document.createElement('textarea');
    this.text.className = 'sk-text';
    this.text.title = 'Edit this file as text. Ctrl+S saves and commits.';
    this.text.spellcheck = false;
    this.text.addEventListener('input', () => {
      this.buf.text = this.text.value;
    });
    // The screen keymap is a bubble-phase window listener, so a text box that does not stop its
    // own keydown events opens the palette when the author types the first `/` of a sentence.
    // This handler catches Ctrl+S for the same reason: Ctrl+S is the save gesture, and the
    // browser's own save shortcut does not save this file
    this.text.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.buf.save();
      }
    });
    body.appendChild(this.text);

    return body;
  }

  private buildFoot(): HTMLElement {
    const foot = el('div', 'sk-foot');
    this.pathEl = el('span', 'sk-path') as HTMLSpanElement;
    this.badge = el('span', 'sk-badge', 'unsaved') as HTMLSpanElement;
    this.noteEl = el('span', 'sk-note') as HTMLSpanElement;
    foot.append(this.pathEl, this.badge, this.noteEl);
    return foot;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /**
   * Walk `.aiagent/skills`. Its own channel rather than a filter over the file tree: that one is
   * capped across the whole project, so on a large one the skills could be truncated away and this
   * pane would draw nothing with no way to say why.
   */
  private async loadTree(): Promise<void> {
    const mine = ++this.token;
    const first = !this.roots;
    try {
      const roots = await api.invoke('workspace:skilltree');
      if (mine !== this.token) return;
      this.roots = roots;
      // Expansion is the author's and survives every refetch after the first — a tree that
      // collapsed itself whenever the agent wrote a skill would be unusable while working.
      if (first) this.expanded = new Set([...this.expanded, ...defaultExpanded(roots)]);
      this.failure = '';
    } catch (err) {
      if (mine !== this.token) return;
      this.failure = err instanceof Error ? err.message : String(err);
    }
    this.paintTree();
  }

  private paint(): void {
    const open = this.buf.path !== '';
    this.text.disabled = !open;
    // This assigns `text.value` only when it actually differs from the buffer, because assigning
    // `value` moves the caret, and the buffer already holds what the author is typing
    if (this.text.value !== this.buf.text) this.text.value = this.buf.text;
    this.pathEl.textContent = open ? this.buf.path : '';
    this.pathEl.title = this.pathEl.textContent;
    this.badge.style.display = this.buf.dirty ? 'inline-block' : 'none';
    const save = this.buf.saveOffer;
    this.saveBtn.disabled = !save.ok;
    // A disabled control's tooltip is its refusal — a greyed Save that will not say why is the
    // same bug as a hidden one.
    this.saveBtn.description = save.ok
      ? 'Write this skill file back to disk, and commit it'
      : save.reason;
    // Re-recorded on every paint rather than once with the bar: the bar is built at init and
    // the offer changes with the buffer, so a record kept from init would say `Nothing to save`
    // for the life of the pane.
    redrawing('skills', 'bar').act(this.saveBtn, save, () => void this.buf.save(), {
      supplies: WRITE_SUPPLIES,
    });
    this.noteEl.textContent = this.buf.note;
    this.noteEl.className = this.buf.bad ? 'sk-note bad' : 'sk-note';
    this.noteEl.title = this.buf.note;
    this.paintTree();
  }

  private paintTree(): void {
    this.rows.textContent = '';

    if (this.failure) {
      this.rows.appendChild(el('div', 'sk-empty', this.failure));
      return;
    }
    if (!this.roots) {
      this.rows.appendChild(el('div', 'sk-empty', 'Reading the skills…'));
      return;
    }

    const rows = flattenTree(this.roots, this.expanded);
    if (rows.length === 0) {
      // This message says nothing about adding a skill, because the New Skill button sits right above
      this.rows.appendChild(el('div', 'sk-empty', 'No skills yet.'));
      return;
    }

    const selection = this.selection();
    renderTree(this.rows, rows, {
      look: (row) => ({
        selected: nodeIsSelected(row.node, selection),
        // Nothing here is renamable — a skill's name is front-matter, not a path — and nothing is
        // a sheetless location, so both facts are false rather than derived.
        title: rowTitle(row.node, { renamable: false, sheetless: false, expanded: row.expanded }),
      }),
      onToggle: (id) => {
        this.expanded = toggleExpanded(this.expanded, id);
        this.paintTree();
      },
      onClick: (row) => this.pick(row.node),
    });
  }

  /**
   * A click. A directory opens; a file becomes the shared selection, which is what puts it in this
   * pane's own box — the buffer follows `ui.docPath` rather than being told directly, so a skill
   * file picked in the document tree lands here by the same route.
   */
  private pick(node: DocNode): void {
    if (node.path === undefined || node.kind !== 'file') {
      this.expanded = toggleExpanded(this.expanded, node.id);
      this.paintTree();
      return;
    }
    this.ui.docPath = node.path;
    this.announce();
    void this.buf.open(node.path);
    this.paintTree();
  }

  /** What `nodeIsSelected` compares against — only `docPath` can name anything in this tree. */
  private selection(): Selection {
    const ui = this.ui;
    return {
      sceneId: ui.sceneId,
      shotId: ui.shotId,
      characterId: ui.characterId,
      docPath: ui.docPath,
      assetHash: ui.assetHash,
      graphSlug: ui.graphSlug,
    };
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// No remembered fields: the pane's subject is the shared selection, and its expansion is a view of
// a tree that may not exist in the next workspace.
registerEditor(SkillsEditor, 'vn.SkillsEditor');
