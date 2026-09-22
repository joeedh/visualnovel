/**
 * What the History pane offers and says: the repository chooser, the four filters, reload, the
 * rows, paging, the recovery controls, the sync view's and the conflict view's controls, and the
 * sentences the strip, the status line, the footer and the empty states carry. Pure over what
 * `git.repos`, `git.status` and `git.history` answered, and over the verdicts `check` gave the
 * recovery and sync commands, so the derived model and the pane draw from one place.
 */
import {
  decisionSentence,
  kindOf,
  NO_UPSTREAM,
  NOT_OWNED,
  SYNC_UNFINISHED,
  UNSAVED_EDITS,
  type DecidedFile,
  type Maker,
  type RemoteEntry,
  type RepoEntry,
  type RepoRole,
  type RepoStatus,
  type Save,
} from '../../src/shared/history.js';
import { refuse, type Offer } from './anchors.js';
import { view } from './effects.js';

/** The who filter's choices, in the order the menu lists them. `''` is everyone. */
export const WHO_ROWS: readonly { id: Maker | ''; label: string; tooltip: string }[] = [
  { id: '', label: 'Everyone', tooltip: 'Show every save, whoever made it.' },
  { id: 'author', label: 'Me', tooltip: 'Only the saves you made in the app.' },
  { id: 'agent', label: 'Agent', tooltip: 'Only the saves the agent made in its turns.' },
  { id: 'pipeline', label: 'Pipeline', tooltip: 'Only the saves a pipeline run or a render made.' },
  {
    id     : 'housekeeping',
    label  : 'Housekeeping',
    tooltip: 'Only the app’s own saves: setting a project up, and recording edits made outside it.',
  },
  { id: 'other', label: 'Someone else', tooltip: 'Only the saves a collaborator made.' },
];

/** What the pane calls a maker, in a row's badge and the detail header. */
export const MAKER_SAYS: Record<Maker, string> = {
  author      : 'You',
  agent       : 'Agent',
  pipeline    : 'Pipeline',
  housekeeping: 'Housekeeping',
  other       : 'Someone else',
  unknown     : 'Made outside the app',
};

/** What the strip calls each repository. */
export const ROLE_SAYS: Record<RepoRole, string> = {
  project: 'Project',
  wiki   : 'Story bible',
  base   : 'Base art',
};

/** The pane's filters, all pane-local. */
export interface HistoryFilter {
  who: Maker | '';
  /** A workspace-relative path; empty for every file. */
  path: string;
  text: string;
  checkpointsOnly: boolean;
}

export const NO_FILTER: HistoryFilter = { who: '', path: '', text: '', checkpointsOnly: false };

/** Whether any filter narrows the list. */
export function filtering(filter: HistoryFilter): boolean {
  return filter.who !== '' || filter.path !== '' || filter.text !== '' || filter.checkpointsOnly;
}

/** What the History pane reads when it draws. */
export interface HistoryState {
  /** What `git.repos` answered; empty before it has, or when the project has no repository. */
  repos: readonly RepoEntry[];
  repo: RepoRole;
  filter: HistoryFilter;
  status?: RepoStatus;
  /** The rows on screen, after the checkpoint filter. */
  saves: readonly Save[];
  /** The sha the next page starts after; null once the history ended. */
  next: string | null;
  selected?: string;
  /** The file of the selected save whose diff is open, if one is. */
  file?: string;
  /** Whether the selected save's logs are listed rather than folded behind their count. */
  logsOpen: boolean;
  /**
   * The pane's width class. `small` is one column, where the detail replaces the list; `mid`
   * is two, where a diff replaces the file list; `large` is two with the diff beneath the files.
   */
  size: PaneSize;
  /** Whether the pane is showing the detail in the list's place, in the small layout. */
  showingDetail: boolean;
  /**
   * What `check` answered for the recovery and sync commands, by key, on the selected save, the
   * open file and the branch. One not yet answered is absent, and its control is drawn as if
   * accepted, since the command's own check runs again on the click.
   */
  verdicts: Readonly<Partial<Record<VerdictKey, Verdict>>>;
  /**
   * What the last command run from this pane did to undo: the invocation of a take-back or a
   * go-back, after which the undo history from before no longer applies; empty otherwise.
   */
  undoBlocked?: string;
  /** Whether the sync view has the detail column, in the change view's place. */
  syncOpen: boolean;
  /** The network verb still running, while one is. */
  syncing?: SyncVerb;
  /** The conflicted path whose whole file is open for editing, markers and all, in the conflict view. */
  editing?: string;
}

export type PaneSize = 'small' | 'mid' | 'large';

/** The commands the pane asks `check` about before it draws their controls. */
export type RecoveryId = 'git.takeBack' | 'git.goBack' | 'git.restoreFile';

/** The sync commands the pane asks `check` about; a push is asked per shared copy. */
export type SyncId = 'git.pull' | 'git.continueSync';

/** How a verdict is filed: by command id, or by id and remote for a push. */
export type VerdictKey = RecoveryId | SyncId | `git.push:${string}`;

/** The three verbs that reach a shared copy and can take seconds. */
export type SyncVerb = 'pull' | 'push' | 'fetch';

/** What the footer says while each verb runs, before the elapsed time. */
export const SYNC_SAYS: Record<SyncVerb, string> = {
  pull : 'Getting their saves',
  push : 'Sending my saves',
  fetch: 'Checking the shared copy',
};

/** One command's verdict as `check` gave it: the note when accepted, the reason when refused. */
export interface Verdict {
  ok: boolean;
  message: string;
}

/**
 * The file in a save's list that holds its conversation, when the save is an agent's turn. The
 * native log beside it is `<id>.native.jsonl`, which the dot in the id's place keeps out.
 */
const THREAD_LOG = /^vngen\/state\/threads\/([^/.]+)\.jsonl$/;

/**
 * The conversation an agent's save belongs to: the `Vn-Thread` trailer the agent's own commit
 * carries, or for a turn's commit from before it did, the transcript the turn appended to.
 */
export function threadOf(save: Save): string | undefined {
  if (save.maker !== 'agent') return undefined;
  const thread = save.trailers['Vn-Thread'];
  if (thread !== undefined && thread !== '') return thread;
  for (const file of save.files) {
    const match = THREAD_LOG.exec(file.path);
    if (match) return match[1];
  }
  return undefined;
}

/** Whether a save changed nothing an author edits, only the app's logs. */
export function onlyLogs(save: Save): boolean {
  return save.files.length > 0 && save.files.every((f) => kindOf(f.path) === 'log');
}

/**
 * What the app ran to make this save, from the commit's trailers: the invocation for one act, the
 * count and the commands for a batch, and nothing for a save the app did not make.
 */
export function ranSentence(save: Save): string {
  const invocation = save.trailers['Vn-Invocation'];
  if (invocation !== undefined) return invocation;
  const batch = save.trailers['Vn-Batch'];
  const commands = save.trailers['Vn-Command'];
  if (batch === undefined || commands === undefined) return commands ?? '';
  const n = batch.split(' ')[0] ?? '';
  return `${n} acts: ${commands}`;
}

/** Whether the repository the pane is on is one the app writes history in. */
export function ownedRepo(state: HistoryState): boolean {
  return state.repos.find((r) => r.role === state.repo)?.owned ?? false;
}

/**
 * Which repository holds a workspace-relative path, and the path as that repository spells it.
 * A story bible that is a repository of its own (a submodule, or a nested clone) has its own
 * history, and asking the project for `wiki/houses.md` would answer with nothing. The longest
 * owned root under the project's wins; a path under none of them is the project's.
 */
export function resolvePath(
  repos: readonly RepoEntry[],
  path: string,
): { repo: RepoRole; path: string } {
  const project = repos.find((r) => r.role === 'project');
  if (!project || path === '') return { repo: 'project', path };
  const base = slashed(project.root);
  let best: { repo: RepoRole; prefix: string } | undefined;
  for (const entry of repos) {
    if (entry.role === 'project' || !entry.owned) continue;
    const root = slashed(entry.root);
    if (!root.startsWith(`${base}/`)) continue;
    const prefix = root.slice(base.length + 1);
    if (path !== prefix && !path.startsWith(`${prefix}/`)) continue;
    if (best === undefined || prefix.length > best.prefix.length)
      best = { repo: entry.role, prefix };
  }
  if (best === undefined) return { repo: 'project', path };
  return { repo: best.repo, path: path.slice(best.prefix.length + 1) };
}

/** Forward slashes and no trailing one, so two spellings of a root compare equal. */
function slashed(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * One segment of the repository chooser. Drawn only with more than one repository, since a
 * project with one has nothing to choose; the current one is offered too, so the control reads
 * as a set rather than as the other options.
 */
export function repoAction(entry: RepoEntry, current: RepoRole): Offer {
  return {
    ok: true,
    ...view('scope'),
    on     : `repo/${entry.role}`,
    label  : ROLE_SAYS[entry.role],
    tooltip:
      entry.role === current
        ? `The list is showing the ${ROLE_SAYS[entry.role].toLowerCase()} repository at ${entry.root}.`
        : `Show the ${ROLE_SAYS[entry.role].toLowerCase()} repository’s saves instead, at ${entry.root}.`,
  };
}

/** The who menu's button. Each row narrows the list to one maker. */
export function whoAction(who: Maker | ''): Offer {
  const row = WHO_ROWS.find((r) => r.id === who) ?? WHO_ROWS[0]!;
  return {
    ok: true,
    ...view('filter'),
    on     : 'who',
    label  : row.label,
    tooltip:
      'Narrow the list to the saves one kind of maker made: you, the agent, the pipeline, or the app’s housekeeping.',
  };
}

/** The file filter: a chip naming the path the list is narrowed to, whose click clears it. */
export function pathAction(path: string): Offer {
  const control = { ...view('filter'), on: 'path', label: path || 'Any file' };
  if (path === '') {
    return {
      ...refuse('The list is not narrowed to a file.'),
      ...control,
      tooltip:
        'Right-click a file or a scene in the document tree and choose Show history to narrow the list to it.',
    };
  }
  return {
    ok: true,
    ...control,
    tooltip: `The list shows only the saves that touched ${path}. Click to show every file again.`,
  };
}

/** The checkpoints tick. */
export function checkpointsAction(on: boolean): Offer {
  return {
    ok: true,
    ...view('filter'),
    on     : 'checkpoints',
    label  : 'Checkpoints',
    tooltip: on
      ? 'Show every save again, not only the ones with a checkpoint.'
      : 'Show only the saves you named as a checkpoint.',
  };
}

/** The search box. What is typed narrows the list to saves whose message contains it. */
export function searchBox(text: string): Offer {
  return {
    ok: true,
    ...view('filter'),
    on     : 'text',
    label  : text || 'Search saves…',
    tooltip: 'Narrow the list to the saves whose description contains these words.',
  };
}

/** Clear every filter. Refused while nothing is narrowed, with the reason. */
export function clearAction(filter: HistoryFilter): Offer {
  const control = { ...view('filter'), on: 'clear', label: 'Show all' };
  if (!filtering(filter)) {
    return {
      ...refuse('Nothing narrows the list.'),
      ...control,
      tooltip: 'Take every filter off and show every save.',
    };
  }
  return { ok: true, ...control, tooltip: 'Take every filter off and show every save.' };
}

export function reloadAction(): Offer {
  return {
    ok: true,
    ...view('reload'),
    on     : 'reload',
    label  : '⟳',
    tooltip: 'Read the saves again, in case something changed outside the app.',
  };
}

/** The page control at the foot of the list. Refused once the history has ended. */
export function moreAction(next: string | null): Offer {
  const control = { ...view('page'), on: 'more', label: 'Earlier saves' };
  if (next === null) {
    return {
      ...refuse('Every save is listed.'),
      ...control,
      tooltip: 'Read the next fifty saves.',
    };
  }
  return {
    ok: true,
    ...control,
    tooltip: 'Read the next fifty saves, from before the last one listed.',
  };
}

/** One row of the list. Clicking it shows what the save changed. */
export function rowAction(save: Save, selected: boolean): Offer {
  const files = save.files.length;
  return {
    ok: true,
    ...view('scope'),
    on     : `save/${save.sha}`,
    label  : save.subject,
    tooltip: selected
      ? `Showing this save. ${MAKER_SAYS[save.maker]} · ${files} file${files === 1 ? '' : 's'} · ${save.sha.slice(0, 7)}`
      : `Show what this save changed. ${MAKER_SAYS[save.maker]} · ${files} file${files === 1 ? '' : 's'} · ${save.sha.slice(0, 7)}`,
  };
}

/** The narrow layout's way back from the detail to the list. */
export function backAction(): Offer {
  return {
    ok: true,
    ...view('mode'),
    on     : 'back',
    label  : '← History',
    tooltip: 'Go back to the list of saves.',
  };
}

/** One file of the selected save. Clicking it shows how the save changed it. */
export function fileAction(path: string, open: boolean): Offer {
  return {
    ok: true,
    ...view('scope'),
    on     : `file/${path}`,
    label  : path,
    tooltip: open
      ? `Showing how this save changed ${path}.`
      : `Show how this save changed ${path}.`,
  };
}

/**
 * The fold on a save's logs: the count while folded, the same row to fold them again. `alone` is
 * the save that touched nothing else, where the fold is a button under a sentence instead of a
 * heading in a list.
 */
export function logsAction(open: boolean, count: number, alone = false): Offer {
  return {
    ok: true,
    ...view('mode'),
    on     : 'logs',
    label  : alone ? 'Show logs' : open ? 'Logs' : `Logs (${count})`,
    tooltip: open
      ? 'Fold the app’s own logs away again.'
      : `List the ${count} log file${count === 1 ? '' : 's'} this save also touched: the command log, the task log, and a conversation’s transcript.`,
  };
}

/** The way back from a diff to the file list, where the diff took the list's place. */
export function filesBackAction(): Offer {
  return {
    ok: true,
    ...view('mode'),
    on     : 'files',
    label  : '← Files',
    tooltip: 'Go back to the list of files this save changed.',
  };
}

/**
 * Open the conversation an agent's save came from, read-only, in the Convo pane. Refused on any
 * other save, since only an agent's turn has one.
 */
export function conversationAction(thread: string | undefined): Offer {
  const control = { id: 'agent.openThread', label: 'Open the conversation' };
  if (thread === undefined) {
    return {
      ...refuse('This save did not come from a conversation.'),
      ...control,
      tooltip: 'Replay the conversation this save came from, read-only, in the Convo pane.',
    };
  }
  return {
    ok: true,
    ...control,
    props  : { id: thread },
    on     : thread,
    tooltip: 'Replay the conversation this save came from, read-only, in the Convo pane.',
    then   : [{ id: 'view.open', props: { editor: 'convo', where: 'elsewhere' } }],
  };
}

// -----------------------------------------------------------------------------
// Recovery
// -----------------------------------------------------------------------------

/** What every recovery control says over a repository the app does not write history in. */
const notOwned = (state: HistoryState) => (ownedRepo(state) ? undefined : NOT_OWNED);

/** Whether a rebase, merge or revert is in progress, as the sentence the commands refuse with. */
function unfinished(status: RepoStatus | undefined): string | undefined {
  const cause = status?.cause;
  return cause === 'rebase' || cause === 'merge' || cause === 'revert'
    ? SYNC_UNFINISHED
    : undefined;
}

/**
 * The status view's button for the files changed outside the app. Opens `git.save`'s own form,
 * where the message is typed. Refused with the reason while there is nothing of the kind to
 * save: edits the app is saving itself are not the author's to name.
 */
export function saveAction(state: HistoryState): Offer {
  const control = {
    id     : 'git.save',
    label  : 'Save these…',
    form   : true,
    tooltip: 'Save the files changed outside the app as one save, under a message you type.',
  };
  const why =
    stillSyncing(state) ??
    notOwned(state) ??
    unfinished(state.status) ??
    (state.status?.cause === 'pending'
      ? 'The app is saving these edits itself.'
      : state.status?.cause === 'outside'
        ? undefined
        : 'Nothing has changed since the last save.');
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo } };
}

/**
 * The bar's checkpoint button. Names the selected save, or the latest with none selected, in
 * `git.checkpoint`'s own form, where the name and the note are typed.
 */
export function checkpointAction(state: HistoryState): Offer {
  const selected = state.saves.find((s) => s.sha === state.selected);
  const control = {
    id     : 'git.checkpoint',
    label  : '⚑ Checkpoint…',
    form   : true,
    tooltip: selected
      ? 'Name the selected save as a checkpoint, so it can be found and gone back to later.'
      : 'Name the latest save as a checkpoint, so it can be found and gone back to later.',
  };
  const why =
    stillSyncing(state) ??
    notOwned(state) ??
    (state.saves.length === 0 ? 'There is no save to name yet.' : undefined);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, sha: selected?.sha ?? '' } };
}

/** The button under a checkpoint's flag in the detail header, which takes the name off. */
export function dropCheckpointAction(state: HistoryState, name: string): Offer {
  const control = {
    id     : 'git.dropCheckpoint',
    on     : name,
    label  : `Drop checkpoint “${name}”`,
    tooltip: 'Take this name off the save. The save itself stays in history.',
  };
  const why = notOwned(state);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, name } };
}

/**
 * The detail header's Take back this save, which reverses the selected save as a new save.
 * Refused with the check's own reason, which names the later saves that stand in the way; the
 * click opens the command's form, where the check's note is read before the run.
 */
export function takeBackAction(state: HistoryState, save: Save): Offer {
  const control = {
    id     : 'git.takeBack',
    label  : 'Take back this save',
    form   : true,
    tooltip:
      'Reverse what this save did, as a new save. Nothing in history is deleted, and the undo history from before no longer applies.',
  };
  const why =
    stillSyncing(state) ??
    notOwned(state) ??
    unfinished(state.status) ??
    refusedBy(state, 'git.takeBack');
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, sha: save.sha } };
}

/** The detail header's Go back to here, which puts every file back to how it was at the save. */
export function goBackAction(state: HistoryState, save: Save): Offer {
  const control = {
    id     : 'git.goBack',
    label  : 'Go back to here',
    form   : true,
    tooltip:
      'Put every file back to how it was at this save, as a new save. Nothing in history is deleted, and the undo history from before no longer applies.',
  };
  const why =
    stillSyncing(state) ??
    notOwned(state) ??
    unfinished(state.status) ??
    refusedBy(state, 'git.goBack');
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, sha: save.sha } };
}

/**
 * The diff bar's Bring back this file, which rewrites the open file as it was at the selected
 * save. An ordinary document write, so undo reverses it.
 */
export function restoreFileAction(state: HistoryState, save: Save, path: string): Offer {
  const control = {
    id     : 'git.restoreFile',
    label  : 'Bring back this file',
    tooltip: `Rewrite ${path} as it was at this save. Undo reverses it.`,
  };
  const why = stillSyncing(state) ?? notOwned(state) ?? refusedBy(state, 'git.restoreFile');
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, sha: save.sha, path } };
}

/** The check's reason for refusing `key`, or undefined while it accepted or has not answered. */
function refusedBy(state: HistoryState, key: VerdictKey): string | undefined {
  const verdict = state.verdicts[key];
  return verdict !== undefined && !verdict.ok ? verdict.message : undefined;
}

/** What every write says while a network verb is still running. */
function stillSyncing(state: HistoryState): string | undefined {
  return state.syncing === undefined
    ? undefined
    : `Still ${SYNC_SAYS[state.syncing].toLowerCase()}.`;
}

// -----------------------------------------------------------------------------
// Sync
// -----------------------------------------------------------------------------

/** The strip's control that opens the sync view in the detail column, and closes it again. */
export function syncViewAction(state: HistoryState): Offer {
  const control = { ...view('mode'), on: 'sync' };
  if (conflicting(state)) {
    return {
      ...refuse('The files in question have this column until they are decided.'),
      ...control,
      label  : 'Shared copies',
      tooltip: 'List the shared copies: what each has, and send or get saves.',
    };
  }
  if (state.syncOpen) {
    return {
      ok: true,
      ...control,
      label  : 'Close',
      tooltip: 'Put the selected save’s changes back in this column.',
    };
  }
  const remotes = state.status?.remotes.length ?? 0;
  return {
    ok: true,
    ...control,
    label  : 'Shared copies',
    tooltip:
      remotes === 0
        ? 'Connect a copy of this repository somewhere else, to work with someone or to keep a backup.'
        : `List the ${remotes === 1 ? 'shared copy' : `${remotes} shared copies`}: what each has, and send or get saves.`,
  };
}

/**
 * Get their saves, from the copy the branch syncs with. Refused while nothing is set to sync
 * with, while edits are unsaved, while a sync is part way, and with the check's own reason.
 */
export function pullAction(state: HistoryState): Offer {
  const control = {
    id     : 'git.pull',
    label  : 'Get their saves',
    tooltip:
      'Get the saves sent to the shared copy and put yours on top. A file both of you changed waits here for your decision.',
  };
  const why =
    stillSyncing(state) ??
    notOwned(state) ??
    unfinished(state.status) ??
    (state.status?.upstream === null ? NO_UPSTREAM : undefined) ??
    (state.status?.cause === 'outside' ? UNSAVED_EDITS : undefined) ??
    refusedBy(state, 'git.pull');
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo } };
}

/**
 * Send my saves to one shared copy. Refused while the copy has every save, while it has saves not
 * yet got, and with the check's own reason, which is git's when the copy refused.
 */
export function pushAction(state: HistoryState, remote: RemoteEntry): Offer {
  const control = {
    id     : 'git.push',
    on     : remote.name,
    label  : 'Send my saves',
    tooltip: `Send every save “${remote.name}” lacks, checkpoints included.`,
  };
  const why =
    stillSyncing(state) ??
    notOwned(state) ??
    unfinished(state.status) ??
    (remote.behind !== null && remote.behind > 0
      ? `“${remote.name}” has ${remote.behind} save${remote.behind === 1 ? '' : 's'} you do not; get their saves first.`
      : undefined) ??
    (remote.ahead === 0 ? `Nothing to send; “${remote.name}” has every save.` : undefined) ??
    refusedBy(state, `git.push:${remote.name}`);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, remote: remote.name } };
}

/** Ask one shared copy what it has, so its counts are current. Changes nothing here. */
export function fetchAction(state: HistoryState, remote: RemoteEntry): Offer {
  const control = {
    id     : 'git.fetch',
    on     : remote.name,
    label  : 'Check',
    tooltip: `Ask “${remote.name}” what it has, so the counts are current. Nothing here changes.`,
  };
  const why = stillSyncing(state) ?? notOwned(state);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, remote: remote.name } };
}

/** Make one shared copy the one the branch gets saves from. Refused on the one it already is. */
export function syncWithAction(state: HistoryState, remote: RemoteEntry): Offer {
  const control = {
    id     : 'git.syncWith',
    on     : remote.name,
    label  : remote.syncsWith ? 'Syncing with this copy' : 'Sync with this copy',
    tooltip: `Get their saves from “${remote.name}” from now on. Sending is offered per copy either way.`,
  };
  const why =
    notOwned(state) ??
    (remote.syncsWith ? 'This is already the copy the project syncs with.' : undefined) ??
    (state.status?.branch === null ? 'Not on a branch; check one out first.' : undefined);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, name: remote.name } };
}

/** Change one shared copy's address, in `git.setRemoteUrl`'s own form. */
export function setRemoteUrlAction(state: HistoryState, remote: RemoteEntry): Offer {
  const control = {
    id     : 'git.setRemoteUrl',
    on     : remote.name,
    label  : 'Change address…',
    form   : true,
    tooltip: `Point “${remote.name}” at a different address, when the copy moved or this one was mistyped.`,
  };
  const why = notOwned(state);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, name: remote.name } };
}

/** Forget one shared copy, in `git.removeRemote`'s form, which is the confirmation. */
export function removeRemoteAction(state: HistoryState, remote: RemoteEntry): Offer {
  const control = {
    id     : 'git.removeRemote',
    on     : remote.name,
    label  : 'Remove',
    form   : true,
    tooltip: `Forget “${remote.name}”. Nothing in this project is removed, and the copy itself is untouched.`,
  };
  const why = notOwned(state);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, name: remote.name } };
}

/**
 * Connect a shared copy, in `git.addRemote`'s form. The first one connected becomes the copy the
 * project syncs with, and the empty sync view leads with this.
 */
export function addRemoteAction(state: HistoryState): Offer {
  const first = (state.status?.remotes.length ?? 0) === 0;
  const control = {
    id     : 'git.addRemote',
    label  : first ? 'Connect a shared copy…' : 'Add a shared copy…',
    form   : true,
    tooltip: first
      ? 'Connect a copy of this repository somewhere else, under a name and an address. It becomes the copy the project syncs with.'
      : 'Connect another copy of this repository, on a NAS or a drive, say, as a backup.',
  };
  const why = notOwned(state);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, name: first ? 'origin' : '' } };
}

/** What the sync view says when there is nothing to list. */
export const NO_REMOTES = 'No shared copy yet. Connect one to work with someone else.';

// -----------------------------------------------------------------------------
// Conflicts
// -----------------------------------------------------------------------------

/** Whether the detail column shows the conflict view: a sync stopped part way, with decisions to make. */
export function conflicting(state: HistoryState): boolean {
  const cause = state.status?.cause;
  return cause === 'rebase' || cause === 'merge';
}

/** The status view's control for a stopped sync, which brings the conflict view to the front. */
export function conflictsAction(): Offer {
  return {
    ok: true,
    ...view('mode'),
    on     : 'conflicts',
    label  : 'Decide…',
    tooltip: 'Show the files waiting on a decision, and continue or give up getting their saves.',
  };
}

/** "Replaying 2 of 3: Moved line L4 into rooftop", or the merge's own sentence. */
export function replayingSentence(status: RepoStatus | undefined): string {
  if (!status) return '';
  if (status.cause === 'merge') return 'A merge started outside the app is unfinished';
  const r = status.replaying;
  if (!r) return 'Getting their saves is unfinished';
  return `Replaying ${r.current} of ${r.total}: ${r.subject}`;
}

/** The conflict view's footer line: an edit made during a stopped rebase lands in the replayed save. */
export const REPLAYING_NOTE = 'Edits you make now become part of the save being replayed.';

/** What the conflict view adds beneath the footer while a file is open for editing. */
export const EDITING_NOTE = 'Saving decides this file; Undo decision brings the markers back.';

/** What a control on a file that was not merged line by line says instead of offering a merge. */
export const NO_MIDDLE = 'This file was not merged line by line; keep one side or the other.';

/** "2 of 3 decided", or the sentence for none left, for the conflict view's heading. */
export function decidedSentence(status: RepoStatus | undefined): string {
  const left = status?.conflicted.length ?? 0;
  const done = status?.decided.length ?? 0;
  const total = left + done;
  if (left === 0) return 'Every file is decided.';
  if (done === 0)
    return `${total} file${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} a decision.`;
  return `${done} of ${total} decided.`;
}

/**
 * How a decided row reads: the path, then "kept yours", "took theirs", "merged" or "removed".
 * Git's `ours` is the collaborator's side during a rebase, which `decisionSentence` translates.
 */
export function decidedLabel(file: DecidedFile): string {
  return decisionSentence(file.decision);
}

/** Keep one side of one file in question: yours, or theirs. */
export function resolveAction(state: HistoryState, path: string, side: 'mine' | 'theirs'): Offer {
  const control = {
    id     : 'git.resolve',
    on     : `${path}/${side}`,
    label  : side === 'mine' ? 'Keep mine' : 'Take theirs',
    tooltip:
      side === 'mine'
        ? `Keep your version of ${path} and drop theirs.`
        : `Take their version of ${path} and drop yours.`,
  };
  const why =
    stillSyncing(state) ??
    notOwned(state) ??
    (state.status?.cause !== 'rebase' ? 'No sync is waiting on a decision.' : undefined);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, path, side } };
}

/**
 * Open one file in question for editing, whole, with git's markers where the two versions
 * collided. Only for a file git merged line by line: a layout, a graph or a picture has no
 * middle to edit. While it is open, the row's control gives way to Save and Cancel beneath it.
 */
export function editAction(state: HistoryState, path: string): Offer {
  const control = {
    ...view('mode'),
    on     : `edit/${path}`,
    label  : 'Edit',
    tooltip: `Open ${path} as git left it, both versions between the markers, and merge them by hand.`,
  };
  const why =
    stillSyncing(state) ??
    (state.status?.cause !== 'rebase' ? 'No sync is waiting on a decision.' : undefined) ??
    (!state.status?.marked.includes(path) ? NO_MIDDLE : undefined) ??
    (state.editing === path ? 'Already open below; save or cancel it there.' : undefined);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control };
}

/** The editor's own field: the whole file, which Save reads at the click. */
export function resolveBox(path: string): Offer {
  return {
    ok      : true,
    id      : 'git.writeResolution',
    on      : `text/${path}`,
    label   : 'The file, as git left it',
    tooltip:
      'The whole file. Where both of you changed the same lines, theirs come first between <<<<<<< and =======, yours between ======= and >>>>>>>. Keep what you want and delete the marker lines.',
    supplies: ['text'],
    props   : { path },
  };
}

/** Write the editor's text over the file and mark it decided. The text is the box's at the click. */
export function saveResolutionAction(state: HistoryState, path: string): Offer {
  const control = {
    id      : 'git.writeResolution',
    on      : path,
    label   : 'Save',
    tooltip: `Write ${path} as it reads above and mark it decided. Markers left in prose are allowed until Continue.`,
    supplies: ['text'],
  };
  const why =
    stillSyncing(state) ??
    notOwned(state) ??
    (state.status?.cause !== 'rebase' ? 'No sync is waiting on a decision.' : undefined) ??
    (!state.status?.marked.includes(path) ? NO_MIDDLE : undefined);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, path } };
}

/** Close the editor without writing anything. */
export function cancelEditAction(path: string): Offer {
  return {
    ok: true,
    ...view('mode'),
    on     : `cancel/${path}`,
    label  : 'Cancel',
    tooltip: 'Close the editor and leave the file as git left it, still waiting on a decision.',
  };
}

/** Put a decided file back in question, whichever way it was decided. */
export function undoResolutionAction(state: HistoryState, file: DecidedFile): Offer {
  const control = {
    id     : 'git.undoResolution',
    on     : file.path,
    label  : 'Undo decision',
    tooltip: `Put ${file.path} back in question, with both versions and the markers back on disk.`,
  };
  const why =
    stillSyncing(state) ??
    notOwned(state) ??
    (state.status?.cause !== 'rebase' ? 'No sync is waiting on a decision.' : undefined) ??
    (file.decision === 'removed'
      ? 'The decision removed this file, and git cannot put a removed file back in question.'
      : undefined);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo, path: file.path } };
}

/** Continue getting their saves once every file is decided. Refused with the check's own reason. */
export function continueSyncAction(state: HistoryState): Offer {
  const control = {
    id     : 'git.continueSync',
    label  : 'Continue',
    tooltip:
      'Finish the save being replayed and go on to the next. Edits made while this view was up ride into it.',
  };
  const n = state.status?.conflicted.length ?? 0;
  const why =
    stillSyncing(state) ??
    notOwned(state) ??
    (state.status?.cause !== 'rebase' ? 'No sync is waiting on a decision.' : undefined) ??
    (n > 0
      ? `${n} file${n === 1 ? '' : 's'} still need${n === 1 ? 's' : ''} a decision.`
      : undefined) ??
    refusedBy(state, 'git.continueSync');
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo } };
}

/** Give up a sync, a merge or a take-back that is part way, in the command's confirming form. */
export function abandonSyncAction(state: HistoryState): Offer {
  const cause = state.status?.cause;
  const control = {
    id     : 'git.abandonSync',
    label  : 'Give up',
    form   : true,
    tooltip:
      cause === 'rebase'
        ? 'Stop getting their saves and put yours back exactly as they were. Their saves stay at the shared copy for another try.'
        : 'Abandon it and put every file back as it was.',
  };
  const why =
    stillSyncing(state) ??
    notOwned(state) ??
    (cause !== 'rebase' && cause !== 'merge' && cause !== 'revert'
      ? 'Nothing is part way through; there is nothing to give up.'
      : undefined);
  if (why !== undefined) return { ...refuse(why), ...control };
  return { ok: true, ...control, props: { repo: state.repo } };
}

// -----------------------------------------------------------------------------
// Sentences
// -----------------------------------------------------------------------------

/**
 * The strip's one line for a repository: role, branch, and where it stands against its copy.
 * A narrow pane keeps the branch and the counts and drops the copy's name.
 */
export function stripSentence(
  entry: RepoEntry | undefined,
  status: RepoStatus | undefined,
  narrow = false,
): string {
  if (!entry) return '';
  const parts = [ROLE_SAYS[entry.role]];
  if (!entry.owned) {
    parts.push(`inside ${entry.root}`, 'the app does not write history here');
    return parts.join(' · ');
  }
  if (!status) return parts.join(' · ');
  // A submodule checks out with no branch, and saving there needs one before anything else
  parts.push(status.branch ?? `not on a branch — check one out in ${entry.root} to save there`);
  if (status.upstream === null) parts.push('no shared copy yet');
  else {
    if (!narrow) parts.push(`shared copy ${status.upstream}`);
    // Mid-rebase HEAD is detached, so the counts are unknowable rather than unasked
    if (status.inProgress.rebase) parts.push('getting their saves');
    else if (status.ahead === null || status.behind === null) parts.push('not yet compared');
    else parts.push(`${status.ahead} to send`, `${status.behind} to get`);
  }
  return parts.join(' · ');
}

/** What the status line above the list says, or empty when the worktree is clean. */
export function statusSentence(status: RepoStatus | undefined): string {
  if (!status) return '';
  switch (status.cause) {
    case 'clean':
      return '';
    case 'pending':
      return `Saving ${status.pending} edit${status.pending === 1 ? '' : 's'}…`;
    case 'outside': {
      const n = status.outside.length;
      return `${n} file${n === 1 ? '' : 's'} changed outside the app`;
    }
    case 'rebase': {
      const n = status.conflicted.length;
      return n === 0
        ? 'Getting their saves is unfinished'
        : `Getting their saves: ${n} file${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a decision`;
    }
    case 'merge':
      return 'A merge started outside the app is unfinished';
    case 'revert':
      return 'Taking back a save stopped part way';
  }
}

/** What the footer's right side says about undo after a take-back or a go-back. */
export function undoSentence(state: HistoryState): string {
  return state.undoBlocked ? 'Undo history from before this save no longer applies.' : '';
}

/** What the footer says while a network verb runs: the verb and how long it has taken. */
export function syncSentence(verb: SyncVerb | undefined, seconds: number): string {
  return verb === undefined ? '' : `${SYNC_SAYS[verb]}… ${Math.max(0, Math.floor(seconds))} s`;
}

/** The sync view's line under a shared copy's name: the counts against it, and when it was last checked. */
export function remoteSentence(remote: RemoteEntry, lastFetch: string | null): string {
  // The fetch time is the repository's, so a copy never compared has not been checked either
  if (remote.ahead === null || remote.behind === null) return 'not yet compared';
  const parts = [`${remote.ahead} to send`, `${remote.behind} to get`];
  if (lastFetch !== null) parts.push(`checked ${dayAndTime(lastFetch)}`);
  return parts.join(' · ');
}

/** The shared copies in the order the sync view lists them: the one synced with first, then by name. */
export function listedRemotes(status: RepoStatus | undefined): RemoteEntry[] {
  return [...(status?.remotes ?? [])].sort(
    (a, b) => Number(b.syncsWith) - Number(a.syncsWith) || a.name.localeCompare(b.name),
  );
}

/** `today 14:02`, or the date and time for an older moment. */
export function dayAndTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const today = now.toDateString() === date.toDateString();
  return `${today ? 'today' : day} ${timeOf(iso)}`;
}

/** What an empty list says, given why it is empty. */
export function emptySentence(state: HistoryState): string {
  if (state.repos.length === 0) return 'This project is not under version control yet.';
  if (!ownedRepo(state)) {
    const root = state.repos.find((r) => r.role === state.repo)?.root ?? '';
    return `This project sits inside ${root}, which the app does not write history to. Showing that repository read-only.`;
  }
  if (filtering(state.filter)) {
    if (state.filter.path !== '') return `No saves touch ${state.filter.path} yet.`;
    if (state.filter.checkpointsOnly) return 'No save has a checkpoint yet.';
    if (state.filter.text !== '') return `No save mentions “${state.filter.text}”.`;
    const who = WHO_ROWS.find((r) => r.id === state.filter.who)?.label ?? '';
    return `No saves by ${who.toLowerCase()} yet.`;
  }
  return 'Every save will appear here. Edit anything and it is saved.';
}

// -----------------------------------------------------------------------------
// Grouping
// -----------------------------------------------------------------------------

/** The rows under one day heading. */
export interface DayGroup {
  heading: string;
  saves: Save[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The local calendar day a date falls on, as days since the epoch. */
function dayOf(date: Date): number {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round(local.getTime() / DAY_MS);
}

/** Today, Yesterday, a weekday within the week, or the date. */
export function dayHeading(date: Date, now: Date = new Date()): string {
  const gap = dayOf(now) - dayOf(date);
  if (gap === 0) return 'Today';
  if (gap === 1) return 'Yesterday';
  if (gap > 1 && gap < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    day  : 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** The rows grouped by day, in the order they came. */
export function groupByDay(saves: readonly Save[], now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const save of saves) {
    const heading = dayHeading(new Date(save.date), now);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.saves.push(save);
    else groups.push({ heading, saves: [save] });
  }
  return groups;
}

/** `HH:MM` in the local zone, on the 24-hour clock so the column stays one width. */
export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour     : '2-digit',
    minute   : '2-digit',
    hourCycle: 'h23',
  });
}

/** The rows the checkpoint tick keeps; the other filters are applied by the read. */
export function shown(saves: readonly Save[], filter: HistoryFilter): Save[] {
  return filter.checkpointsOnly ? saves.filter((s) => s.checkpoints.length > 0) : [...saves];
}

/**
 * The status view's one control per cause: save the outside edits, decide, or give up. A stopped
 * sync or merge leads to the conflict view, where Give up sits beside Continue.
 */
export function statusControls(state: HistoryState): readonly Offer[] {
  switch (state.status?.cause) {
    case 'pending':
    case 'outside':
      return [saveAction(state)];
    case 'rebase':
    case 'merge':
      return [conflictsAction()];
    case 'revert':
      return [abandonSyncAction(state)];
    default:
      return [];
  }
}

/** Every offer the History pane draws from this module. */
export function controls(state: HistoryState): readonly Offer[] {
  const many = state.repos.length > 1;
  return [
    ...(many ? state.repos.map((entry) => repoAction(entry, state.repo)) : []),
    ...(state.repos.length > 0 ? [syncViewAction(state)] : []),
    whoAction(state.filter.who),
    pathAction(state.filter.path),
    checkpointsAction(state.filter.checkpointsOnly),
    searchBox(state.filter.text),
    clearAction(state.filter),
    checkpointAction(state),
    reloadAction(),
    ...(state.size === 'small' && state.showingDetail ? [backAction()] : []),
    ...statusControls(state),
    ...state.saves.map((save) => rowAction(save, save.sha === state.selected)),
    ...(state.saves.length > 0 ? [moreAction(state.next)] : []),
    ...detailControls(state),
  ];
}

/**
 * The sync view's offers: get their saves, then per shared copy send, check, sync with, change
 * the address and remove, and at the foot add another. With none, only the way to connect one.
 */
export function syncControls(state: HistoryState): readonly Offer[] {
  const remotes = listedRemotes(state.status);
  return [
    ...(remotes.length > 0 ? [pullAction(state)] : []),
    ...remotes.flatMap((remote) => [
      pushAction(state, remote),
      fetchAction(state, remote),
      syncWithAction(state, remote),
      setRemoteUrlAction(state, remote),
      removeRemoteAction(state, remote),
    ]),
    addRemoteAction(state),
  ];
}

/**
 * The conflict view's offers: per file in question keep mine, take theirs and edit; the box, save
 * and cancel for the one open for editing; undo per decided file; then continue and give up.
 */
export function conflictControls(state: HistoryState): readonly Offer[] {
  const paths = state.status?.conflicted ?? [];
  const decided = state.status?.decided ?? [];
  const editing = state.editing;
  return [
    ...paths.flatMap((path) => [
      resolveAction(state, path, 'mine'),
      resolveAction(state, path, 'theirs'),
      editAction(state, path),
    ]),
    ...(editing === undefined
      ? []
      : [resolveBox(editing), saveResolutionAction(state, editing), cancelEditAction(editing)]),
    ...decided.map((file) => undoResolutionAction(state, file)),
    continueSyncAction(state),
    abandonSyncAction(state),
  ];
}

/**
 * The detail column's offers: the sync view's or the conflict view's when one of those has the
 * column, else the conversation, the three recovery controls and one per checkpoint, one row per
 * file, the logs fold, the way back, and the diff's own control.
 */
export function detailControls(state: HistoryState): readonly Offer[] {
  if (conflicting(state)) return conflictControls(state);
  if (state.syncOpen) return syncControls(state);
  const save = state.saves.find((s) => s.sha === state.selected);
  if (!save) return [];
  const logs = save.files.filter((f) => kindOf(f.path) === 'log');
  const alone = onlyLogs(save) && !state.logsOpen;
  const listed = alone
    ? []
    : state.logsOpen
      ? save.files
      : save.files.filter((f) => kindOf(f.path) !== 'log');
  return [
    conversationAction(threadOf(save)),
    takeBackAction(state, save),
    goBackAction(state, save),
    ...save.checkpoints.map((name) => dropCheckpointAction(state, name)),
    // Beneath the list at full width, the diff needs no way back; in the list's place it does
    ...(state.file !== undefined && state.size !== 'large' ? [filesBackAction()] : []),
    ...listed.map((f) => fileAction(f.path, f.path === state.file)),
    ...(logs.length > 0 ? [logsAction(state.logsOpen, logs.length, alone)] : []),
    ...(state.file !== undefined ? [restoreFileAction(state, save, state.file)] : []),
  ];
}
