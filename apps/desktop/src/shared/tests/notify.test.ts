import { NOTIFICATION_CATEGORIES, type Notification, type NotificationCategory } from '@vn/types';
import {
  categoryOfCommand,
  DEFAULT_FILTER,
  linkTarget,
  shouldFileCommand,
  unreadCount,
  visibleNotifications,
} from '../notify.js';

let seq = 0;

function note(over: Partial<Notification> = {}): Notification {
  seq++;
  return {
    v: 1,
    r: 0,
    h: 0,
    id: `n${seq}`,
    at: `2026-08-16T00:00:${String(seq).padStart(2, '0')}.000Z`,
    session: 's',
    category: 'command',
    level: 'info',
    source: 'main',
    message: `note ${seq}`,
    ...over,
  };
}

describe('categoryOfCommand', () => {
  it.each([
    ['asset.accept', 'asset'],
    ['art.redraw', 'asset'],
    ['concept.whatever', 'asset'],
    ['pipeline.run', 'pipeline'],
    ['gate.approve', 'pipeline'],
    ['agent.run', 'agent'],
    ['story.newScene', 'document'],
    ['doc.write', 'document'],
    ['upload.files', 'document'],
    ['workspace.open', 'workspace'],
  ])('maps %s to %s', (id, expected) => {
    expect(categoryOfCommand(id)).toBe(expected);
  });

  it('falls back to command for a namespace with no entry', () => {
    expect(categoryOfCommand('view.open')).toBe('command');
    expect(categoryOfCommand('prompt.clear')).toBe('command');
  });

  it('never throws on a malformed id', () => {
    expect(categoryOfCommand('')).toBe('command');
    expect(categoryOfCommand('nodots')).toBe('command');
  });

  it('only ever answers with a real category', () => {
    const all = new Set<string>(NOTIFICATION_CATEGORIES);
    for (const id of ['asset.x', 'zzz.y', '', 'a.b.c'])
      expect(all.has(categoryOfCommand(id))).toBe(true);
  });
});

describe('shouldFileCommand', () => {
  it('files an act', () => {
    expect(shouldFileCommand({ id: 'story.newScene', status: 'ok', mutating: true })).toBe(true);
  });

  it('does not file a read that worked', () => {
    expect(shouldFileCommand({ id: 'workspace.recent', status: 'ok', mutating: false })).toBe(
      false,
    );
  });

  it('files a read that failed', () => {
    expect(shouldFileCommand({ id: 'workspace.recent', status: 'error', mutating: false })).toBe(
      true,
    );
  });

  // Without this a click on a notification files a notification, and delete-all refills the log.
  it('never files a notify command, however it ended', () => {
    expect(shouldFileCommand({ id: 'notify.hide', status: 'ok', mutating: false })).toBe(false);
    expect(shouldFileCommand({ id: 'notify.deleteAll', status: 'ok', mutating: true })).toBe(false);
    expect(shouldFileCommand({ id: 'notify.markRead', status: 'error', mutating: false })).toBe(
      false,
    );
  });
});

describe('visibleNotifications', () => {
  it('is newest first', () => {
    const all = [note(), note(), note()];
    expect(visibleNotifications(all).map((n) => n.id)).toEqual([
      all[2]!.id,
      all[1]!.id,
      all[0]!.id,
    ]);
  });

  it('hides archived ones by default and shows them on request', () => {
    const kept = note();
    const gone = note({ h: 1 });
    expect(visibleNotifications([kept, gone]).map((n) => n.id)).toEqual([kept.id]);
    expect(
      visibleNotifications([kept, gone], { ...DEFAULT_FILTER, showHidden: true }).map((n) => n.id),
    ).toEqual([gone.id, kept.id]);
  });

  it('keeps only the categories asked for', () => {
    const asset = note({ category: 'asset' });
    const doc = note({ category: 'document' });
    const filter = { categories: ['asset'] as NotificationCategory[], showHidden: false };
    expect(visibleNotifications([asset, doc], filter).map((n) => n.id)).toEqual([asset.id]);
  });

  it('shows nothing when every category is off — what "clear filters" leaves behind', () => {
    expect(visibleNotifications([note(), note()], { categories: [], showHidden: true })).toEqual(
      [],
    );
  });

  it('does not reorder or mutate what it was given', () => {
    const all = [note(), note()];
    const ids = all.map((n) => n.id);
    visibleNotifications(all);
    expect(all.map((n) => n.id)).toEqual(ids);
  });
});

describe('unreadCount', () => {
  it('counts the unread, unarchived ones', () => {
    expect(unreadCount([note(), note({ r: 1 }), note({ h: 1 }), note()])).toBe(2);
  });

  it('respects the category filter, so the badge cannot disagree with the list', () => {
    const all = [note({ category: 'asset' }), note({ category: 'document' })];
    expect(unreadCount(all, { categories: ['asset'], showHidden: false })).toBe(1);
  });

  // Turning "show deleted" on reveals dealt-with notifications; it must not raise the badge.
  it('ignores showHidden', () => {
    const all = [note(), note({ h: 1 })];
    expect(unreadCount(all, { ...DEFAULT_FILTER, showHidden: true })).toBe(1);
  });
});

describe('linkTarget', () => {
  it('is nothing when there is no link', () => {
    expect(linkTarget(note())).toBeUndefined();
  });

  it('narrows a known editor and carries the subject', () => {
    expect(linkTarget(note({ link: { editor: 'asset', subject: 'abc123' } }))).toEqual({
      editor: 'asset',
      subject: 'abc123',
    });
  });

  it('omits a subject that was never there rather than passing undefined through', () => {
    expect(linkTarget(note({ link: { editor: 'asset' } }))).toEqual({ editor: 'asset' });
  });

  // A log written by a build with an editor this one lacks must not ask for a pane that cannot exist.
  it('refuses an editor this build does not have', () => {
    expect(linkTarget(note({ link: { editor: 'holodeck', subject: 'x' } }))).toBeUndefined();
  });
});
