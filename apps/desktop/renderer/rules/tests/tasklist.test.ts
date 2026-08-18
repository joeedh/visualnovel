import { emptyBecause, showing, type ListFilter } from '../tasklist.js';
import type { ImageParams, TaskStatus } from '@vn/types';
import type { Task } from '../../../src/shared/ipc';

const PARAMS: ImageParams = { modelId: 'mock-image' };

const task = (hash: string, status: TaskStatus): Task => ({
  hash,
  kind: 'location_ref',
  deps: [],
  status,
  attempts: [],
  inputs: { locationId: 'classroom', variant: 'day', prompt: '', refs: [], params: PARAMS },
});

const filter = (over: Partial<ListFilter> = {}): ListFilter => ({
  cleared: new Set(),
  onlyDone: false,
  ...over,
});

const TASKS = [task('a', 'done'), task('b', 'failed'), task('c', 'pending')];

describe('showing', () => {
  it('shows everything by default', () => {
    expect(showing(TASKS, filter()).map((t) => t.hash)).toEqual(['a', 'b', 'c']);
  });

  it('keeps only what succeeded under the filter — a failure has finished but is not done', () => {
    expect(showing(TASKS, filter({ onlyDone: true })).map((t) => t.hash)).toEqual(['a']);
  });

  it('drops what Clear took out, filter or no filter', () => {
    const cleared = new Set(['a', 'b']);
    expect(showing(TASKS, filter({ cleared })).map((t) => t.hash)).toEqual(['c']);
    expect(showing(TASKS, filter({ cleared, onlyDone: true }))).toEqual([]);
  });
});

describe('emptyBecause', () => {
  it('asks for a run when nothing has ever been planned', () => {
    expect(emptyBecause([], filter())).toContain('run the pipeline');
  });

  it('blames Clear when Clear is what emptied it', () => {
    const cleared = new Set(['a', 'b', 'c']);
    expect(emptyBecause(TASKS, filter({ cleared }))).toContain('Refresh brings it back');
  });

  // The defect this module exists for: Clear takes out exactly what `only done` keeps, so with
  // both on the filter used to be blamed — and told the author nothing had finished when the
  // three tasks it had just cleared all had.
  it('still blames Clear when the filter is on as well', () => {
    const cleared = new Set(['a', 'b', 'c']);
    expect(emptyBecause(TASKS, filter({ cleared, onlyDone: true }))).toContain(
      'Refresh brings it back',
    );
  });

  it('blames the filter only while something uncleared is left to reveal', () => {
    expect(emptyBecause([task('c', 'pending')], filter({ onlyDone: true }))).toContain('untick');
  });
});
