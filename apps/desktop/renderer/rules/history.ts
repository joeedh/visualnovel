/**
 * What the History pane offers and says: the repository chooser, the four filters, reload, the
 * rows, paging, and the sentences the strip, the status line and the empty states carry. Pure
 * over what `git.repos`, `git.status` and `git.history` answered, so the derived model and the
 * pane draw from one place.
 */
import type { Maker, RepoEntry, RepoRole, RepoStatus, Save } from '../../src/shared/history.js';
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
  /** Whether the pane is one column wide, where the detail replaces the list. */
  narrow: boolean;
  /** Whether the pane is showing the detail in the list's place, in the narrow layout. */
  showingDetail: boolean;
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
    if (status.ahead === null || status.behind === null) parts.push('not yet compared');
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

/** Every offer the History pane draws from this module. */
export function controls(state: HistoryState): readonly Offer[] {
  const many = state.repos.length > 1;
  return [
    ...(many ? state.repos.map((entry) => repoAction(entry, state.repo)) : []),
    whoAction(state.filter.who),
    pathAction(state.filter.path),
    checkpointsAction(state.filter.checkpointsOnly),
    searchBox(state.filter.text),
    clearAction(state.filter),
    reloadAction(),
    ...(state.narrow && state.showingDetail ? [backAction()] : []),
    ...state.saves.map((save) => rowAction(save, save.sha === state.selected)),
    ...(state.saves.length > 0 ? [moreAction(state.next)] : []),
  ];
}
