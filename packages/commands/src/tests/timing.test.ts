import type { Git } from '@vn/git';
import { defineCommand } from '../command.js';
import type { Committer } from '../commit.js';
import { CommandRegistry } from '../registry.js';
import { CommandStack } from '../stack.js';
import { PhaseTimer, TimingBuffer } from '../timing.js';
import type { UndoJournal } from '../undo.js';

function setup(deferred = false) {
  let clock = 0;
  const advance = (ms: number) => {
    clock += ms;
  };
  const registry = new CommandRegistry();
  let body = async (timing: PhaseTimer) => {
    return timing.measure('shotsWriteMs', async () => {
      advance(11);
      return { message: 'Saved' };
    });
  };
  registry.register(
    defineCommand({
      id          : 'test.save',
      title       : 'Save',
      description : 'Save',
      props       : {},
      mutating    : true,
      undoable    : true,
      defersCommit: deferred,
      run         : (_props, ctx) => body(ctx.timing!),
    }),
  );
  let captures = 0;
  const stack = new CommandStack({
    registry,
    context: {
      root: '/ws',
      host: {},
      log : () => {},
      git: {
        provenance: async () => {
          advance(9);
          return { head: 'head', dirty: false };
        },
      } as unknown as Git,
    },
    journal: {
      capture: async () => {
        advance(++captures === 1 ? 5 : 7);
        return 'snapshot';
      },
      point  : () => undefined,
      prune: () => {
        advance(19);
        return [];
      },
    } as unknown as UndoJournal,
    committer: {
      commit: async () => {
        advance(13);
        return [];
      },
      commitBatch: async () => {
        advance(23);
        return [];
      },
    } as unknown as Committer,
    onRecord    : () => advance(17),
    monotonicNow: () => clock,
    now         : () => 'fixed-wall-time',
    timer       : { set: () => 1, clear: () => {} },
  });
  return {
    stack,
    advance,
    setBody: (next: typeof body) => {
      body = next;
    },
  };
}

it('measures command phases independently of provenance timestamps', async () => {
  const { stack } = setup();
  const result = await stack.exec('test.save', {}, 'ui');
  expect(result.record).toMatchObject({
    startedAt : 'fixed-wall-time',
    finishedAt: 'fixed-wall-time',
  });
  expect(stack.timings()[0]).toMatchObject({
    kind   : 'command',
    status : 'ok',
    seqs   : [1],
    totalMs: 81,
    phases: {
      queueWaitMs     : 0,
      gitStateMs      : 9,
      snapshotBeforeMs: 5,
      saveMs          : 11,
      shotsWriteMs    : 11,
      snapshotAfterMs : 7,
      commitMs        : 13,
      recordMs        : 17,
      cleanupMs       : 19,
    },
  });
});

it('records failed saves and does not invent post-save phases', async () => {
  const { stack, advance, setBody } = setup();
  setBody(async () => {
    advance(31);
    throw new Error('save failed');
  });
  expect((await stack.exec('test.save', {}, 'ui')).ok).toBe(false);
  const sample = stack.timings()[0]!;
  expect(sample.status).toBe('error');
  expect(sample.phases.saveMs).toBe(31);
  expect(sample.phases.snapshotAfterMs).toBeUndefined();
  expect(sample.phases.commitMs).toBeUndefined();
});

it('links deferred commit timing to the edits in its batch', async () => {
  const { stack } = setup(true);
  await stack.exec('test.save', {}, 'ui');
  await stack.exec('test.save', {}, 'ui');
  expect(stack.timings().every((s) => s.phases.commitMs === undefined)).toBe(true);
  await stack.flushCommits();
  expect(stack.timings().at(-1)).toMatchObject({
    kind   : 'commitBatch',
    seqs   : [1, 2],
    status : 'ok',
    totalMs: 23,
    phases : { commitMs: 23 },
  });
});

it('measures time spent waiting behind another command', async () => {
  const { stack, advance, setBody } = setup();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  setBody(async () => {
    entered();
    await gate;
    return { message: 'Saved' };
  });
  const first = stack.exec('test.save', {}, 'ui');
  await started;
  const second = stack.exec('test.save', {}, 'ui');
  advance(100);
  release();
  await Promise.all([first, second]);
  // The first command still needs its post snapshot, commit, record, and cleanup.
  expect(stack.timings()[1]!.phases.queueWaitMs).toBe(156);
});

it('retains elapsed time when a synchronous refresh throws', () => {
  let now = 0;
  const timer = new PhaseTimer(() => now);
  expect(() =>
    timer.measureSync('refreshMs', () => {
      now = 8;
      throw new Error('layout');
    }),
  ).toThrow('layout');
  expect(timer.phases.refreshMs).toBe(8);
});

it('bounds diagnostics and returns independent copies', () => {
  const buffer = new TimingBuffer();
  for (let seq = 0; seq < 205; seq++)
    buffer.add({
      kind   : 'command',
      id     : 'save',
      seqs   : [seq],
      status : 'ok',
      totalMs: 1,
      phases : { saveMs: 1 },
    });
  const samples = buffer.read();
  expect(samples).toHaveLength(200);
  expect(samples[0]!.seqs).toEqual([5]);
  samples[0]!.seqs.push(99);
  samples[0]!.phases.saveMs = 99;
  expect(buffer.read()[0]).toMatchObject({ seqs: [5], phases: { saveMs: 1 } });
});
