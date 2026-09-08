/**
 * The notification popup's situations: an empty log, a page of rows with one ×'d, a log longer
 * than a page, and the category filter up beside the list.
 */
import { situations } from './situation.js';
import type { NotificationsState } from '../notifications.js';
import { DEFAULT_FILTER, NOTIFICATION_PAGE } from '../../../src/shared/notify.js';
import type { Notification } from '@vn/types';

const note = (id: string, over: Partial<Notification> = {}): Notification => ({
  v: 1,
  r: 0,
  h: 0,
  id,
  at      : '2026-09-01T10:00:00.000Z',
  session : 's1',
  category: 'command',
  level   : 'info',
  source  : 'main',
  message : `Wrote scenes/arrival.md (${id})`,
  ...over,
});

/** One unread row with a link, one read row, and one ×'d in this popup. */
const ROWS: readonly Notification[] = [
  note('n1', { category: 'document', link: { editor: 'script', subject: 'scenes/arrival.md' } }),
  note('n2', { r: 1, level: 'warn', message: 'The image model returned 503; retrying.' }),
  note('n3', { h: 1, category: 'workspace', message: 'Opened the workspace.' }),
];

/** A page and one more, so the page button is drawn for the row behind it. */
const LONG: readonly Notification[] = Array.from({ length: NOTIFICATION_PAGE + 1 }, (_, i) =>
  note(`n${i + 1}`),
);

const idle: NotificationsState = {
  shown    : [],
  page     : NOTIFICATION_PAGE,
  archived : [],
  filter   : DEFAULT_FILTER,
  filtering: false,
};

export const SITUATIONS = situations<NotificationsState>(
  {
    name : 'empty',
    why: 'Nothing has happened yet, so Clear is refused and only the header’s controls are drawn.',
    state: idle,
  },
  {
    name : 'rows',
    why: 'Three rows are drawn: two offer follow and ×, and the one ×’d in this popup offers Undo instead.',
    state: { ...idle, shown: ROWS, archived: ['n3'] },
  },
  {
    name : 'paged',
    why  : 'The log runs past one page, so the button that draws the next page is offered.',
    state: { ...idle, shown: LONG },
  },
  {
    name : 'filtering',
    why: 'The category filter is up with two categories on, so each category’s tick and Clear filters are drawn beside the list.',
    state: {
      ...idle,
      shown    : ROWS.slice(0, 1),
      filter   : { categories: ['command', 'document'], showHidden: true },
      filtering: true,
    },
  },
);
