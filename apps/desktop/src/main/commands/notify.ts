/**
 * Commands over the notification log. Reading it is an IPC channel (`notify:list`), but every
 * change to it is a command, because commands are the only write path — which also means the
 * agent and CDP can archive, unarchive and purge exactly as the dialog does.
 *
 * None is `undoable`, for the reason `agent.ts` already gives for threads: `vngen/state` is
 * outside `UNDO_PATHS`, so a journal entry could not restore a flag. They are `mutating: false`
 * for the same reason — nothing under the undo snapshot changes — apart from the one that
 * destroys the file.
 */
import { defineFor, prop } from '@vn/commands';
import { LINK_COMMANDS, linkCommand, linkTarget } from '../../shared/notify.js';
import { notifications } from '../notifications.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** The one notification an id names, or nothing. */
async function find(id: string) {
  const all = await notifications().list();
  return all.find((n) => n.id === id);
}

export const notifyList = define({
  id: 'notify.list',
  title: 'List notifications',
  description: 'Every notification this project has recorded, oldest first — archived ones too.',
  mutating: false,
  props: {},
  async run() {
    const notes = await notifications().list();
    const unread = notes.filter((n) => !n.r && !n.h).length;
    return { message: `${notes.length} recorded, ${unread} unread.`, data: notes };
  },
});

export const notifyMarkRead = define({
  id: 'notify.markRead',
  title: 'Mark a notification read',
  description: 'Clear one notification’s unread mark. It stays in the list.',
  mutating: false,
  props: { id: prop.string('the notification’s id') },
  async run({ id }) {
    if (!(await notifications().setFlags(id, { read: true })))
      throw new Error(`No notification ${id}.`);
    return { message: 'Marked read.' };
  },
});

export const notifyHide = define({
  id: 'notify.hide',
  title: 'Archive a notification',
  description:
    'Hide one notification from the list. It is still recorded, and “show deleted” brings it ' +
    'back — only `notify.deleteAll` actually removes anything.',
  mutating: false,
  props: { id: prop.string('the notification’s id') },
  async run({ id }) {
    if (!(await notifications().setFlags(id, { hidden: true })))
      throw new Error(`No notification ${id}.`);
    return { message: 'Archived.' };
  },
});

export const notifyUnhide = define({
  id: 'notify.unhide',
  title: 'Unarchive a notification',
  description: 'Put an archived notification back in the list — what the row’s Undo button runs.',
  mutating: false,
  props: { id: prop.string('the notification’s id') },
  async run({ id }) {
    if (!(await notifications().setFlags(id, { hidden: false })))
      throw new Error(`No notification ${id}.`);
    return { message: 'Restored.' };
  },
});

/**
 * Takes the ids the dialog drew rather than recomputing what is visible. The category filter lives
 * in the session store and only the dialog knows what it is showing, so re-deriving the list in
 * main would let a Clear hide something that was filtered off screen.
 */
export const notifyClear = define({
  id: 'notify.clear',
  title: 'Clear notifications',
  description: 'Archive the notifications named — the ones the list is showing.',
  mutating: false,
  props: { ids: prop.stringList('the notifications to archive') },
  async run({ ids }) {
    const hidden = await notifications().hideAll(ids);
    return {
      message: hidden === 1 ? 'Archived 1 notification.' : `Archived ${hidden} notifications.`,
    };
  },
});

export const notifyDeleteAll = define({
  id: 'notify.deleteAll',
  title: 'Delete all notifications permanently',
  description:
    'Empty the notification log. Unlike archiving this cannot be undone — the file is truncated ' +
    'and the record of what the app did is gone.',
  // Truncates a file the repo tracks, so the committer should record it. This is the only mutator
  // in this file, and the only one with a precondition worth asking about
  mutating: true,
  confirm: true,
  props: {},
  async check() {
    const count = (await notifications().list()).length;
    return count === 0
      ? { ok: false as const, reason: 'There are no notifications to delete.' }
      : {
          ok: true as const,
          note:
            count === 1
              ? 'Deletes 1 notification, for good.'
              : `Deletes ${count} notifications, for good.`,
        };
  },
  async run() {
    await notifications().purge();
    return { message: 'Deleted every notification.' };
  },
});

/**
 * Marks a notification read, then goes where it points. A notification with no link — or with one
 * naming an editor this build does not have, or a command it does not allow — is still marked read
 * and reports that it went nowhere rather than refusing, because the click did do something.
 *
 * A link naming a command is followed before a link naming an editor, through the same session
 * method the command itself wraps, the way `app.openKeyLink` sits over `session.openKeyLink`. A
 * notification therefore never carries a URL: the log names an act and the app derives the
 * destination. `linkCommand` narrows against a short allow-list, because these lines arrive from
 * other people's clones.
 */
export const notifyFollow = define({
  id: 'notify.follow',
  title: 'Open what a notification is about',
  description:
    'Mark one notification read and follow where it points — the editor it links to, or the act ' +
    'it names — if it points anywhere.',
  mutating: false,
  props: { id: prop.string('the notification’s id') },
  async run({ id }, ctx) {
    const note = await find(id);
    if (!note) throw new Error(`No notification ${id}.`);
    await notifications().setFlags(id, { read: true });

    const command = linkCommand(note);
    if (command !== undefined) {
      switch (command) {
        case LINK_COMMANDS.releases: {
          const opened = await ctx.host.session.openReleases();
          if (!opened.ok) throw new Error(opened.message);
          return { message: `Marked read. ${opened.message}` };
        }
      }
      // Adding an entry to `LINK_COMMANDS` without teaching this switch to follow it is a
      // compile error here rather than a link that silently goes nowhere.
      const unfollowable: never = command;
      throw new Error(`No way to follow ${String(unfollowable)}.`);
    }

    const target = linkTarget(note);
    if (!target) return { message: 'Marked read.' };
    ctx.host.ui(
      {
        type: 'view',
        action: 'open',
        editor: target.editor,
        where: 'elsewhere',
        subject: target.subject ?? '',
      },
      ctx.origin,
    );
    return { message: `Marked read, showing ${target.editor}.` };
  },
});
