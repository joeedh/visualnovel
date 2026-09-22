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

// -----------------------------------------------------------------------------
// Sync
// -----------------------------------------------------------------------------

const remoteProp = () =>
  prop.string('the shared copy, by name; empty for the one the branch syncs with', {
    default: '',
  });

export const gitAddRemote = define({
  id         : 'git.addRemote',
  title      : 'Connect a shared copy',
  description:
    'Connect a copy of this repository somewhere else — on GitHub, a NAS, a USB drive — under a ' +
    'name of your choosing. The first copy connected becomes the one the project syncs with. ' +
    'Nothing is sent yet; the app never creates the copy, and it holds no token: your own git ' +
    'credential helper answers the first send.',
  notes:
    '`remote add`, then `branch.<b>.remote`/`.merge` when the branch had no upstream. The address must be `https://`, `git@host:` or an absolute path; the name a refname component git accepts.',
  mutating   : true,
  affects    : [GIT_ROOT],
  props: {
    repo: repoProp(),
    name: prop.string('what to call the copy; `origin` is the usual first name'),
    url : prop.string('where it is: an https address, git@host:path, or a folder'),
  },
  check      : ({ repo, name, url }, ctx) => ctx.host.session.previewAddRemote(repo, name, url),
  async run({ repo, name, url }, ctx) {
    const added = await ctx.host.session.gitAddRemote(repo, name, url);
    return {
      message: added.syncsWith
        ? `Connected “${name.trim()}”; the project now syncs with it.`
        : `Connected “${name.trim()}”.`,
      data   : added,
    };
  },
});

export const gitRemoveRemote = define({
  id         : 'git.removeRemote',
  title      : 'Forget a shared copy',
  description:
    'Forget a shared copy’s name and address. Nothing in this project is removed, and the copy ' +
    'itself is untouched; it can be connected again later.',
  notes:
    '`remote remove`, which drops the tracking refs too. Confirmed, since the counts against that copy are lost.',
  mutating   : true,
  affects    : [GIT_ROOT],
  confirm    : true,
  props      : { repo: repoProp(), name: prop.string('the shared copy, by name') },
  check      : ({ repo, name }, ctx) => ctx.host.session.previewRemoveRemote(repo, name),
  async run({ repo, name }, ctx) {
    const removed = await ctx.host.session.gitRemoveRemote(repo, name);
    return { message: `Forgot “${removed.remote}”; nothing in the project changed.` };
  },
});

export const gitSetRemoteUrl = define({
  id         : 'git.setRemoteUrl',
  title      : 'Change a shared copy’s address',
  description:
    'Point a shared copy’s name at a different address, when the repository moved or the ' +
    'address was mistyped. Refused for an address that is not https://, git@ or a folder.',
  notes      : '`remote set-url`. The same address test as `git.addRemote`.',
  mutating   : true,
  affects    : [GIT_ROOT],
  props: {
    repo: repoProp(),
    name: prop.string('the shared copy, by name'),
    url : prop.string('where it is now: an https address, git@host:path, or a folder'),
  },
  check      : ({ repo, name, url }, ctx) => ctx.host.session.previewSetRemoteUrl(repo, name, url),
  async run({ repo, name, url }, ctx) {
    const changed = await ctx.host.session.gitSetRemoteUrl(repo, name, url);
    return { message: `“${changed.remote}” is now at ${url.trim()}.` };
  },
});

export const gitSyncWith = define({
  id         : 'git.syncWith',
  title      : 'Sync with this copy',
  description:
    'Make one shared copy the one the project gets saves from. Sending is offered per copy ' +
    'either way; this chooses where “Get their saves” looks. Refused while not on a branch.',
  notes:
    'Writes `branch.<current>.remote` and `branch.<current>.merge`, where git itself keeps the answer, so a terminal `git pull` agrees.',
  mutating   : true,
  affects    : [GIT_ROOT],
  props      : { repo: repoProp(), name: prop.string('the shared copy, by name') },
  check      : ({ repo, name }, ctx) => ctx.host.session.previewSyncWith(repo, name),
  async run({ repo, name }, ctx) {
    const set = await ctx.host.session.gitSyncWith(repo, name);
    return { message: `${set.branch} now syncs with “${set.remote}”.` };
  },
});

export const gitFetch = define({
  id         : 'git.fetch',
  title      : 'Check a shared copy',
  description:
    'Ask a shared copy what it has, so the counts of saves to send and to get are current. ' +
    'Nothing in the project changes; getting their saves is a separate act.',
  notes      : '`fetch --tags <remote>`. The one network verb that moves nothing on the branch.',
  mutating   : true,
  affects    : [GIT_ROOT],
  props      : { repo: repoProp(), remote: remoteProp() },
  check      : ({ repo, remote }, ctx) => ctx.host.session.previewFetch(repo, remote),
  async run({ repo, remote }, ctx) {
    const fetched = await ctx.host.session.gitFetch(repo, remote);
    const behind = fetched.behind;
    return {
      message:
        behind === null
          ? `Checked “${fetched.remote}”; it has no copy of this branch yet.`
          : behind === 0
            ? `Checked “${fetched.remote}”; nothing new there.`
            : `Checked “${fetched.remote}”; ${behind} save${behind === 1 ? '' : 's'} to get.`,
      data   : fetched,
    };
  },
});

/** What `git.pull` and `git.continueSync` say once the rebase has stopped or completed. */
function syncMessage(outcome: {
  got: number;
  replayed: number;
  conflicted: string[];
  finished: boolean;
  note?: string;
}): string {
  if (outcome.note !== undefined) return outcome.note;
  const n = outcome.conflicted.length;
  if (n > 0) return `${n} file${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a decision.`;
  if (!outcome.finished)
    return 'Getting their saves stopped part way; the History pane says where.';
  const got =
    outcome.got > 0
      ? `Got ${outcome.got} save${outcome.got === 1 ? '' : 's'} from the shared copy`
      : 'Finished getting their saves';
  const replayed = outcome.replayed;
  return replayed > 0 ? `${got}; ${replayed} of yours replayed on top.` : `${got}.`;
}

export const gitPull = define({
  id           : 'git.pull',
  title        : 'Get their saves',
  description:
    'Get the saves a collaborator sent to the shared copy and put yours on top of them, so the ' +
    'history stays one line. A file both of you changed waits for your decision in the History ' +
    'pane. Refused while edits are unsaved, while a sync is part way, and with no copy to sync with.',
  notes:
    '`fetch` then `rebase <remote>/<branch>`. `commitsItself`: the rebase moves the branch and the committer has nothing to add. A stopped rebase returns normally, since that state is the conflict view’s; a completed one records `rewrote`, old sha to new, paired by author, date and message, and re-points checkpoints through it.',
  mutating     : true,
  affects      : [...ANY_DOCUMENT, GIT_ROOT],
  commitsItself: true,
  props        : { repo: repoProp() },
  check        : ({ repo }, ctx) => ctx.host.session.previewPull(repo),
  async run({ repo }, ctx) {
    const outcome = await ctx.host.session.gitPull(repo);
    return {
      message: syncMessage(outcome),
      data   : outcome,
      ...(outcome.rewrote.length > 0 ? { rewrote: outcome.rewrote } : {}),
    };
  },
});

export const gitPush = define({
  id         : 'git.push',
  title      : 'Send my saves',
  description:
    'Send every save the shared copy lacks, checkpoints included. Refused while there is nothing ' +
    'to send, while the copy has saves you have not got yet — get theirs first — and while a ' +
    'sync is part way. A copy that refuses answers in its own words.',
  notes:
    '`push --follow-tags <remote> <branch>`; never forces. The project is also refused while a nested story bible has unsent saves, so its gitlink never names a save the copy lacks.',
  mutating   : true,
  affects    : [GIT_ROOT],
  props      : { repo: repoProp(), remote: remoteProp() },
  check      : ({ repo, remote }, ctx) => ctx.host.session.previewPush(repo, remote),
  async run({ repo, remote }, ctx) {
    const sent = await ctx.host.session.gitPush(repo, remote);
    return {
      message:
        sent.sent === null
          ? `Sent my saves to “${sent.remote}”.`
          : `Sent ${sent.sent} save${sent.sent === 1 ? '' : 's'} to “${sent.remote}”.`,
      data   : sent,
    };
  },
});

export const gitResolve = define({
  id           : 'git.resolve',
  title        : 'Keep one side of a collision',
  description:
    'Decide one file both of you changed: keep yours, or take theirs. Refused when no sync is ' +
    'waiting on a decision, and for a file that is not in question.',
  notes:
    '`checkout --ours|--theirs` then `add`, in git’s inverted words for a rebase: “mine” is git’s `theirs`. A side that deleted the file deletes it. `commitsItself`, since a rebase is in progress and the committer must not run.',
  mutating     : true,
  affects      : [...ANY_DOCUMENT, GIT_ROOT],
  commitsItself: true,
  props: {
    repo: repoProp(),
    path: prop.string('the file, as that repository names it'),
    side: prop.oneOf(['mine', 'theirs'] as const, 'whose version to keep'),
  },
  check        : ({ repo, path, side }, ctx) => ctx.host.session.previewResolve(repo, path, side),
  async run({ repo, path, side }, ctx) {
    const { written } = await ctx.host.session.gitResolve(repo, path, side);
    return {
      message: side === 'mine' ? `Kept your ${path}.` : `Took their ${path}.`,
      written,
    };
  },
});

export const gitContinueSync = define({
  id           : 'git.continueSync',
  title        : 'Continue getting their saves',
  description:
    'Carry on once every file in question is decided. The next of your saves is replayed, and ' +
    'may wait on decisions of its own. Refused while a file is undecided, and while a scene ' +
    'still holds conflict markers, which the Script pane could not read.',
  notes:
    '`add -A` then `rebase --continue`, so edits made while the conflict view was up ride into the replayed save. `commitsItself`. A completed rebase records `rewrote` the way `git.pull` does.',
  mutating     : true,
  affects      : [...ANY_DOCUMENT, GIT_ROOT],
  commitsItself: true,
  props        : { repo: repoProp() },
  check        : ({ repo }, ctx) => ctx.host.session.previewContinueSync(repo),
  async run({ repo }, ctx) {
    const outcome = await ctx.host.session.gitContinueSync(repo);
    return {
      message: syncMessage(outcome),
      data   : outcome,
      ...(outcome.rewrote.length > 0 ? { rewrote: outcome.rewrote } : {}),
    };
  },
});

export const gitAbandonSync = define({
  id           : 'git.abandonSync',
  title        : 'Give up getting their saves',
  description:
    'Stop a sync that is part way and put your saves back exactly as they were. Nothing is lost ' +
    'and nothing is sent; their saves stay at the shared copy for another try. Also gives up a ' +
    'merge or a take-back that a terminal left unfinished.',
  notes:
    '`rebase --abort`, `merge --abort` or `revert --abort`, whichever is in progress. `commitsItself`.',
  mutating     : true,
  affects      : [...ANY_DOCUMENT, GIT_ROOT],
  commitsItself: true,
  confirm      : true,
  props        : { repo: repoProp() },
  check        : ({ repo }, ctx) => ctx.host.session.previewAbandonSync(repo),
  async run({ repo }, ctx) {
    const { operation } = await ctx.host.session.gitAbandonSync(repo);
    return {
      message:
        operation === 'rebase'
          ? 'Gave up getting their saves; yours are back as they were.'
          : `Gave up the ${operation}; every file is back as it was.`,
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
