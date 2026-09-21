import {
  clearAction,
  dayHeading,
  emptySentence,
  groupByDay,
  moreAction,
  NO_FILTER,
  pathAction,
  resolvePath,
  shown,
  statusSentence,
  stripSentence,
  timeOf,
  type HistoryState,
} from '../history.js';
import { SITUATIONS } from '../situations/history.js';
import type { RepoEntry, RepoStatus } from '../../../src/shared/history.js';

const PROJECT: RepoEntry = { role: 'project', root: 'C:\\stories\\rooftop', owned: true };
const WIKI: RepoEntry = { role: 'wiki', root: 'C:/stories/rooftop/wiki', owned: true };
const BASE: RepoEntry = { role: 'base', root: 'C:/stories/rooftop/wiki/base', owned: true };
const FOREIGN: RepoEntry = { role: 'project', root: 'C:/stories', owned: false };

const state = (name: string): HistoryState => SITUATIONS.find((s) => s.name === name)!.state;

describe('resolvePath', () => {
  it('leaves a path the project holds with the project', () => {
    expect(resolvePath([PROJECT, WIKI], 'scenes/rooftop.fountain')).toEqual({
      repo: 'project',
      path: 'scenes/rooftop.fountain',
    });
  });

  // The two roots are spelled with different slashes on purpose: `git.repos` answers with
  // whatever each repository's `rev-parse` printed.
  it('hands a path under the story bible’s own repository to it, relative to its root', () => {
    expect(resolvePath([PROJECT, WIKI], 'wiki/places/harbour.md')).toEqual({
      repo: 'wiki',
      path: 'places/harbour.md',
    });
    expect(resolvePath([PROJECT, WIKI], 'wiki')).toEqual({ repo: 'wiki', path: '' });
  });

  it('takes the longest root, and never a repository the app does not own', () => {
    expect(resolvePath([PROJECT, WIKI, BASE], 'wiki/base/plate.png')).toEqual({
      repo: 'base',
      path: 'plate.png',
    });
    expect(resolvePath([PROJECT, { ...WIKI, owned: false }], 'wiki/x.md')).toEqual({
      repo: 'project',
      path: 'wiki/x.md',
    });
  });

  it('does not mistake a sibling prefix for a root', () => {
    expect(resolvePath([PROJECT, WIKI], 'wikipedia.md').repo).toBe('project');
    expect(resolvePath([FOREIGN], 'wiki/x.md').repo).toBe('project');
    expect(resolvePath([], '').repo).toBe('project');
  });
});

describe('stripSentence', () => {
  const clean = state('one-repo').status!;

  it('names the role, the branch and the standing against the shared copy', () => {
    expect(stripSentence(PROJECT, clean)).toBe(
      'Project · main · shared copy origin/main · 3 to send · 0 to get',
    );
  });

  it('says when there is no shared copy, and when it has not been compared yet', () => {
    expect(stripSentence(PROJECT, { ...clean, upstream: null })).toBe(
      'Project · main · no shared copy yet',
    );
    expect(stripSentence(PROJECT, { ...clean, ahead: null, behind: null })).toBe(
      'Project · main · shared copy origin/main · not yet compared',
    );
  });

  it('keeps the branch and the counts, and drops the copy’s name, in a narrow pane', () => {
    expect(stripSentence(PROJECT, clean, true)).toBe('Project · main · 3 to send · 0 to get');
    expect(stripSentence(PROJECT, { ...clean, ahead: null, behind: null }, true)).toBe(
      'Project · main · not yet compared',
    );
  });

  it('says what to do about a detached story bible', () => {
    expect(stripSentence(WIKI, { ...clean, branch: null })).toContain('check one out in');
  });

  it('says the app does not write into a repository it merely sits inside', () => {
    expect(stripSentence(FOREIGN, clean)).toBe(
      'Project · inside C:/stories · the app does not write history here',
    );
    expect(stripSentence(undefined, clean)).toBe('');
  });
});

describe('statusSentence', () => {
  const clean = state('one-repo').status!;
  const at = (over: Partial<RepoStatus>): string => statusSentence({ ...clean, ...over });

  it('is empty for a clean worktree, and one line per cause otherwise', () => {
    expect(statusSentence(undefined)).toBe('');
    expect(at({})).toBe('');
    expect(at({ cause: 'pending', pending: 1 })).toBe('Saving 1 edit…');
    expect(at({ cause: 'outside', outside: ['a', 'b'] })).toBe('2 files changed outside the app');
    expect(at({ cause: 'rebase', conflicted: [] })).toBe('Getting their saves is unfinished');
    expect(at({ cause: 'rebase', conflicted: ['a'] })).toBe(
      'Getting their saves: 1 file needs a decision',
    );
    expect(at({ cause: 'merge' })).toBe('A merge started outside the app is unfinished');
    expect(at({ cause: 'revert' })).toBe('Taking back a save stopped part way');
  });
});

describe('emptySentence', () => {
  it('explains an empty list by what emptied it', () => {
    expect(emptySentence(state('no-repo'))).toBe('This project is not under version control yet.');
    expect(emptySentence({ ...state('one-repo'), repos: [FOREIGN] })).toContain('read-only');
    expect(emptySentence({ ...state('one-repo'), saves: [] })).toBe(
      'Every save will appear here. Edit anything and it is saved.',
    );
    expect(emptySentence(state('empty'))).toBe('No save has a checkpoint yet.');
    const narrowed = state('two-repos-filtered');
    expect(emptySentence(narrowed)).toBe('No saves touch scenes/rooftop.fountain yet.');
    expect(emptySentence({ ...narrowed, filter: { ...NO_FILTER, text: 'rain' } })).toBe(
      'No save mentions “rain”.',
    );
    expect(emptySentence({ ...narrowed, filter: { ...NO_FILTER, who: 'agent' } })).toBe(
      'No saves by agent yet.',
    );
  });
});

describe('the refused controls', () => {
  it('refuse with the reason, and accept once there is something to do', () => {
    expect(clearAction(NO_FILTER)).toMatchObject({
      ok     : false,
      refusal: { reason: 'Nothing narrows the list.' },
    });
    expect(clearAction({ ...NO_FILTER, who: 'agent' }).ok).toBe(true);
    expect(pathAction('')).toMatchObject({ ok: false, label: 'Any file' });
    expect(pathAction('wiki/x.md')).toMatchObject({ ok: true, label: 'wiki/x.md' });
    expect(moreAction(null)).toMatchObject({
      ok     : false,
      refusal: { reason: 'Every save is listed.' },
    });
    expect(moreAction('a'.repeat(40)).ok).toBe(true);
  });
});

describe('grouping', () => {
  const now = new Date(2026, 8, 21, 15, 0);

  it('heads a day by how far back it is', () => {
    expect(dayHeading(new Date(2026, 8, 21, 9), now)).toBe('Today');
    expect(dayHeading(new Date(2026, 8, 20, 23, 59), now)).toBe('Yesterday');
    expect(dayHeading(new Date(2026, 8, 16), now)).toBe(
      new Date(2026, 8, 16).toLocaleDateString(undefined, { weekday: 'long' }),
    );
    expect(dayHeading(new Date(2026, 7, 2), now)).not.toMatch(/2026/);
    expect(dayHeading(new Date(2025, 7, 2), now)).toMatch(/2025/);
  });

  it('groups consecutive saves under one heading', () => {
    const saves = state('one-repo').saves;
    const groups = groupByDay(saves, new Date(saves[0]!.date));
    expect(groups.map((g) => [g.heading, g.saves.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
    ]);
  });

  it('keeps only the checkpointed saves when the tick is on', () => {
    const saves = state('one-repo').saves;
    expect(shown(saves, NO_FILTER)).toHaveLength(3);
    expect(shown(saves, { ...NO_FILTER, checkpointsOnly: true }).map((s) => s.sha[0])).toEqual([
      'c',
    ]);
  });

  it('writes the time on the 24-hour clock', () => {
    expect(timeOf(new Date(2026, 8, 21, 18, 42).toISOString())).toBe('18:42');
  });
});
