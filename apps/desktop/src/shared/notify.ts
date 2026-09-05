/**
 * The pure half of the notification system: what a notification is about, which ones are shown,
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
 * no entry is `command` — an ordinary act, reported as one — rather than a thrown error, so a new
 * command can still report itself while this table has not caught up.
 */
const BY_NAMESPACE: Record<string, NotificationCategory> = {
  asset    : 'asset',
  art      : 'asset',
  concept  : 'asset',
  pipeline : 'pipeline',
  gate     : 'pipeline',
  agent    : 'agent',
  story    : 'document',
  doc      : 'document',
  upload   : 'document',
  workspace: 'workspace',
};

export function categoryOfCommand(id: string): NotificationCategory {
  return BY_NAMESPACE[id.split('.')[0] ?? ''] ?? 'command';
}

/**
 * Which command outcomes are worth a line in the log: the ones that did something, plus every
 * failure whether it did anything or not.
 *
 * Non-mutating successes are excluded because most of them are the UI asking questions —
 * `workspace.recent` runs on every header rebuild, `command.check` before every menu is drawn —
 * and they would bury an author's dozen rendered assets under hundreds of reads. They still flash
 * on screen; they are just not events.
 *
 * `notify.*` is excluded outright because archiving a notification would file a notification, and
 * `notify.deleteAll` would refill the log it had just emptied.
 */
export function shouldFileCommand(record: {
  id: string;
  status: 'ok' | 'error';
  mutating: boolean;
}): boolean {
  if (record.id.startsWith('notify.')) return false;
  return record.status === 'error' || record.mutating;
}

/** Records what the author has chosen to see. The default has every category on and nothing archived. */
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

/** How many rows the list draws before it asks whether to draw more. */
export const NOTIFICATION_PAGE = 30;

/** One page of the list, and how many rows are still behind it. */
export interface NotificationPage {
  rows: Notification[];
  /** Rows not drawn yet. Zero means the page reaches the end of the list. */
  more: number;
}

/**
 * The first `shown` of what the filter admits, plus the count still behind them.
 *
 * The log is append-only and never pruned, so a project a few weeks old holds thousands of rows.
 * Each one is a path.ux row with a wrapped paragraph inside it, and building every one of them is
 * what makes opening the bell slow; the author reads the newest handful and never scrolls to the
 * rest. `shown` below one page still draws one, since a list nothing can be added to is not a
 * list the author can page through.
 */
export function notificationPage(
  visible: readonly Notification[],
  shown: number,
): NotificationPage {
  const take = Math.min(Math.max(shown, NOTIFICATION_PAGE), visible.length);
  return { rows: visible.slice(0, take), more: visible.length - take };
}

/**
 * What the bell says. Counted over the filter so the badge and the list always agree, but never
 * over `showHidden`: an archived notification is dealt with, and turning that checkbox on must
 * leave the badge where it is.
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

/**
 * The commands a notification is allowed to name, by the thing it wants rather than by id — so a
 * caller writes `LINK_COMMANDS.releases` and the id lives in exactly one place.
 *
 * This is an allow-list rather than "any registered command", and the reason is where the log
 * comes from. `vngen/state/notifications.jsonl` is tracked and git union-merges it, so lines
 * arrive from clones, branches and other people's builds. A link that could name any command would
 * let one of those lines ask a click to start a paid pipeline run or empty the log. This is the
 * same move {@link linkTarget} makes against `EDITOR_IDS`, with a stronger reason: an unknown
 * editor is a pane that does not exist, an unknown command is an act nobody intended.
 *
 * Everything listed here must be non-mutating, argument-free, and something a person clicking a
 * notification obviously meant to do.
 */
export const LINK_COMMANDS = {
  /** VN Studio's releases page — where an update notice sends the author. */
  releases: 'app.openReleases',
} as const;

export type LinkCommand = (typeof LINK_COMMANDS)[keyof typeof LINK_COMMANDS];

const LINKABLE = new Set<string>(Object.values(LINK_COMMANDS));

/**
 * The command a link names, if it names one this build both has and allows. `notify.follow` checks
 * this before {@link linkTarget}, so a link carrying both a command and an editor runs the command.
 */
export function linkCommand(note: Notification): LinkCommand | undefined {
  const id = note.link?.command;
  return id && LINKABLE.has(id) ? (id as LinkCommand) : undefined;
}
