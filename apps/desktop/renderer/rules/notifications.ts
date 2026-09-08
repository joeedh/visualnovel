/**
 * What the notification popup offers: the five `notify.*` acts, the button that draws the next
 * page, the funnel that opens the category filter, and the filter's own boxes. The popup is an
 * anchor home like the header, so these anchors are live while it is up and gone when it closes.
 */
import { NOTIFICATION_CATEGORIES, type Notification, type NotificationCategory } from '@vn/types';
import {
  NOTIFICATION_PAGE,
  notificationPage,
  type NotificationFilter,
} from '../../src/shared/notify.js';
import { refuse, type Offer } from './anchors.js';
import { openPopup, view } from './effects.js';

/** What the popup reads when it draws its header, its rows and the filter beside it. */
export interface NotificationsState {
  /** Everything the filter admits, ×'d rows included, newest first. */
  shown: readonly Notification[];
  /** How many rows the list has been asked to draw; `notificationPage` rounds it up to a page. */
  page: number;
  /** Ids ×'d in this popup, whose rows offer Undo in the message's place. */
  archived: readonly string[];
  filter: NotificationFilter;
  /** Whether the category filter is up beside the list. */
  filtering: boolean;
}

/** Archive every row the list shows. Refused with nothing to archive, which greys the button. */
export function clearAction(live: readonly string[]): Offer {
  const control = {
    id     : 'notify.clear',
    label  : 'Clear',
    tooltip: 'Archive everything this list is showing. Nothing is deleted.',
  };
  if (live.length === 0) {
    return { ...refuse('Nothing is showing that could be archived.'), ...control };
  }
  return { ok: true, props: { ids: [...live] }, ...control };
}

/** The ⋯ menu's one entry, which opens the command's own form for its confirmation. */
export function deleteAllAction(): Offer {
  return {
    ok     : true,
    id     : 'notify.deleteAll',
    props  : {},
    label  : '⋯',
    tooltip: 'Erase the whole log from disk, after a confirmation. This cannot be undone.',
    form   : true,
  };
}

/** The "show deleted" tick. The filter is the popup's own, so flipping it is a view change. */
export function showHiddenAction(showing: boolean): Offer {
  return {
    ok: true,
    ...view('filter'),
    on     : 'hidden',
    label  : 'show deleted',
    tooltip: showing
      ? 'Leave out the notifications archived by × or by Clear.'
      : 'Include the notifications archived by × or by Clear.',
  };
}

/** The funnel, which opens the category filter as a second popup beside the list. */
export function filterAction(): Offer {
  return {
    ok: true,
    ...openPopup('box'),
    on     : 'filter',
    label  : 'Filter',
    tooltip: 'Choose which kinds of notification this list shows.',
  };
}

/** The button behind which the rest of the list waits, drawn a page at a time. */
export function pageAction(more: number): Offer {
  const next = Math.min(more, NOTIFICATION_PAGE);
  return {
    ok: true,
    ...view('page'),
    label  : `Show ${next} more`,
    tooltip: `${more} older notification(s) are not drawn yet. This draws the next ${next}.`,
  };
}

/** The message itself, which marks the notification read and goes where it points. */
export function followAction(note: Notification): Offer {
  return {
    ok     : true,
    id     : 'notify.follow',
    props  : { id: note.id },
    on     : note.id,
    label  : note.message,
    tooltip: `${note.level} · ${note.source} · ${note.at} — click to mark it read and go to what it is about`,
  };
}

/** The × at the end of a row. */
export function hideAction(note: Notification): Offer {
  return {
    ok     : true,
    id     : 'notify.hide',
    props  : { id: note.id },
    on     : note.id,
    label  : '×',
    tooltip: 'Archive this notification. It can be brought back.',
  };
}

/** The Undo drawn in an ×'d row's place. */
export function unhideAction(note: Notification): Offer {
  return {
    ok     : true,
    id     : 'notify.unhide',
    props  : { id: note.id },
    on     : note.id,
    label  : 'undo',
    tooltip: 'Put this notification back in the list.',
  };
}

/** One category's tick in the filter. */
export function categoryAction(category: NotificationCategory, on: boolean): Offer {
  return {
    ok: true,
    ...view('filter'),
    on     : `filter/${category}`,
    label  : category,
    tooltip: on
      ? `Leave ${category} notifications out of the list.`
      : `Show ${category} notifications in the list.`,
  };
}

/** The filter's Clear, which turns every category off so one can be ticked back on alone. */
export function clearFiltersAction(): Offer {
  return {
    ok: true,
    ...view('filter'),
    on     : 'filter/none',
    label  : 'Clear filters',
    tooltip: 'Turn every category off, so one can be ticked back on by itself.',
  };
}

/** Every offer the popup draws from this module, in the order it draws them. */
export function controls(state: NotificationsState): readonly Offer[] {
  const archived = new Set(state.archived);
  const live = state.shown.filter((note) => !note.h).map((note) => note.id);
  const page = notificationPage(state.shown, state.page);
  const list: Offer[] = [
    clearAction(live),
    showHiddenAction(state.filter.showHidden),
    filterAction(),
    deleteAllAction(),
  ];
  for (const note of page.rows) {
    if (archived.has(note.id)) list.push(unhideAction(note));
    else list.push(followAction(note), hideAction(note));
  }
  if (page.more > 0) list.push(pageAction(page.more));
  if (state.filtering) {
    const on = new Set(state.filter.categories);
    for (const category of NOTIFICATION_CATEGORIES) {
      list.push(categoryAction(category, on.has(category)));
    }
    list.push(clearFiltersAction());
  }
  return list;
}
