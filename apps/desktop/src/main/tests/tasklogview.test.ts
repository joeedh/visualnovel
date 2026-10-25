import type { AnyTask, TaskLogEntry } from '@vn/types';
import { taskLogView } from '../session/tasklogview.js';

const task = (over: Partial<AnyTask>): AnyTask => ({
  hash    : 'h',
  kind    : 'portrait',
  deps    : [],
  inputs  : { characterId: 'a', prompt: '', refs: [], params: { modelId: 'mock-image' } },
  status  : 'failed',
  attempts: [],
  ...over,
});

it('recovers a failure from the record without showing it twice', () => {
  const view = taskLogView(
    'h',
    [],
    task({ error: 'boom', attempts: [{ attempt: 1, refs: [], error: 'boom', at: '1' }] }),
  );
  expect(view.lines).toEqual([
    expect.objectContaining({ source: 'record', text: 'boom', attempt: 1, execution: '' }),
  ]);
});

it('states a needs_human reason that no attempt carries', () => {
  const view = taskLogView(
    'h',
    [],
    task({
      status  : 'needs_human',
      error   : 'still blocking',
      attempts: [{ attempt: 1, refs: [], at: '1' }],
    }),
  );
  expect(view.lines).toEqual([
    expect.objectContaining({ level: 'info', text: 'needs_human: still blocking' }),
  ]);
});

it('recovers only what predates the log file, and resolves system prompts', () => {
  const entries: TaskLogEntry[] = [
    { t: 'system', hash: 's', text: 'be careful' },
    { t: 'log', execution: 'e', at: '5', level: 'error', source: 'scheduler', text: 'failed: new' },
    {
      t        : 'review',
      execution: 'e',
      at       : '4',
      reviewer : 'claude',
      system   : 's',
      prompt   : 'p',
      images   : [],
      responses: ['{}'],
      ms       : 1,
    },
  ];
  const view = taskLogView(
    'h',
    entries,
    task({
      error   : 'new',
      attempts: [
        { attempt: 1, refs: [], error: 'old', at: '1' },
        { attempt: 1, refs: [], error: 'new', at: '6' },
      ],
    }),
  );
  expect(view.lines.map((l) => l.text)).toEqual(['old', 'failed: new']);
  expect(view.reviews).toEqual([
    expect.objectContaining({ reviewer: 'claude', systemText: 'be careful' }),
  ]);
});
