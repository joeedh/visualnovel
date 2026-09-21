import {
  checkpointAction,
  clearAction,
  controls,
  dayHeading,
  detailControls,
  dropCheckpointAction,
  emptySentence,
  goBackAction,
  groupByDay,
  moreAction,
  NO_FILTER,
  onlyLogs,
  pathAction,
  ranSentence,
  resolvePath,
  restoreFileAction,
  saveAction,
  shown,
  statusSentence,
  stripSentence,
  takeBackAction,
  threadOf,
  timeOf,
  undoSentence,
  type HistoryState,
} from '../history.js';
import { duplicateKeys } from '../anchors.js';
import { SITUATIONS } from '../situations/history.js';
import {
  NOT_OWNED,
  SYNC_UNFINISHED,
  type RepoEntry,
  type RepoStatus,
} from '../../../src/shared/history.js';

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

describe('the detail column', () => {
  const open = state('agent-save-open');
  const agent = open.saves[1]!;
  const mine = open.saves[0]!;

  it('finds the conversation in the trailer, else in the transcript the turn appended to', () => {
    expect(threadOf(agent)).toBe('20260921-133000');
    expect(threadOf(mine)).toBeUndefined();
    expect(
      threadOf({
        ...agent,
        files: [{ path: 'vngen/state/threads/x.native.jsonl', added: 1, removed: 0 }],
      }),
    ).toBeUndefined();
    expect(
      threadOf({
        ...agent,
        files   : [],
        trailers: { 'Vn-Source': 'agent', 'Vn-Thread': 'thread-9' },
      }),
    ).toBe('thread-9');
  });

  it('says what the app ran, from the trailers', () => {
    expect(ranSentence(mine)).toBe("story.moveLine(lineId='L4' toScene='rooftop')");
    expect(
      ranSentence({
        ...mine,
        trailers: { 'Vn-Batch': '30 seqs 12-41', 'Vn-Command': 'story.editLine, story.setSpeaker' },
      }),
    ).toBe('30 acts: story.editLine, story.setSpeaker');
    expect(ranSentence({ ...mine, trailers: {} })).toBe('');
  });

  it('knows a save that touched only logs', () => {
    expect(onlyLogs(agent)).toBe(false);
    expect(onlyLogs({ ...agent, files: agent.files.slice(1) })).toBe(true);
    expect(onlyLogs({ ...agent, files: [] })).toBe(false);
  });

  it('offers the conversation on an agent save and refuses it on the author’s own', () => {
    const [convo] = detailControls(open);
    expect(convo).toMatchObject({
      ok   : true,
      id   : 'agent.openThread',
      props: { id: '20260921-133000' },
      then : [{ id: 'view.open', props: { editor: 'convo', where: 'elsewhere' } }],
    });
    expect(detailControls(state('one-repo'))[0]).toMatchObject({
      ok     : false,
      id     : 'agent.openThread',
      refusal: { reason: 'This save did not come from a conversation.' },
    });
    const { selected: _selected, ...unselected } = open;
    expect(detailControls(unselected)).toEqual([]);
  });

  it('folds the logs behind their count, and lists them once unfolded', () => {
    const folded = detailControls(open).map((o) => o.label);
    expect(folded).toEqual([
      'Open the conversation',
      'Take back this save',
      'Go back to here',
      'scenes/rooftop.fountain',
      'Logs (2)',
      'Bring back this file',
    ]);
    const unfolded = detailControls(state('mid-diff-open')).map((o) => o.label);
    expect(unfolded).toEqual([
      'Open the conversation',
      'Take back this save',
      'Go back to here',
      '← Files',
      'scenes/rooftop.fountain',
      'vngen/state/commands.jsonl',
      'vngen/state/threads/20260921-133000.jsonl',
      'Logs',
      'Bring back this file',
    ]);
  });

  it('offers the way back to the files only where the diff took their place', () => {
    const labels = (s: HistoryState) => detailControls(s).map((o) => o.label);
    expect(labels(open)).not.toContain('← Files');
    expect(labels({ ...open, size: 'mid' })).toContain('← Files');
    expect(labels({ ...open, size: 'small' })).toContain('← Files');
    const { file: _file, ...noFile } = open;
    expect(labels({ ...noFile, size: 'small' })).not.toContain('← Files');
  });
});

describe('the recovery controls', () => {
  const outside = state('outside-edits');
  const save = outside.saves[1]!;

  it('draw the check’s own refusal, and accept while it has not answered', () => {
    expect(takeBackAction(outside, save)).toMatchObject({
      ok     : false,
      id     : 'git.takeBack',
      form   : true,
      refusal: { reason: expect.stringContaining('changed again in 1 later save') },
    });
    expect(goBackAction(outside, save)).toMatchObject({
      ok   : true,
      form : true,
      props: { repo: 'project', sha: save.sha },
    });
    expect(restoreFileAction(outside, save, 'scenes/rooftop.fountain')).toMatchObject({
      ok   : true,
      id   : 'git.restoreFile',
      props: { repo: 'project', sha: save.sha, path: 'scenes/rooftop.fountain' },
    });
    const unasked = { ...outside, verdicts: {} };
    expect(takeBackAction(unasked, save).ok).toBe(true);
  });

  it('refuse every write in a repository the app does not own, with the one sentence', () => {
    const foreign = state('foreign-repo');
    const mine = foreign.saves[0]!;
    for (const offer of [
      saveAction(foreign),
      checkpointAction(foreign),
      dropCheckpointAction(foreign, 'x'),
      takeBackAction(foreign, mine),
      goBackAction(foreign, mine),
      restoreFileAction(foreign, mine, 'project.yaml'),
    ]) {
      expect(offer).toMatchObject({ ok: false, refusal: { reason: NOT_OWNED } });
    }
  });

  it('refuse a take-back and a go-back while a sync is unfinished', () => {
    const rebasing = { ...outside, status: { ...outside.status!, cause: 'rebase' as const } };
    expect(takeBackAction(rebasing, save)).toMatchObject({ refusal: { reason: SYNC_UNFINISHED } });
    expect(goBackAction(rebasing, save)).toMatchObject({ refusal: { reason: SYNC_UNFINISHED } });
    expect(saveAction(rebasing)).toMatchObject({ refusal: { reason: SYNC_UNFINISHED } });
  });

  it('offer Save these… only over edits made outside the app', () => {
    expect(saveAction(outside)).toMatchObject({ ok: true, form: true, props: { repo: 'project' } });
    expect(saveAction(state('one-repo'))).toMatchObject({
      ok     : false,
      refusal: { reason: 'Nothing has changed since the last save.' },
    });
    const pending = { ...outside, status: { ...outside.status!, cause: 'pending' as const } };
    expect(saveAction(pending)).toMatchObject({
      refusal: { reason: 'The app is saving these edits itself.' },
    });
  });

  it('name the selected save as a checkpoint, or the latest with none selected', () => {
    const picked = state('checkpointed');
    expect(checkpointAction(picked)).toMatchObject({
      ok   : true,
      props: { repo: 'project', sha: 'c'.repeat(40) },
    });
    const { selected: _selected, ...none } = picked;
    expect(checkpointAction(none)).toMatchObject({ ok: true, props: { sha: '' } });
    expect(checkpointAction(state('empty'))).toMatchObject({
      refusal: { reason: 'There is no save to name yet.' },
    });
    expect(detailControls(picked).map((o) => o.label)).toContain(
      'Drop checkpoint “before-the-rain-pass”',
    );
    expect(dropCheckpointAction(picked, 'before-the-rain-pass')).toMatchObject({
      ok   : true,
      on   : 'before-the-rain-pass',
      props: { repo: 'project', name: 'before-the-rain-pass' },
    });
  });

  it('say in the footer when the undo history from before no longer applies', () => {
    expect(undoSentence(state('checkpointed'))).toBe(
      'Undo history from before this save no longer applies.',
    );
    expect(undoSentence(state('one-repo'))).toBe('');
  });

  it('draw no key twice in any situation', () => {
    for (const situation of SITUATIONS) {
      expect(duplicateKeys(controls(situation.state))).toEqual([]);
    }
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
