/**
 * The project's history as commands: the reads the History pane draws from, and the five local
 * writes. Every one is a thin wrapper over a `WorkspaceSession` method. A read takes no busy
 * flag, since it cannot disturb a run or an agent turn; a write does, through the session's
 * preview, which is also the command's `check`.
 */
import { defineFor, prop } from '@vn/commands';
import { ANY_DOCUMENT, GIT_ROOT } from '../../shared/affects.js';
import { REPO_ROLES } from '../../shared/history.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

const WHO = ['', 'author', 'agent', 'pipeline', 'housekeeping', 'other', 'unknown'] as const;

const repoProp = () =>
  prop.oneOf(REPO_ROLES, 'which of the project’s repositories', { default: 'project' });

const short = (sha: string): string => sha.slice(0, 7);

export const gitRepos = define({
  id         : 'git.repos',
  title      : 'The project’s repositories',
  description:
    'The repositories this project spans: its own, and the story bible’s and the base art’s ' +
    'when either is a repository of its own. One the project merely sits inside is listed too, ' +
    'marked as not owned, because saving never writes history there.',
  mutating   : false,
  props      : {},
  async run(_props, ctx) {
    const repos = await ctx.host.session.gitRepos();
    return {
      message: `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}.`,
      data   : repos,
    };
  },
});

export const gitHistory = define({
  id         : 'git.history',
  title      : 'The saves',
  description:
    'One page of the project’s saves, newest first: who made each, when, what it says and which ' +
    'files it touched. Fifty at a time; `before` names the save the next page starts after, ' +
    'which the previous page reports as `next`.',
  mutating   : false,
  props: {
    repo  : repoProp(),
    who   : prop.oneOf(WHO, 'only saves by this maker; empty for everyone', { default: '' }),
    path: prop.string('only saves that touched this path; empty for all of them', { default: '' }),
    text: prop.string('only saves whose message contains this; empty for all of them', {
      default: '',
    }),
    before: prop.string('the save the page starts after; empty for the newest page', {
      default: '',
    }),
  },
  async run({ repo, who, path, text, before }, ctx) {
    const page = await ctx.host.session.gitHistory(repo, {
      who,
      path,
      text,
      ...(before ? { before } : {}),
    });
    return { message: `${page.saves.length} save(s).`, data: page };
  },
});

export const gitChanges = define({
  id         : 'git.changes',
  title      : 'What a save changed',
  description:
    'Every path one save added, changed, renamed or removed, with the line counts where git ' +
    'could count them.',
  mutating   : false,
  props      : { repo: repoProp(), sha: prop.string('the save') },
  async run({ repo, sha }, ctx) {
    const changes = await ctx.host.session.gitChanges(repo, sha);
    return { message: `${changes.length} file(s).`, data: changes };
  },
});

export const gitDiff = define({
  id         : 'git.diff',
  title      : 'How a save changed one file',
  description:
    'The difference one save made to one file, shaped for what the file is: words inside ' +
    'paragraphs for prose and scenes, lines for everything else that is text, the pictures ' +
    'either side for an image, and only the counts for a log.',
  mutating   : false,
  props      : { repo: repoProp(), sha: prop.string('the save'), path: prop.string('the file') },
  async run({ repo, sha, path }, ctx) {
    const diff = await ctx.host.session.gitDiff(repo, sha, path);
    if (diff === null) throw new Error(`That save did not touch ${path}.`);
    return { message: `A ${diff.kind} diff.`, data: diff };
  },
});

export const gitBlob = define({
  id         : 'git.blob',
  title      : 'A file as it was',
  description:
    'One file exactly as it was at one save: its text, or for an image or anything else that ' +
    'is not text, an address the app can load the bytes from.',
  mutating   : false,
  props      : { repo: repoProp(), sha: prop.string('the save'), path: prop.string('the file') },
  async run({ repo, sha, path }, ctx) {
    const read = await ctx.host.session.gitBlob(repo, sha, path);
    if (read === null) throw new Error(`That save has no ${path}.`);
    return {
      message:
        read.kind === 'text' ? `${read.text.length} character(s).` : `${read.bytes} byte(s).`,
      data   : read,
    };
  },
});

export const gitStatus = define({
  id         : 'git.status',
  title      : 'Where the project stands',
  description:
    'Whether everything is saved, and if not, why: edits still waiting to be saved, files ' +
    'changed outside the app, or a sync that stopped part way. Also the branch, its remotes, ' +
    'and how many saves are unsent or unfetched.',
  mutating   : false,
  props      : { repo: repoProp() },
  async run({ repo }, ctx) {
    const status = await ctx.host.session.gitStatus(repo, ctx.host.pendingCommits());
    return { message: statusSentence(status.cause), data: status };
  },
});

/** What `git.save` says over an empty message. */
export const NO_MESSAGE = 'A save needs a message; say what changed.';

export const gitSave = define({
  id         : 'git.save',
  title      : 'Save under a message',
  description:
    'Save every file changed on disk as one save with this message. Every edit made in the ' +
    'app is saved as it is made, so this is for edits made outside it — another editor, a ' +
    'script — which otherwise ride into the next save. Refused while nothing has changed.',
  notes:
    'Commits the dirty tree under the author’s message. Writes nothing itself: commit-on-save makes the commit, with `Vn-Command: git.save` and the message as the subject.',
  mutating   : true,
  affects    : [GIT_ROOT],
  props: {
    repo   : repoProp(),
    message: prop.string('what this save is, in one line'),
  },
  async check({ repo, message }, ctx) {
    if (message.trim() === '') return { ok: false, reason: NO_MESSAGE };
    return ctx.host.session.previewSave(repo);
  },
  async run({ repo, message }, ctx) {
    if (message.trim() === '') throw new Error(NO_MESSAGE);
    const { saved } = await ctx.host.session.gitSave(repo);
    const subject = message.trim().split('\n')[0]!.trim();
    return {
      message: saved ? `Saved: ${subject}` : 'Nothing was left to save.',
      subject,
    };
  },
});

export const gitCheckpoint = define({
  id         : 'git.checkpoint',
  title      : 'Name a checkpoint',
  description:
    'Give one save a name, so it can be found and gone back to later. The latest save unless ' +
    '`sha` picks another; a note, if given, is kept with the name. Refused when the name is ' +
    'already in use.',
  notes:
    'An annotated tag under `refs/tags/vn/checkpoint/<slug>`; the name is the tag message’s first line, the note its body. Refused on a slug collision, by name.',
  mutating   : true,
  affects    : [GIT_ROOT],
  props: {
    repo: repoProp(),
    name: prop.string('the name, as the author would say it'),
    sha : prop.string('the save to name; empty for the latest', { default: '' }),
    note: prop.string('why this point is worth keeping; empty for none', { default: '' }),
  },
  check      : ({ repo, name, sha }, ctx) => ctx.host.session.previewCheckpoint(repo, name, sha),
  async run({ repo, name, sha, note }, ctx) {
    const made = await ctx.host.session.gitCheckpoint(repo, name, sha, note);
    return {
      message: `Named save ${short(made.entry.sha)} “${made.name}”.`,
      data   : { slug: made.slug, sha: made.entry.sha },
    };
  },
});

export const gitDropCheckpoint = define({
  id         : 'git.dropCheckpoint',
  title      : 'Drop a checkpoint',
  description:
    'Take the name off a checkpoint. The save it named stays in history; only the name goes.',
  notes      : 'Deletes the tag. The commit is untouched.',
  mutating   : true,
  affects    : [GIT_ROOT],
  props      : { repo: repoProp(), name: prop.string('the checkpoint, by name') },
  check      : ({ repo, name }, ctx) => ctx.host.session.previewDropCheckpoint(repo, name),
  async run({ repo, name }, ctx) {
    const dropped = await ctx.host.session.gitDropCheckpoint(repo, name);
    return {
      message: `Dropped the checkpoint “${dropped.name}”; save ${short(dropped.sha)} is unchanged.`,
      data   : { slug: dropped.slug, sha: dropped.sha },
    };
  },
});

export const gitTakeBack = define({
  id         : 'git.takeBack',
  title      : 'Take back a save',
  description:
    'Reverse what one save did, as a new save. Nothing in history is deleted. Refused while ' +
    'there are unsaved edits on disk, for a merge, for the first save, and for a save whose ' +
    'files a later save changed again — go back to a save, or bring back one file, instead.',
  notes:
    '`revert --no-commit` then a reset of the index, so the committer sees a plain dirty tree rather than a revert in progress. A revert that conflicts is aborted before this returns. Undo history from before it no longer applies.',
  mutating   : true,
  affects    : [...ANY_DOCUMENT, GIT_ROOT],
  confirm    : true,
  props      : { repo: repoProp(), sha: prop.string('the save to take back') },
  check      : ({ repo, sha }, ctx) => ctx.host.session.previewTakeBack(repo, sha),
  async run({ repo, sha }, ctx) {
    const { entry, written } = await ctx.host.session.gitTakeBack(repo, sha);
    return {
      message: `Took back save ${short(entry.sha)}: ${entry.subject}`,
      subject: `Took back: ${entry.subject}`,
      data   : { sha: entry.sha, files: written.length },
      written,
    };
  },
});

export const gitGoBack = define({
  id         : 'git.goBack',
  title      : 'Go back to a save',
  description:
    'Put every file back to how it was at one save, as a new save. Nothing in history is ' +
    'deleted, so going back can itself be gone back from. Refused while there are unsaved edits ' +
    'on disk, and when the project is already there.',
  notes:
    '`applyTree(treeOf(HEAD), treeOf(sha))` over the whole tree, no exclusions; commit-on-save makes the save. Undo history from before it no longer applies.',
  mutating   : true,
  affects    : [...ANY_DOCUMENT, GIT_ROOT],
  confirm    : true,
  props      : { repo: repoProp(), sha: prop.string('the save to go back to') },
  check      : ({ repo, sha }, ctx) => ctx.host.session.previewGoBack(repo, sha),
  async run({ repo, sha }, ctx) {
    const { entry, written, checkpoint } = await ctx.host.session.gitGoBack(repo, sha);
    const subject = checkpoint
      ? `Went back to checkpoint: ${checkpoint}`
      : `Went back to: ${entry.subject}`;
    return {
      message: `Went back to save ${short(entry.sha)}: ${entry.subject}`,
      subject,
      data: { sha: entry.sha, files: written.length },
      written,
    };
  },
});

export const gitRestoreFile = define({
  id         : 'git.restoreFile',
  title      : 'Bring back a file',
  description:
    'Rewrite one file as it was at one save, over the copy on disk, as an edit of its own that ' +
    'undo reverses. A scene is checked first and refused if it would not load; a key, a cache ' +
    'and anything that is not text are refused.',
  notes:
    'Through the ordinary whole-file write, so the write is hashed, cached and snapshotted. A scene is validated through `@vn/model` and then written verbatim, since `scenes/` has no whole-file writer.',
  mutating   : true,
  affects    : ANY_DOCUMENT,
  undoable   : true,
  props: {
    repo: repoProp(),
    sha : prop.string('the save to bring the file back from'),
    path: prop.string('the file, as that repository names it'),
  },
  check      : ({ repo, sha, path }, ctx) => ctx.host.session.previewRestoreFile(repo, sha, path),
  async run({ repo, sha, path }, ctx) {
    const back = await ctx.host.session.gitRestoreFile(repo, sha, path);
    const note = back.diagnostic ? ` ${back.diagnostic}` : '';
    return {
      message: `Brought back ${back.path} from save ${short(sha)}.${note}`,
      data   : back,
      written: [back.path],
    };
  },
});

/** The one line the status view leads with, per cause. */
export function statusSentence(cause: string): string {
  switch (cause) {
    case 'clean':
      return 'Everything is saved.';
    case 'pending':
      return 'Edits are waiting to be saved.';
    case 'outside':
      return 'Some files were changed outside the app.';
    case 'rebase':
      return 'Getting their saves stopped part way.';
    case 'merge':
      return 'A merge stopped part way.';
    case 'revert':
      return 'Undoing a save stopped part way.';
    default:
      return cause;
  }
}
