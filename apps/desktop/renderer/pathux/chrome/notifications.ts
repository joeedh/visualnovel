/**
 * The renderer's half of the notification bell: a cached copy of the log, the popup that lists
 * it, and the popup that filters it.
 *
 * Nothing here decides what a notification is or which ones are shown. That lives in
 * `src/shared/notify.ts`, which both processes share and which the node-only jest project can
 * test. This file holds one fetch, one cached list, and the widgets over it.
 *
 * Every change to a notification leaves as a `notify.*` command, like every other mutation.
 */
import { UIBase, type Container } from 'pathux';
import {
  DEFAULT_FILTER,
  NOTIFICATION_PAGE,
  notificationPage,
  unreadCount,
  visibleNotifications,
  type NotificationFilter,
} from '../../../src/shared/notify.js';
import { NOTIFICATION_CATEGORIES, type Notification, type NotificationCategory } from '@vn/types';
import { api } from '../../api.js';
import { exec, shell } from '../app/bridge.js';
import { openCommandDialog } from './dialog.js';
import { VN_ICONS } from '../app/icons.js';
import { paragraph } from '../widgets/paragraph.js';
import { INSET, onPopupClosed, placeUnder, rectOf, stylePopup, type Anchor } from './popup.js';

/** What `Screen.popup` hands back: a container that also knows how to dismiss itself. */
type Popup = Container & { end(): void };

const WIDTH = 460;

/** How wide the category filter is. It holds a column of tickboxes, so it needs far less room. */
const FILTER_WIDTH = 200;

/** What the × at the end of a row takes off it, so a message wraps short of the × rather than under it. */
const ACTION = 48;

/** What a message may fill: the popup's width, less its own inset and the × beside it. */
const PROSE = WIDTH - INSET - ACTION;

const FILTER_KEY = 'vn.notifications.filter';

let cached: Notification[] = [];
let filter: NotificationFilter = restoreFilter();
let list: NotificationList | undefined;
let filters: FilterPopup | undefined;

function restoreFilter(): NotificationFilter {
  const stored = api.session.initial()[FILTER_KEY];
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return DEFAULT_FILTER;
  const saved = stored as { categories?: unknown; showHidden?: unknown };
  // Narrowed against the union rather than trusted, because a stored category this build dropped
  // would otherwise sit in the filter forever, invisible in the popup and still hiding rows
  const known = new Set<string>(NOTIFICATION_CATEGORIES);
  const categories = Array.isArray(saved.categories)
    ? saved.categories.filter(
        (c): c is NotificationCategory => typeof c === 'string' && known.has(c),
      )
    : DEFAULT_FILTER.categories;
  return { categories, showHidden: saved.showHidden === true };
}

function saveFilter(): void {
  api.session.set(FILTER_KEY, {
    categories: [...filter.categories],
    showHidden: filter.showHidden,
  });
}

/** What the bell counts. Kept on `ShellState` so the header rebuilds off its own state key. */
function publishUnread(): void {
  const ui = shell().ui;
  const next = unreadCount(cached, filter);
  if (ui.unread === next) return;
  ui.unread = next;
  shell().api.notifyChange();
}

/**
 * Re-read the log. Called at boot, whenever main says a notification changed, and after any
 * `notify.*` command — the flags are patched in a file, so a refetch is the only honest read.
 */
export async function refreshNotifications(): Promise<void> {
  cached = (await api.invoke('notify:list')) ?? [];
  publishUnread();
  list?.render();
}

/** Refetches, whether a notification arrived or an existing one's flags changed. */
export function notificationsChanged(): void {
  void refreshNotifications();
}

/** Run a `notify.*` command and take the new truth from the file rather than assuming it. */
async function act(id: string, props: Record<string, string | string[]> = {}): Promise<void> {
  await exec(id, props);
  await refreshNotifications();
}

class NotificationList {
  private readonly popup: Popup;
  private readonly body: Container;
  /** Rows the author archived this session, so the ×'d row can offer Undo in the same space. */
  private readonly archived = new Set<string>();
  /** How many rows this popup has been asked to draw. Rises a page at a time, never falls. */
  private shown = NOTIFICATION_PAGE;

  constructor(anchor?: Anchor) {
    const screen = shell().screen;
    if (!screen) throw new Error('no screen to hang the notifications on');

    // Hung under the bell that opened it, since a fixed `y` lands far from the bell in a window
    // whose chrome is taller than the header
    const [x, y] = placeUnder(screen.size[0], anchor, 40, WIDTH);
    this.popup = screen.popup(screen as unknown as UIBase, x, y, false) as Popup;
    stylePopup(this.popup, screen, WIDTH, y);

    // Escape and a click outside never reach `close`, so the singleton is cleared when the popup
    // is removed. An overridden `end` is not called on those paths, which left the bell toggling
    // nothing for the rest of the session.
    onPopupClosed(this.popup, () => {
      list = undefined;
      closeFilters();
    });

    this.body = this.popup.col();
    this.render();
    void refreshNotifications();
  }

  close(): void {
    this.popup.end();
  }

  render(): void {
    this.body.clear();
    const shown = this.showing();
    const page = notificationPage(shown, this.shown);

    this.header(shown, page.rows.length);
    const rows = this.body.col();
    rows.style['overflowY'] = 'auto';
    // Bounded by the window as well as by a fixed height, because 420px is taller than a short
    // screen and a list that runs off the bottom has no scrollbar the author can reach
    rows.style['maxHeight'] = 'min(420px, 60vh)';
    // A flex item's `min-height` is `auto`, meaning its content height, so without an explicit `0`
    // a scroller full of rows refuses to shrink, `overflow-y` never engages, and the overflow is
    // taken out of its siblings: the header and the rows are drawn through each other
    rows.style['minHeight'] = '0px';

    if (shown.length === 0) {
      const empty = rows.label(this.emptyBecause());
      empty.style['flexShrink'] = '0';
    }
    page.rows.forEach((note, i) => this.row(rows, note, i > 0));
    if (page.more > 0) this.moreRow(rows, page.more);

    this.body.flushUpdate();
  }

  /**
   * What the list draws: everything the filter admits, plus the rows ×'d in this popup. Dropping
   * a row the moment it is hidden would make the × read as a delete and leave nowhere to offer
   * the Undo, so an ×'d row keeps its place until the popup closes.
   */
  private showing(): Notification[] {
    const all = visibleNotifications(cached, { ...filter, showHidden: true });
    return all.filter((note) => !note.h || filter.showHidden || this.archived.has(note.id));
  }

  /** Why the list is empty, said in terms of what the author can change. */
  private emptyBecause(): string {
    if (cached.length === 0) return 'Nothing has happened yet.';
    if (filter.categories.length === 0) return 'Every category is filtered off.';
    return filter.showHidden
      ? 'Nothing matches this filter.'
      : 'Nothing new — everything is archived.';
  }

  /**
   * The way to the rest of the list. Drawing every row is what made opening the bell slow on a
   * project with a long log, so the rows behind this button are never built until it is pressed.
   */
  private moreRow(rows: Container, more: number): void {
    const row = rows.row();
    row.style['flexShrink'] = '0';
    const next = Math.min(more, NOTIFICATION_PAGE);
    const button = row.button(`Show ${next} more`, () => {
      this.shown += NOTIFICATION_PAGE;
      this.render();
    });
    button.description = `${more} older notification(s) are not drawn yet. This draws the next ${next}.`;
  }

  private header(shown: readonly Notification[], drawn: number): void {
    const row = this.body.row();
    // The list below is the part that scrolls, and a header allowed to shrink is the first thing
    // the rows are drawn on top of
    row.style['flexShrink'] = '0';
    // Both numbers, because a count that said only how many were drawn would read as the whole
    // log having that many rows in it.
    row.label(
      drawn < shown.length
        ? `NOTIFICATIONS · ${drawn} of ${shown.length}`
        : `NOTIFICATIONS · ${shown.length}`,
    );

    // An already-archived row is still drawn, offering its Undo; Clear has nothing to do to it.
    const live = shown.filter((note) => !note.h);
    // Clear archives without leaving Undo rows behind, unlike ×, which is one deliberate act on
    // one notification. `notify.unhide` brings a specific notification back.
    const clear = row.button('Clear', () => {
      this.archived.clear();
      void act('notify.clear', { ids: live.map((n) => n.id) });
    });
    clear.description = 'Archive everything this list is showing. Nothing is deleted.';
    clear.disabled = live.length === 0;

    const hidden = row.check(undefined, 'show deleted');
    hidden.checked = filter.showHidden;
    hidden.description = 'Include the notifications archived by × or by Clear.';
    // `on_change`, not `onchange` — path.ux's own hook (`ui_widgets.ts`), and the one
    // `commandform.ts` uses. A DOM-shaped name here is silently never called.
    hidden.on_change = (next: unknown) => {
      filter = { ...filter, showHidden: next === true };
      saveFilter();
      publishUnread();
      this.render();
    };

    // Read at click time rather than at build time: the row has not been laid out yet while it
    // is being built, so a rect taken here would be the zero one.
    const under = () => openFilters(rectOf(funnel));
    const funnel =
      VN_ICONS.filter >= 0
        ? row.iconbutton(VN_ICONS.filter, '', under)
        : row.button('Filter', under);
    funnel.description = 'Choose which kinds of notification this list shows.';

    const more = row.menu('⋯', [
      {
        name: 'Delete all notifications permanently…',
        callback: () => openCommandDialog('notify.deleteAll'),
        tooltip: 'Erase the whole log from disk. This cannot be undone.',
        id: 'deleteAll',
      },
    ]);
    more.description = 'The acts that are not one click.';
  }

  /**
   * One row. Archiving replaces its contents rather than the list — same row object, same
   * layout space — so the Undo the × offers sits exactly where the message was.
   *
   * The message is a wrapped paragraph rather than a button's label. A path.ux `Button` sets its
   * own height from the theme and its width to `max-content`, so a label longer than the popup
   * wraps inside a box still one line tall and is painted through the header above it and the
   * pane below. The paragraph is clickable in the button's place, and `×` stays a button because
   * a single glyph fits one.
   */
  private row(rows: Container, note: Notification, ruled: boolean): void {
    const row = rows.row();
    // A `colframe-x` is a flex column and a flex child shrinks before its parent scrolls, so
    // without this a long list squeezes every row to a few pixels and draws them through each
    // other instead of overflowing
    row.style['flexShrink'] = '0';
    // A wrapped message makes the row several lines tall, and a centred × then floats level with
    // the middle of the sentence rather than with the row it ends
    row.style['alignItems'] = 'flex-start';
    // Where one four-line message ends and the next begins, said in the layout rather than left
    // to the author to work out from the bullets. `setBoxCSS` rewrites margin, padding and
    // border-radius from the theme on every update, and leaves the other border properties alone.
    if (ruled) row.style['borderTop'] = '1px solid var(--ink-line, #232a35)';
    if (this.archived.has(note.id)) {
      row.label('archived');
      row.button('undo', () => {
        this.archived.delete(note.id);
        void act('notify.unhide', { id: note.id });
      }).description = 'Put this notification back in the list.';
      return;
    }

    // A read row keeps the bullet's width so the messages stay in one column. The spaces are
    // non-breaking because a plain one collapses away in wrapped prose.
    const mark = note.r ? '  ' : '● ';
    const open = paragraph(row, `${mark}[${note.category}] ${note.message}`, PROSE);
    open.description = `${note.level} · ${note.source} · ${note.at}`;
    // The label is only as wide as its text, so on a one-line message the × would otherwise land
    // mid-row instead of at the end of it
    open.style['flexGrow'] = '1';
    open.dom.style.cursor = 'pointer';
    open.dom.style.padding = '4px 0';
    open.addEventListener('click', () => {
      void act('notify.follow', { id: note.id });
    });

    const hide = row.button('×', () => {
      this.archived.add(note.id);
      void act('notify.hide', { id: note.id });
    });
    hide.description = 'Archive this notification. It can be brought back.';
  }
}

/** The category filter, anchored under the list's funnel. A second popup, not a mode. */
class FilterPopup {
  private readonly popup: Popup;
  private readonly body: Container;

  constructor(anchor?: Anchor) {
    const screen = shell().screen;
    if (!screen) throw new Error('no screen to hang the filter on');

    const [x, y] = placeUnder(screen.size[0], anchor, 80, FILTER_WIDTH);
    this.popup = screen.popup(screen as unknown as UIBase, x, y, false) as Popup;
    stylePopup(this.popup, screen, FILTER_WIDTH, y);

    onPopupClosed(this.popup, () => {
      filters = undefined;
    });

    this.body = this.popup.col();
    this.render();
  }

  close(): void {
    this.popup.end();
  }

  private render(): void {
    this.body.clear();
    this.body.label('SHOW');

    const on = new Set(filter.categories);
    // Drawn from the union itself, so a category added to `@vn/types` cannot go unfilterable.
    for (const category of NOTIFICATION_CATEGORIES) {
      const box = this.body.check(undefined, category);
      box.description = `Show ${category} notifications in the list.`;
      box.checked = on.has(category);
      box.on_change = (ticked: unknown) => {
        const next = new Set(filter.categories);
        if (ticked === true) next.add(category);
        else next.delete(category);
        this.apply(NOTIFICATION_CATEGORIES.filter((c) => next.has(c)));
      };
    }

    // Turns every category off rather than on, so an author can clear and then tick the one they
    // want; the default already has every category on
    const clear = this.body.button('Clear filters', () => this.apply([]));
    clear.description = 'Turn every category off, so one can be ticked back on by itself.';

    this.body.flushUpdate();
  }

  private apply(categories: readonly NotificationCategory[]): void {
    filter = { ...filter, categories };
    saveFilter();
    publishUnread();
    list?.render();
    this.render();
  }
}

/** Opens the list, or closes it if it is already open, so the bell never stacks two popups. */
export function openNotifications(anchor?: Anchor): void {
  if (list) {
    list.close();
    return;
  }
  list = new NotificationList(anchor);
}

function openFilters(anchor?: Anchor): void {
  if (filters) return;
  filters = new FilterPopup(anchor);
}

function closeFilters(): void {
  filters?.close();
  filters = undefined;
}
