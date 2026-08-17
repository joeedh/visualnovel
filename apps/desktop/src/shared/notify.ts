/**
 * The pure half of the notification system: what a notification is *about*, which ones are shown,
 * and how many are unread. In `shared/` because both sides need it — main derives a category when
 * it files a command's outcome, the renderer filters and counts the same list when it draws it —
 * and because that makes it the half a node-only jest project can actually test.
 *
 * `shared/` is in the browser bundle, so nothing here may reach for node.
 */
import { NOTIFICATION_CATEGORIES, type Notification, type NotificationCategory } from '@vn/types';
import { EDITOR_IDS, type EditorId } from './editors.js';

/**
 * What a command's outcome is about, from the namespace it was registered under. A namespace with
 * no entry is `command` — an ordinary act, reported as one — rather than a thrown error: a new
 * command must never be unable to report itself just because this table has not caught up.
 */
const BY_NAMESPACE: Record<string, NotificationCategory> = {
  asset: 'asset',
  art: 'asset',
  concept: 'asset',
  pipeline: 'pipeline',
  gate: 'pipeline',
  agent: 'agent',
  story: 'document',
  doc: 'document',
  upload: 'document',
  workspace: 'workspace',
};

export function categoryOfCommand(id: string): NotificationCategory {
  return BY_NAMESPACE[id.split('.')[0] ?? ''] ?? 'command';
}

/**
 * Which command outcomes are worth a line in the log: the ones that **did** something, plus every
 * failure whether it did anything or not.
 *
 * Non-mutating successes are excluded because most of them are the UI asking questions —
 * `workspace.recent` runs on every header rebuild, `command.check` before every menu is drawn —
 * and a log burying an author's twelve rendered assets under four hundred reads is not a log.
 * They still flash on screen; they are just not events.
 *
 * `notify.*` is excluded outright, and that one is not a judgement call: archiving a notification
 * would file a notification, and `notify.deleteAll` would refill the log it had just emptied.
 */
export function shouldFileCommand(record: {
  id: string;
  status: 'ok' | 'error';
  mutating: boolean;
}): boolean {
  if (record.id.startsWith('notify.')) return false;
  return record.status === 'error' || record.mutating;
}

/** What the author has chosen to see. Every category on and nothing archived is the default. */
export interface NotificationFilter {
  categories: readonly NotificationCategory[];
  /** "Show deleted": include the ones hidden by an × or by Clear. */
  showHidden: boolean;
}

export const DEFAULT_FILTER: NotificationFilter = {
  categories: NOTIFICATION_CATEGORIES,
  showHidden: false,
};

/**
 * What the dialog draws: newest first, filtered. Reversed rather than re-sorted — the log is
 * already in `at` order and re-deriving that here is a second sort that could disagree with it.
 */
export function visibleNotifications(
  all: readonly Notification[],
  filter: NotificationFilter = DEFAULT_FILTER,
): Notification[] {
  const wanted = new Set(filter.categories);
  return all.filter((n) => wanted.has(n.category) && (filter.showHidden || !n.h)).reverse();
}

/**
 * What the bell says. Counted over the filter, so a count that says three and a list that shows
 * one cannot happen — but never over `showHidden`: an archived notification is dealt with, and
 * turning the checkbox on must not make the badge jump.
 */
export function unreadCount(
  all: readonly Notification[],
  filter: NotificationFilter = DEFAULT_FILTER,
): number {
  const wanted = new Set(filter.categories);
  return all.filter((n) => !n.r && !n.h && wanted.has(n.category)).length;
}

/**
 * Narrow a link's editor against the editors this build actually has. A link is stored as a bare
 * string — `@vn/types` sits below `shared/editors.ts` and cannot import the union — so a log
 * written by a build with an editor this one lacks would otherwise ask for a pane that does not
 * exist. Returns undefined, and the row stays a plain unlinked message.
 */
export function linkTarget(note: Notification): { editor: EditorId; subject?: string } | undefined {
  const editor = note.link?.editor;
  if (!editor || !(EDITOR_IDS as readonly string[]).includes(editor)) return undefined;
  return {
    editor: editor as EditorId,
    ...(note.link?.subject === undefined ? {} : { subject: note.link.subject }),
  };
}
