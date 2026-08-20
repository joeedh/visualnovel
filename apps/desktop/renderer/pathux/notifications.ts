/**
 * The notification bell's other half: the renderer's cached copy of the log, the popup that
 * lists it, and the popup that filters it.
 *
 * Nothing here decides *what* a notification is or which ones are shown — that is
 * `src/shared/notify.ts`, which both processes share and which the node-only jest project can
 * test. This file is the live half: one fetch, one cached list, and the widgets over it.
 *
 * Every change to a notification leaves as a `notify.*` command, like every other mutation.
 */
import { UIBase, type Container } from 'pathux';
import {
  DEFAULT_FILTER,
  unreadCount,
  visibleNotifications,
  type NotificationFilter,
} from '../../src/shared/notify.js';
import { NOTIFICATION_CATEGORIES, type Notification, type NotificationCategory } from '@vn/types';
import { api } from '../api.js';
import { exec, shell } from './bridge.js';
import { openCommandDialog } from './dialog.js';
import { VN_ICONS } from './icons.js';

/** What `Screen.popup` hands back: a container that also knows how to dismiss itself. */
type Popup = Container & { end(): void };

const WIDTH = 460;
const FILTER_KEY = 'vn.notifications.filter';

/**
 * Where a popup hangs from: the on-screen box of the control that opened it. `screen.popup` takes
 * client coordinates and the screen fills the window, so a `getBoundingClientRect()` goes straight
 * in with no conversion.
 */
export interface Anchor {
  right: number;
  bottom: number;
}

/**
 * Put a `WIDTH`-wide popup under `anchor`, right edges aligned, and keep it on screen.
 *
 * Right-aligned rather than left: both controls that open one sit at the right end of a bar, and a
 * 460px box starting at the bell would hang off the edge of the window. Without an anchor — the
 * palette, the agent, anything with no pointer behind it — it falls back to the top right corner.
 */
function place(
  screenWidth: number,
  anchor: Anchor | undefined,
  fallbackY: number,
): [number, number] {
  if (!anchor) return [Math.max(8, screenWidth - WIDTH - 16), fallbackY];
  const x = Math.min(Math.max(8, anchor.right - WIDTH), Math.max(8, screenWidth - WIDTH - 8));
  return [x, anchor.bottom + 4];
}

let cached: Notification[] = [];
let filter: NotificationFilter = restoreFilter();
let list: NotificationList | undefined;
let filters: FilterPopup | undefined;

function restoreFilter(): NotificationFilter {
  const stored = api.session.initial()[FILTER_KEY];
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return DEFAULT_FILTER;
  const saved = stored as { categories?: unknown; showHidden?: unknown };
  // Narrowed against the union rather than trusted: a stored category this build dropped would
  // otherwise sit in the filter forever, invisible in the popup and quietly hiding rows.
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

/** One notification arrived, or one's flags moved. Same answer either way: refetch. */
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

  constructor(anchor?: Anchor) {
    const screen = shell().screen;
    if (!screen) throw new Error('no screen to hang the notifications on');

    // Under the bell that opened it. It used to be pinned to the top right corner on a guessed
    // `y = 40`, which is the header's height in one theme and a few hundred pixels away from the
    // bell in any window whose chrome is taller.
    const [x, y] = place(screen.size[0], anchor, 40);
    this.popup = screen.popup(screen as unknown as UIBase, x, y, false) as Popup;
    this.popup.style['width'] = `${WIDTH}px`;

    const end = this.popup.end.bind(this.popup);
    this.popup.end = () => {
      list = undefined;
      closeFilters();
      end();
    };

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

    this.header(shown);
    const rows = this.body.col();
    rows.style['overflowY'] = 'auto';
    // Bounded by the window as well as by a number: 420px is taller than a short screen, and a
    // list that runs off the bottom has no scrollbar the author can reach.
    rows.style['maxHeight'] = 'min(420px, 60vh)';
    // The other half of that bound, and the one whose absence tangled the list. A flex item's
    // `min-height` is `auto`, which is its *content* height — so a scroller full of rows refuses
    // to shrink, `overflow-y` never engages, and the overflow is taken out of its siblings
    // instead: the header and the rows either side of it drawn through each other. Explicit `0`
    // is what lets the scrollbar do the job the max-height asked for.
    rows.style['minHeight'] = '0px';

    if (shown.length === 0) {
      const empty = rows.label(this.emptyBecause());
      empty.style['flexShrink'] = '0';
    }
    for (const note of shown) this.row(rows, note);

    this.body.flushUpdate();
  }

  /**
   * What the list draws. The filter's answer, **plus the rows ×'d in this popup** — dropping one
   * the moment it is hidden is what would make the × delete a row instead of archiving it, and
   * there would be nowhere left to offer the Undo. They keep their place until the popup closes.
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

  private header(shown: readonly Notification[]): void {
    const row = this.body.row();
    // Never squeezed: the list below it is the part that scrolls, and a header allowed to shrink
    // is the first thing the rows are drawn on top of.
    row.style['flexShrink'] = '0';
    row.label(`NOTIFICATIONS · ${shown.length}`);

    // An already-archived row is still drawn, offering its Undo; Clear has nothing to do to it.
    const live = shown.filter((note) => !note.h);
    // Clear hides; it does not leave a row behind. An × is one deliberate act on one notification
    // and gets its Undo — a Clear that turned the whole list into Undo buttons would have cleared
    // nothing. `notify.unhide` is still there for anyone who wants a specific one back.
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
   */
  private row(rows: Container, note: Notification): void {
    const row = rows.row();
    // A `colframe-x` is a flex column, and a flex child shrinks before its parent scrolls — so a
    // long list squeezed every row to a few pixels and drew all of them through each other
    // instead of overflowing. Refusing to shrink is what turns the max-height into a scrollbar.
    row.style['flexShrink'] = '0';
    if (this.archived.has(note.id)) {
      row.label('archived');
      row.button('undo', () => {
        this.archived.delete(note.id);
        void act('notify.unhide', { id: note.id });
      }).description = 'Put this notification back in the list.';
      return;
    }

    const mark = note.r ? '  ' : '● ';
    const open = row.button(`${mark}[${note.category}] ${note.message}`, () => {
      void act('notify.follow', { id: note.id });
    });
    open.description = `${note.level} · ${note.source} · ${note.at}`;

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

    const [x, y] = place(screen.size[0], anchor, 80);
    this.popup = screen.popup(screen as unknown as UIBase, x, y, false) as Popup;

    const end = this.popup.end.bind(this.popup);
    this.popup.end = () => {
      filters = undefined;
      end();
    };

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

    // Off, not on: "clear, then tick the one you want" is the fast path an author asks for, and
    // a button that turned everything back on would be the thing the default already is.
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

/**
 * The on-screen box of a widget, for hanging a popup under. Answers `undefined` for anything not
 * laid out yet, so a caller with nothing to measure gets the corner fallback rather than `0, 0`.
 */
export function rectOf(widget: unknown): Anchor | undefined {
  const box = (widget as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect?.();
  if (!box || (box.width === 0 && box.height === 0)) return undefined;
  return { right: box.right, bottom: box.bottom };
}

/** Open the list. Idempotent, like the palette — the bell clicked twice is one popup. */
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
