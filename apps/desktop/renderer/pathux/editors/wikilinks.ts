import type { ContextLike, PopupContainer, RichTextEditor } from 'pathux';
import { markdownOps, type MdDoc, type WikilinkStart } from 'pathux-richtext-markdown';
import { filterTargets, linkHref, linkTargets } from '../doctree/doclinks.js';
import { linkRow } from '../../rules/wiki.js';
import type { AnchorPass } from '../tour/anchors.js';
import type { VnScreen } from '../app/screen.js';
import LINKCOMPLETE_CSS from '../../styles/linkcomplete.css?inline';
import type { DocNode } from '../../../src/shared/ipc.js';
import type { EditorId } from '../../../src/shared/editors.js';

/** What the completion reads from the pane that opened it, each read when needed. */
export interface CompletionHost {
  editor(): RichTextEditor<ContextLike, MdDoc>;
  screen(): VnScreen | undefined;
  /** The open document's path, which the written href is relative to. */
  path(): string;
  /** The tree's roots as last fetched; the completion offers the documents in them. */
  roots(): readonly DocNode[];
  visible(): readonly EditorId[];
  /** A fresh anchor pass for the rows, opened on every rebuild. */
  anchors(): AnchorPass;
}

/**
 * The popup a typed `[[` opens, listing the documents a link could lead to. Typing goes on in
 * the editor: the popup never takes focus, reads the query out of the document after each
 * change (the text between the `[[` and the caret), and hears the arrow keys, Enter and Escape
 * on the editor's host before the pane does. Enter or a click on a row replaces the `[[` and
 * the query with an ordinary link to the document; Escape, or the caret leaving the query,
 * closes the popup and leaves what was typed.
 */
export class LinkCompletion {
  private popup: PopupContainer<ContextLike> | undefined;
  private start: WikilinkStart | undefined;
  private list: HTMLDivElement | undefined;
  private rows: DocNode[] = [];
  private active = 0;
  /** Where the query ends: the caret at the last change, which the pick replaces up to. */
  private to = 0;
  private query = '';
  private off: (() => void) | undefined;

  constructor(private readonly host: CompletionHost) {}

  get open(): boolean {
    return this.popup !== undefined;
  }

  /** Opens under the caret; a completion already open is closed first. */
  show(start: WikilinkStart): void {
    this.close();
    const screen = this.host.screen();
    const editor = this.host.editor();
    if (!screen) return;
    const at = caretRect(editor, start.block);
    if (!at) return;

    this.start = start;
    this.to = start.offset;
    this.query = '';
    this.active = 0;
    const popup = screen.popup(editor, at.left, at.bottom + 2, 'click', 0, window);
    this.popup = popup;
    const style = document.createElement('style');
    style.textContent = LINKCOMPLETE_CSS;
    this.list = document.createElement('div');
    this.list.className = 'lc-list';
    popup.shadow.append(style, this.list);
    // Focus stays in the editor, so the popup's own gestures come through the editor's keys
    const keys = ((e: KeyboardEvent) => this.onKey(e)) as EventListener;
    const changed = () => this.onChange();
    editor.addEventListener('keydown', keys, true);
    editor.addEventListener('change', changed);
    this.off = () => {
      editor.removeEventListener('keydown', keys, true);
      editor.removeEventListener('change', changed);
    };
    // Every way out ends in the popup's remove, the press outside included; the popup's own
    // hook is what unregisters it from the screen, so it runs first
    const unregister = popup.onRemove;
    popup.onRemove = () => {
      unregister?.();
      this.closed();
    };
    this.rebuild();
  }

  close(): void {
    this.popup?.end();
  }

  private closed(): void {
    this.off?.();
    this.off = undefined;
    this.popup = undefined;
    this.list = undefined;
    this.start = undefined;
    this.rows = [];
  }

  /**
   * The document changed under the popup. The query is what sits between the `[[` and the
   * caret; a caret elsewhere, a deleted bracket, or a `]` typed closes the completion.
   */
  private onChange(): void {
    const start = this.start;
    const editor = this.host.editor();
    const session = editor.session;
    if (!start || !session) return this.close();
    const text = session.provider.blockText(session.doc, start.block);
    const caret = editor.bridge.selection()?.head;
    if (
      !caret ||
      caret.block !== start.block ||
      caret.offset < start.offset ||
      text.slice(start.offset - 2, start.offset) !== '[['
    ) {
      return this.close();
    }
    const query = text.slice(start.offset, caret.offset);
    if (query.includes(']') || query.includes('\n')) return this.close();
    this.to = caret.offset;
    if (query !== this.query) {
      this.query = query;
      this.active = 0;
      this.rebuild();
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowDown':
        this.move(1);
        break;
      case 'ArrowUp':
        this.move(-1);
        break;
      case 'Enter': {
        const row = this.rows[this.active];
        if (row) this.pick(row);
        else this.close();
        break;
      }
      case 'Escape':
        this.close();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private move(by: number): void {
    if (this.rows.length === 0) return;
    this.active = (this.active + by + this.rows.length) % this.rows.length;
    this.paintActive();
  }

  /** Replaces the `[[` and the query with a link to `target`, shown as its name. */
  private pick(target: DocNode): void {
    const start = this.start;
    if (!start) return;
    const href = linkHref(this.host.path(), target);
    const op = markdownOps.insertWikilink(
      start.block,
      start.offset - 2,
      this.to,
      href,
      target.label,
      'url',
    );
    this.close();
    void this.host.editor().bridge.dispatch(op);
  }

  private rebuild(): void {
    const list = this.list;
    if (!list) return;
    this.rows = filterTargets(linkTargets(this.host.roots()), this.query);
    list.replaceChildren();
    if (this.rows.length === 0) {
      const none = document.createElement('div');
      none.className = 'lc-none';
      none.textContent =
        this.query === '' ? 'No documents to link to' : `Nothing named ${this.query}`;
      list.appendChild(none);
      return;
    }
    const anchors = this.host.anchors();
    const visible = this.host.visible();
    for (const target of this.rows) {
      const row = document.createElement('div');
      row.className = 'lc-row';
      const name = document.createElement('div');
      name.className = 'lc-name';
      name.textContent = target.label;
      const path = document.createElement('div');
      path.className = 'lc-path';
      path.textContent = target.path ?? '';
      row.append(name, path);
      // A press on a row must not take the focus, since the pick edits at the editor's caret
      row.addEventListener('pointerdown', (e) => e.preventDefault());
      anchors.act(row, linkRow(target, visible), () => this.pick(target));
      list.appendChild(row);
    }
    this.paintActive();
  }

  private paintActive(): void {
    const rows = this.list?.querySelectorAll('.lc-row') ?? [];
    rows.forEach((row, i) => row.classList.toggle('active', i === this.active));
  }
}

/**
 * Where the caret is on screen, for placing the popup: the collapsed selection's own rect when
 * the shadow root reports one, else the block the `[[` is in.
 */
function caretRect(
  editor: RichTextEditor<ContextLike, MdDoc>,
  block: string,
): { left: number; bottom: number } | undefined {
  const shadow = editor.shadow as ShadowRoot & { getSelection?: () => Selection | null };
  const selection = shadow.getSelection?.();
  if (selection && selection.rangeCount > 0) {
    const rect = selection.getRangeAt(0).getClientRects()[0];
    if (rect && (rect.width > 0 || rect.height > 0)) return rect;
  }
  return editor.bridge.blockElement(block)?.getBoundingClientRect();
}
