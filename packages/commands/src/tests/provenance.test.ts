import { recordForCommit } from '../provenance.js';
import type { CommandRecord } from '../command.js';

const record = (seq: number, over: Partial<CommandRecord>): CommandRecord => ({
  seq,
  id        : 'story.setLineText',
  props     : {},
  invocation: 'story.setLineText()',
  source    : 'ui',
  mutating  : true,
  gitHead   : null,
  gitDirty  : false,
  startedAt : '',
  finishedAt: '',
  status    : 'ok',
  message   : '',
  ...over,
});

const LOG: CommandRecord[] = [
  record(1, { commits: [{ repo: 'p', sha: 'a1' }] }),
  record(2, { commits: [{ repo: 'p', sha: 'b1' }] }),
  record(3, {
    id     : 'git.pull',
    rewrote: [
      { from: 'a1', to: 'a2' },
      { from: 'b1', to: null },
    ],
  }),
  record(4, { commits: [{ repo: 'p', sha: 'c1' }] }),
  record(5, {
    id     : 'git.pull',
    rewrote: [
      { from: 'a2', to: 'a3' },
      { from: 'c1', to: 'c2' },
    ],
  }),
];

describe('recordForCommit', () => {
  it('finds a record by the sha it named', () => {
    expect(recordForCommit(LOG, 'c1')?.seq).toBe(4);
  });

  it('maps a rewritten sha back through the tables, newest first', () => {
    expect(recordForCommit(LOG, 'c2')?.seq).toBe(4);
    expect(recordForCommit(LOG, 'a3')?.seq).toBe(1);
    expect(recordForCommit(LOG, 'a2')?.seq).toBe(1);
  });

  it('answers nothing for a commit no record made', () => {
    expect(recordForCommit(LOG, 'zz')).toBeUndefined();
    expect(recordForCommit([], 'a1')).toBeUndefined();
  });
});
