import {
  categoryAction,
  clearAction,
  clearFiltersAction,
  controls,
  deleteAllAction,
  filterAction,
  followAction,
  hideAction,
  pageAction,
  showHiddenAction,
  unhideAction,
  type NotificationsState,
} from '../notifications.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import { DEFAULT_FILTER, NOTIFICATION_PAGE } from '../../../src/shared/notify.js';
import { NOTIFICATION_CATEGORIES, type Notification } from '@vn/types';

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
  message : `Wrote ${id}`,
  ...over,
});

const state = (over: Partial<NotificationsState> = {}): NotificationsState => ({
  shown    : [],
  page     : NOTIFICATION_PAGE,
  archived : [],
  filter   : DEFAULT_FILTER,
  filtering: false,
  ...over,
});

describe('clearAction', () => {
  it('archives the live rows by id', () => {
    expect(clearAction(['n1', 'n2'])).toEqual({
      ok     : true,
      id     : 'notify.clear',
      props  : { ids: ['n1', 'n2'] },
      label  : 'Clear',
      tooltip: 'Archive everything this list is showing. Nothing is deleted.',
    });
  });

  it('is refused with nothing to archive, which greys the button', () => {
    expect(clearAction([])).toMatchObject({
      ok     : false,
      id     : 'notify.clear',
      refusal: { reason: 'Nothing is showing that could be archived.' },
    });
  });
});

describe('the row acts', () => {
  const n1 = note('n1', { level: 'warn', source: 'pipeline' });

  it('follow marks the row read and goes where it points', () => {
    expect(followAction(n1)).toEqual({
      ok     : true,
      id     : 'notify.follow',
      props  : { id: 'n1' },
      on     : 'n1',
      label  : 'Wrote n1',
      tooltip:
        'warn · pipeline · 2026-09-01T10:00:00.000Z — click to mark it read and go to what it is about',
    });
  });

  it('keys hide and unhide by the row, so two rows are two anchors', () => {
    expect(keyOf(hideAction(n1))).toBe('cmd:notify.hide#n1');
    expect(keyOf(unhideAction(n1))).toBe('cmd:notify.unhide#n1');
    expect(keyOf(followAction(note('n2')))).toBe('cmd:notify.follow#n2');
  });
});

describe('the header’s effects', () => {
  it('flips the show-deleted tick, saying which way', () => {
    expect(showHiddenAction(false)).toEqual({
      ok     : true,
      id     : 'pane.view',
      props  : { what: 'filter' },
      on     : 'hidden',
      label  : 'show deleted',
      tooltip: 'Include the notifications archived by × or by Clear.',
    });
    expect(showHiddenAction(true).tooltip).toMatch(/^Leave out/);
  });

  it('opens the filter as a box, and the delete-all form from the menu', () => {
    expect(filterAction()).toMatchObject({ id: 'popup.open', props: { popup: 'box' } });
    expect(keyOf(filterAction())).toBe('fx:popup.open#filter');
    expect(deleteAllAction()).toMatchObject({ id: 'notify.deleteAll', form: true });
  });

  it('draws the next page, a page at most', () => {
    expect(pageAction(3)).toMatchObject({
      id   : 'pane.view',
      props: { what: 'page' },
      label: 'Show 3 more',
    });
    expect(pageAction(100).label).toBe(`Show ${NOTIFICATION_PAGE} more`);
  });
});

describe('the filter’s boxes', () => {
  it('keys each category, and the clear button, apart', () => {
    expect(categoryAction('error', true)).toEqual({
      ok     : true,
      id     : 'pane.view',
      props  : { what: 'filter' },
      on     : 'filter/error',
      label  : 'error',
      tooltip: 'Leave error notifications out of the list.',
    });
    expect(categoryAction('error', false).tooltip).toBe('Show error notifications in the list.');
    expect(keyOf(clearFiltersAction())).toBe('fx:pane.view#filter/none');
  });
});

describe('controls', () => {
  it('lists the header alone over an empty log, with Clear refused', () => {
    const listed = controls(state());
    expect(listed.map(keyOf)).toEqual([
      'cmd:notify.clear',
      'fx:pane.view#hidden',
      'fx:popup.open#filter',
      'cmd:notify.deleteAll',
    ]);
    expect(listed[0]).toMatchObject({ ok: false });
  });

  it('offers follow and × per row, and undo in a row ×’d here', () => {
    const shown = [note('n1'), note('n2', { h: 1 })];
    const listed = controls(state({ shown, archived: ['n2'] }));
    expect(listed.slice(4).map(keyOf)).toEqual([
      'cmd:notify.follow#n1',
      'cmd:notify.hide#n1',
      'cmd:notify.unhide#n2',
    ]);
    // Only the live row is Clear's to archive
    expect(listed[0]).toMatchObject({ props: { ids: ['n1'] } });
  });

  it('draws the page button only past a page, and the filter boxes only while filtering', () => {
    const long = Array.from({ length: NOTIFICATION_PAGE + 2 }, (_, i) => note(`n${i}`));
    const paged = controls(state({ shown: long }));
    expect(paged.at(-1)).toMatchObject({ id: 'pane.view', label: 'Show 2 more' });
    const filtering = controls(state({ filtering: true }));
    expect(filtering.slice(4).map(keyOf)).toEqual([
      ...NOTIFICATION_CATEGORIES.map((c) => `fx:pane.view#filter/${c}`),
      'fx:pane.view#filter/none',
    ]);
    for (const listed of [paged, filtering]) expect(duplicateKeys(listed)).toEqual([]);
  });
});
