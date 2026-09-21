/**
 * The project's history as commands: the reads the History pane draws from. Every one is a
 * thin wrapper over a `WorkspaceSession` method, and none takes the busy flag, since a read
 * cannot disturb a run or an agent turn.
 */
import { defineFor, prop } from '@vn/commands';
import { REPO_ROLES } from '../../shared/history.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

const WHO = ['', 'author', 'agent', 'pipeline', 'housekeeping', 'other', 'unknown'] as const;

const repoProp = () =>
  prop.oneOf(REPO_ROLES, 'which of the project’s repositories', { default: 'project' });

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
