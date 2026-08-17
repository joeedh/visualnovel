import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_VERSION,
  migrateNotification,
  type Notification,
} from '../notifications.js';

const line = (over: Partial<Notification> = {}): Record<string, unknown> => ({
  v: NOTIFICATION_VERSION,
  r: 0,
  h: 0,
  id: '20260816-120000-abcd-0000',
  at: '2026-08-16T12:00:00.000Z',
  session: '20260816-120000-abcd',
  category: 'asset',
  level: 'info',
  source: 'pipeline',
  message: 'Rendered plate cafe/night',
  ...over,
});

describe('migrateNotification', () => {
  it('accepts a current line', () => {
    expect(migrateNotification(line())?.message).toBe('Rendered plate cafe/night');
  });

  it('keeps an optional link', () => {
    const note = migrateNotification(line({ link: { editor: 'asset', subject: '3f9a' } }));
    expect(note?.link).toEqual({ editor: 'asset', subject: '3f9a' });
  });

  // Skipping, not throwing: one line from tomorrow's build must not cost the author every other
  // line in the log. `@vn/store`'s `readShots` throws for the opposite reason — see the doc there.
  it('skips a line newer than this build rather than throwing', () => {
    expect(migrateNotification(line({ v: NOTIFICATION_VERSION + 1 }))).toBeUndefined();
  });

  it.each([
    ['no version', line({ v: undefined as unknown as number })],
    ['an unknown category', line({ category: 'weather' as Notification['category'] })],
    ['a non-digit flag', line({ r: true as unknown as 0 })],
    ['not an object', 'hello'],
    ['null', null],
  ])('skips %s', (_what, raw) => {
    expect(migrateNotification(raw)).toBeUndefined();
  });

  it('names every category exactly once', () => {
    expect(new Set(NOTIFICATION_CATEGORIES).size).toBe(NOTIFICATION_CATEGORIES.length);
  });
});
