import type { ContextLike, PopupContainer, UIBase } from 'pathux';
import { recentRow, type RecentPage } from '../../rules/wiki.js';
import { stepRow } from '../doctree/recent.js';
import type { AnchorPass } from '../tour/anchors.js';
import type { VnScreen } from '../app/screen.js';
import LINKCOMPLETE_CSS from '../../styles/linkcomplete.css?inline';

/** What the switcher reads from the pane that opened it, each read when needed. */
export interface SwitcherHost {
  screen(): VnScreen | undefined;
  /** The pane, which the popup is centred over and belongs to. */
  pane(): UIBase;
  /** The pages to offer, most recent first; the first is the one on screen. */
  pages(): readonly RecentPage[];
  /** A fresh anchor pass for the rows, opened on every rebuild and once more on close. */
  anchors(): AnchorPass;
  /** Shows a page in the pane. */
  show(path: string): void;
}

/** How wide the popup is, in CSS pixels. */
const WIDTH = 360;

/**
 * The Wiki pane's Ctrl+Tab switcher, which works like an editor's tab switcher. Ctrl+Tab opens a
 * popup over the pane listing the pages it has shown, most recent first, with the second row
 * highlighted; each further Tab moves the highlight down and Shift+Tab moves it up. Releasing Ctrl
 * shows the highlighted page, so a single Ctrl+Tab goes back to the previous page. Escape, a press
 * outside, or the window losing focus closes it without moving.
 *
 * Focus stays in the pane while the popup is up, so the popup's keys are heard on the window in the
 * capture phase, before the rich editor or the shell keymap sees them.
 */
export class RecentSwitcher {
  private popup: PopupContainer<ContextLike> | undefined;
  private list: HTMLDivElement | undefined;
  private rows: RecentPage[] = [];
  private active = 0;
  private off: (() => void) | undefined;

  constructor(private readonly host: SwitcherHost) {}

  get open(): boolean {
    return this.popup !== undefined;
  }

  /**
   * Moves the highlight by `by` rows, opening the popup on the row `by` steps from the page on
   * screen when it is closed. Does nothing with fewer than two pages to offer.
   */
  step(by: number): void {
    if (this.popup) {
      this.move(by);
      return;
    }
    const pages = this.host.pages();
    if (pages.length < 2) return;
    const screen = this.host.screen();
    if (!screen) return;

    this.rows = [...pages];
    this.active = stepRow(0, by, pages.length);
    const pane = this.host.pane().getBoundingClientRect();
    const x = Math.round(pane.left + Math.max(0, (pane.width - WIDTH) / 2));
    const y = Math.round(pane.top + Math.min(80, pane.height / 5));
    const popup = screen.popup(this.host.pane(), x, y, 'click', 5, window);
    this.popup = popup;
    const style = document.createElement('style');
    style.textContent = LINKCOMPLETE_CSS;
    this.list = document.createElement('div');
    this.list.className = 'lc-list';
    this.list.style.width = `${WIDTH}px`;
    this.list.style.maxWidth = `${WIDTH}px`;
    popup.shadow.append(style, this.list);

    const down = (e: KeyboardEvent) => this.onKeyDown(e);
    const up = (e: KeyboardEvent) => this.onKeyUp(e);
    const blur = () => this.close();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    this.off = () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
    // Every way out ends in the popup's remove, the press outside included; the popup's own hook
    // is what unregisters it from the screen, so it runs first
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
    this.rows = [];
    // An empty pass drops the rows' records, which would otherwise outlive the popup
    this.host.anchors();
  }

  private onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'Tab':
        this.move(e.shiftKey ? -1 : 1);
        break;
      case 'ArrowDown':
        this.move(1);
        break;
      case 'ArrowUp':
        this.move(-1);
        break;
      case 'Enter':
        this.commit(this.active);
        break;
      case 'Escape':
        this.close();
        break;
      case 'Control':
      case 'Meta':
      case 'Shift':
        return;
      default:
        // Any other key is meant for the pane or the shell, so the switcher steps aside for it
        this.close();
        return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /** Releasing the last of Ctrl and Cmd shows the highlighted page. */
  private onKeyUp(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.commit(this.active);
  }

  private move(by: number): void {
    this.active = stepRow(this.active, by, this.rows.length);
    this.paintActive();
  }

  private commit(index: number): void {
    const page = this.rows[index];
    this.close();
    if (page && index !== 0) this.host.show(page.path);
  }

  private rebuild(): void {
    const list = this.list;
    if (!list) return;
    list.replaceChildren();
    const head = document.createElement('div');
    head.className = 'lc-head';
    head.textContent = 'Recent pages — release Ctrl to open';
    list.appendChild(head);
    const anchors = this.host.anchors();
    this.rows.forEach((page, i) => {
      const row = document.createElement('div');
      row.className = 'lc-row';
      const name = document.createElement('div');
      name.className = 'lc-name';
      name.textContent = page.label;
      const path = document.createElement('div');
      path.className = 'lc-path';
      path.textContent = page.path;
      row.append(name, path);
      // A press on a row must not take the focus from the pane the author is typing in
      row.addEventListener('pointerdown', (e) => e.preventDefault());
      row.addEventListener('pointerenter', () => {
        this.active = i;
        this.paintActive();
      });
      anchors.act(row, recentRow(page, i === 0), () => this.commit(i));
      list.appendChild(row);
    });
    this.paintActive();
  }

  private paintActive(): void {
    const rows = this.list?.querySelectorAll('.lc-row') ?? [];
    rows.forEach((row, i) => row.classList.toggle('active', i === this.active));
  }
}
