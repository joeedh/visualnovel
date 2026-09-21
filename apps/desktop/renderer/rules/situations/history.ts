/**
 * The History pane's situations: one repository with saves of every maker, two repositories with
 * a filter on, a project inside a foreign repository, an empty history, and a save with a diff
 * open in each width.
 */
import { situations } from './situation.js';
import { NO_FILTER, type HistoryState } from '../history.js';
import type { RepoStatus, Save } from '../../../src/shared/history.js';

const PROJECT = { role: 'project' as const, root: 'C:/stories/rooftop', owned: true };
const WIKI = { role: 'wiki' as const, root: 'C:/stories/rooftop/wiki', owned: true };

const CLEAN: RepoStatus = {
  cause     : 'clean',
  outside   : [],
  conflicted: [],
  pending   : 0,
  branch    : 'main',
  upstream  : 'origin/main',
  ahead     : 3,
  behind    : 0,
  remotes   : [{ name: 'origin', url: 'https://github.com/mara/rooftop.git' }],
  lastFetch : '2026-09-21T09:00:00Z',
  inProgress: { rebase: null, merge: false, revert: false },
};

const save = (over: Partial<Save> & { sha: string }): Save => ({
  parents    : ['0'.repeat(40)],
  author     : 'VN Studio',
  email      : 'vnstudio@localhost',
  date       : '2026-09-21T14:02:00+00:00',
  subject    : 'Moved line L4 into rooftop',
  body       : '',
  trailers: {
    'Vn-Command'   : 'story.moveLine',
    'Vn-Invocation': "story.moveLine(lineId='L4' toScene='rooftop')",
    'Vn-Source'    : 'ui',
  },
  files      : [{ path: 'scenes/rooftop.fountain', added: 3, removed: 1 }],
  maker      : 'author',
  checkpoints: [],
  sent       : false,
  ...over,
});

const SAVES: Save[] = [
  save({ sha: 'a'.repeat(40) }),
  save({
    sha     : 'b'.repeat(40),
    subject : 'Agent turn: make the rooftop scene tenser',
    trailers: {
      'Vn-Command'   : 'agent.run',
      'Vn-Invocation': "agent.run(input='make the rooftop scene tenser')",
      'Vn-Source'    : 'ui',
    },
    maker   : 'agent',
    date    : '2026-09-21T13:40:00+00:00',
    files: [
      { path: 'scenes/rooftop.fountain', added: 12, removed: 4 },
      { path: 'vngen/state/commands.jsonl', added: 2, removed: 0 },
      { path: 'vngen/state/threads/20260921-133000.jsonl', added: 6, removed: 0 },
    ],
  }),
  save({
    sha        : 'c'.repeat(40),
    subject    : 'Generated 14 assets',
    trailers   : { 'Vn-Command': 'pipeline.run', 'Vn-Source': 'menu' },
    maker      : 'pipeline',
    date       : '2026-09-20T18:42:00+00:00',
    checkpoints: ['before-the-rain-pass'],
    sent       : true,
    files      : [{ path: 'vngen/build/assets/ab12.png', added: null, removed: null }],
  }),
];

export const SITUATIONS = situations<HistoryState>(
  {
    name : 'one-repo',
    why: 'One repository, so no chooser is drawn; three rows of three makers, one selected; every filter off, so Show all is refused; more saves remain, so Earlier saves is offered. The selected save is the author’s own, so opening a conversation is refused.',
    state: {
      repos        : [PROJECT],
      repo         : 'project',
      filter       : NO_FILTER,
      status       : CLEAN,
      saves        : SAVES,
      next         : 'c'.repeat(40),
      selected     : 'a'.repeat(40),
      logsOpen     : false,
      size         : 'large',
      showingDetail: false,
    },
  },
  {
    name : 'two-repos-filtered',
    why: 'The story bible is its own repository, so the chooser lists both; the list is narrowed to one file and to the agent, so the chip and Show all are offered; the history has ended, so Earlier saves is refused.',
    state: {
      repos        : [PROJECT, WIKI],
      repo         : 'project',
      filter: { who: 'agent', path: 'scenes/rooftop.fountain', text: '', checkpointsOnly: false },
      status       : CLEAN,
      saves        : [SAVES[1]!],
      next         : null,
      logsOpen     : false,
      size         : 'large',
      showingDetail: false,
    },
  },
  {
    name : 'agent-save-open',
    why: 'An agent’s save is selected at full width with a diff open beneath its files: the conversation is offered, the logs are folded behind their count, and no way back is drawn because the file list is still on screen.',
    state: {
      repos        : [PROJECT],
      repo         : 'project',
      filter       : NO_FILTER,
      status       : CLEAN,
      saves        : SAVES,
      next         : null,
      selected     : 'b'.repeat(40),
      file         : 'scenes/rooftop.fountain',
      logsOpen     : false,
      size         : 'large',
      showingDetail: false,
    },
  },
  {
    name : 'mid-diff-open',
    why: 'Two narrow columns with a diff open in the file list’s place, and the logs unfolded: the way back to the files is offered, and every file including the logs is listed.',
    state: {
      repos        : [PROJECT],
      repo         : 'project',
      filter       : NO_FILTER,
      status       : CLEAN,
      saves        : SAVES,
      next         : null,
      selected     : 'b'.repeat(40),
      file         : 'scenes/rooftop.fountain',
      logsOpen     : true,
      size         : 'mid',
      showingDetail: false,
    },
  },
  {
    name : 'narrow-detail',
    why: 'The pane is one column wide and a row is open, so the way back to the list is offered above the detail.',
    state: {
      repos        : [PROJECT],
      repo         : 'project',
      filter       : NO_FILTER,
      status       : CLEAN,
      saves        : SAVES,
      next         : null,
      selected     : 'b'.repeat(40),
      logsOpen     : false,
      size         : 'small',
      showingDetail: true,
    },
  },
  {
    name : 'empty',
    why: 'A repository with nothing but its first commit filtered away by the checkpoint tick: no rows, so no paging control, and Show all is offered.',
    state: {
      repos        : [PROJECT],
      repo         : 'project',
      filter       : { ...NO_FILTER, checkpointsOnly: true },
      status       : { ...CLEAN, upstream: null, ahead: null, behind: null, remotes: [] },
      saves        : [],
      next         : null,
      logsOpen     : false,
      size         : 'large',
      showingDetail: false,
    },
  },
  {
    name : 'no-repo',
    why: 'The project is not under version control, so the filters are drawn but there is nothing to list and no repository to choose.',
    state: {
      repos        : [],
      repo         : 'project',
      filter       : NO_FILTER,
      saves        : [],
      next         : null,
      logsOpen     : false,
      size         : 'large',
      showingDetail: false,
    },
  },
);
