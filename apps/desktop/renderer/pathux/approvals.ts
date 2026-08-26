/**
 * The renderer's half of the needs-approval badge: a cached copy of what is waiting, and the
 * popup that lists it.
 *
 * Nothing here decides what is waiting or which order it is read in. That is
 * `WorkspaceSession.approvable()` and `src/main/approvals.ts`, both of which the node-only jest
 * project can test. This file holds one fetch, one cached list, and the widgets over it.
 *
 * Approving is not done from here. A row opens the Asset editor, which is where an author sees
 * the picture before deciding, and the decision leaves as `asset.accept` or `gate.approve` like
 * every other mutation.
 */
import { UIBase, type Container } from 'pathux';
import type { Approvable } from '@vn/authoring';
import { api } from '../api.js';
import { exec, shell } from './bridge.js';
import { paragraph } from './paragraph.js';
import { INSET, onPopupClosed, placeUnder, stylePopup, type Anchor } from './popup.js';

/** What `Screen.popup` hands back: a container that also knows how to dismiss itself. */
type Popup = Container & { end(): void };

const WIDTH = 460;

/** What a row's prose may fill: the popup's width, less its own inset. */
const PROSE = WIDTH - INSET;

let cached: Approvable[] = [];
let list: ApprovalList | undefined;

/** What the badge counts. Kept on `ShellState` so the header rebuilds off its own state key. */
function publishNeedsApproval(): void {
  const ui = shell().ui;
  if (ui.needsApproval === cached.length) return;
  ui.needsApproval = cached.length;
  shell().api.notifyChange();
}

/**
 * Re-read the list. Called at boot and whenever main says the set changed — the answer is
 * computed from the project on disk, so a refetch is the only honest read.
 */
export async function refreshApprovals(): Promise<void> {
  cached = (await api.invoke('approval:list')) ?? [];
  publishNeedsApproval();
  list?.render();
}

/** Refetches, whether a picture arrived, was approved, or was superseded. */
export function approvalsChanged(): void {
  void refreshApprovals();
}

class ApprovalList {
  private readonly popup: Popup;
  private readonly body: Container;

  constructor(anchor?: Anchor) {
    const screen = shell().screen;
    if (!screen) throw new Error('no screen to hang the approvals on');

    const [x, y] = placeUnder(screen.size[0], anchor, 40, WIDTH);
    this.popup = screen.popup(screen as unknown as UIBase, x, y, false) as Popup;
    stylePopup(this.popup, screen, WIDTH, y);

    // Escape and a click outside never reach `close`, so the singleton is cleared when the popup
    // is removed rather than when it is dismissed.
    onPopupClosed(this.popup, () => {
      list = undefined;
    });

    this.body = this.popup.col();
    this.render();
    void refreshApprovals();
  }

  close(): void {
    this.popup.end();
  }

  render(): void {
    this.body.clear();

    const head = this.body.row();
    head.style['flexShrink'] = '0';
    head.label(`AWAITING APPROVAL · ${cached.length}`);

    const rows = this.body.col();
    rows.style['overflowY'] = 'auto';
    rows.style['maxHeight'] = 'min(420px, 60vh)';
    // A flex item's `min-height` is its content height, so without an explicit `0` a full
    // scroller refuses to shrink and its rows are drawn through the header above them
    rows.style['minHeight'] = '0px';

    if (cached.length === 0) {
      const empty = rows.label('Nothing needs approval.');
      empty.style['flexShrink'] = '0';
    }
    cached.forEach((item, i) => this.row(rows, item, i > 0));

    this.body.flushUpdate();
  }

  /**
   * Draws one picture's row. A blocked row is drawn like any other and stays clickable, because
   * what it is waiting on is worth reading, and the Asset editor is where the author acts on it.
   */
  private row(rows: Container, item: Approvable, ruled: boolean): void {
    const row = rows.col();
    // A flex child shrinks before its parent scrolls, so without this a long list squeezes every
    // row to a few pixels and draws them through each other
    row.style['flexShrink'] = '0';
    if (ruled) row.style['borderTop'] = '1px solid var(--ink-line, #232a35)';

    const open = paragraph(row, `[${item.kind}] ${item.label} — ${item.slot}`, PROSE);
    open.description = item.blocked ?? `Open ${item.label} in the Asset editor.`;
    open.style['flexGrow'] = '1';
    open.dom.style.cursor = 'pointer';
    open.dom.style.padding = '4px 0';
    open.addEventListener('click', () => {
      this.close();
      void exec('view.open', { editor: 'asset', where: 'elsewhere', subject: item.hash });
    });

    for (const note of notesFor(item)) {
      const muted = paragraph(row, note, PROSE);
      muted.dom.style.opacity = '0.7';
      muted.dom.style.paddingBottom = '4px';
    }
  }
}

/** What a row says under its name: why it cannot be approved yet, and what approving replaces. */
function notesFor(item: Approvable): string[] {
  const notes: string[] = [];
  if (item.blocked) notes.push(item.blocked);
  if (item.settled) {
    notes.push('Another take for this slot is already approved — approving this one replaces it.');
  }
  return notes;
}

/** Opens the list, or closes it if it is already open, so the button never stacks two popups. */
export function openApprovals(anchor?: Anchor): void {
  if (list) {
    list.close();
    return;
  }
  list = new ApprovalList(anchor);
}
