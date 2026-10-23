import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '../index.js';

it('coalesces editor prewarming, skips repeat work, and still uses Git for a clean first edit', async () => {
  const f = await fixture();
  try {
    await Promise.all([
      f.git.prewarmProvenance(f.options.files),
      f.git.prewarmProvenance(f.options.files),
    ]);
    expect(f.statusCalls()).toBe(1);
    expect(f.git['readyTrackers'].get('a.json')?.baselineHead()).toBeTruthy();
    expect(f.git.provenanceVerification()).toEqual([]);
    await f.git.prewarmProvenance(f.options.files);
    expect(f.statusCalls()).toBe(1);
    expect((await f.git.provenance(f.options)).dirty).toBe(false);
    expect(f.statusCalls()).toBe(2);
    await fs.writeFile(join(f.dir, 'a.json'), 'edit');
    expect((await f.git.provenance(f.options)).dirty).toBe(true);
    expect(f.statusCalls()).toBe(2);
  } finally {
    await f.close();
  }
});

it('returns Git while cold preparation is blocked and coalesces repeated cold requests', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const actualRun = f.run.getMockImplementation()!;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.run.mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('--absolute-git-dir')) {
        entered();
        await gate;
      }
      return actualRun.call(f.git, args);
    });
    expect((await f.git.provenance(f.options)).dirty).toBe(false);
    await started;
    const preparation = f.git['trackerPreparation'].get('a.json');
    await fs.writeFile(join(f.dir, 'a.json'), 'edit during preparation');
    expect((await f.git.provenance(f.options)).dirty).toBe(true);
    expect(f.git['trackerPreparation'].get('a.json')).toBe(preparation);
    expect(f.git['readyTrackers'].size).toBe(0);
    release();
    await preparation;
    const before = f.statusCalls();
    expect((await f.git.provenance(f.options)).dirty).toBe(true);
    expect(f.statusCalls()).toBe(before);
    // A later guard invalidation must not put the audit back on the edit path.
    await fs.writeFile(join(f.dir, '.gitattributes'), '');
    const refreshing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.run.mockImplementation(async (args) => {
      if (args[0] === 'ls-files') {
        entered();
        await refreshGate;
      }
      return actualRun.call(f.git, args);
    });
    expect((await f.git.provenance(f.options)).dirty).toBe(true);
    expect(f.statusCalls()).toBe(before + 1);
    expect(f.git.provenanceVerification().at(-1)?.reason).toBe('guards need refresh');
    await refreshing;
    release();
    await f.git['trackerPreparation'].get('a.json');
    const afterRefresh = f.statusCalls();
    await f.git.provenance({ ...f.options, verifyEvery: 100 });
    expect(f.statusCalls()).toBe(afterRefresh);
  } finally {
    release?.();
    await f.close();
  }
});

it.each(['commit', 'dispose'] as const)(
  'cannot publish background preparation across %s',
  async (operation) => {
    const f = await fixture();
    let release!: () => void;
    try {
      const actualRun = f.run.getMockImplementation()!;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.run.mockImplementation(async (args) => {
        const result = await actualRun.call(f.git, args);
        if (args[0] === 'cat-file') {
          entered();
          await gate;
        }
        return result;
      });
      const prewarm = f.git.prewarmProvenance(f.options.files);
      await started;
      const preparation = f.git['trackerPreparation'].get('a.json');
      const end = operation === 'commit' ? f.git.beginProvenanceMutation() : undefined;
      if (operation === 'dispose') f.git.stopProvenanceVerification();
      release();
      await preparation;
      await prewarm;
      expect(f.git['readyTrackers'].size).toBe(0);
      expect(f.git['trackedFiles'].size).toBe(0);
      end?.();
      const before = f.statusCalls();
      await f.git.provenance(f.options);
      expect(f.statusCalls()).toBe(before + 1);
      if (operation === 'commit') {
        await f.git['trackerPreparation'].get('a.json');
        expect(f.git['readyTrackers'].size).toBe(1);
      } else expect(f.git['trackerPreparation'].size).toBe(0);
    } finally {
      release?.();
      await f.close();
    }
  },
);

it('retries failed background setup while retaining authoritative Git results', async () => {
  const f = await fixture();
  try {
    const actualRun = f.run.getMockImplementation()!;
    let fail = true;
    f.run.mockImplementation(async (args) => {
      if (fail && args[0] === 'rev-parse') {
        fail = false;
        throw new Error('temporary setup failure');
      }
      return actualRun.call(f.git, args);
    });
    expect((await f.git.provenance(f.options)).dirty).toBe(false);
    await f.git['trackerPreparation'].get('a.json');
    expect(f.git['trackedFiles'].size).toBe(0);
    expect((await f.git.provenance(f.options)).dirty).toBe(false);
    await f.git['trackerPreparation'].get('a.json');
    expect(f.git['readyTrackers'].size).toBe(1);
  } finally {
    await f.close();
  }
});

it.each(['commit', 'reset', 'index flag', 'baseline replacement'] as const)(
  'falls back when %s races a cold guard audit',
  async (operation) => {
    const f = await fixture();
    let release!: () => void;
    try {
      await f.prime();
      // Force a fresh audit without changing the file's interpretation.
      await fs.writeFile(join(f.dir, '.gitattributes'), '');
      await fs.writeFile(join(f.dir, 'a.json'), 'edit');
      const actualRun = f.run.getMockImplementation()!;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.run.mockImplementation(async (args) => {
        const result = await actualRun.call(f.git, args);
        if (args[0] === 'ls-files') {
          entered();
          await gate;
        }
        return result;
      });
      const pending = f.git.provenance({ ...f.options, mode: 'verify' });
      await started;
      if (operation === 'commit') {
        await f.external(['add', 'a.json']);
        await f.external(['commit', '-m', 'external']);
      } else if (operation === 'reset') await f.external(['reset', '--hard', 'HEAD']);
      else if (operation === 'index flag')
        await f.external(['update-index', '--assume-unchanged', 'a.json']);
      else
        f.git['readyTrackers']
          .get('a.json')!
          .setBaseline((await f.git.head()) as string, Buffer.from('replacement'));
      release();
      const result = await pending;
      expect(result).toEqual(await f.git.provenance());
      expect(f.git.provenanceVerification().at(-1)?.result).toBe('fallback');
    } finally {
      release?.();
      await f.close();
    }
  },
);

async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-provenance-policy-'));
  const git = openGit(dir);
  const external = (args: string[]) =>
    promisify(execFile)('git', args, { cwd: dir, windowsHide: true });
  await external(['init']);
  await external(['config', 'user.name', 'Tracker test']);
  await external(['config', 'user.email', 'tracker@example.com']);
  await external(['config', 'core.autocrlf', 'false']);
  for (const file of ['a.json', 'b.json']) await fs.writeFile(join(dir, file), 'baseline');
  await external(['add', '.']);
  await external(['commit', '-m', 'baseline']);
  const run = jest.spyOn(git as unknown as { run(args: string[]): Promise<unknown> }, 'run');
  const statusCalls = () => run.mock.calls.filter(([args]) => args.includes('status')).length;
  const options = { files: ['a.json'], mode: 'prefer-tracker' as const, verifyEvery: 2 };
  return {
    dir,
    git,
    external,
    options,
    run,
    statusCalls,
    async prime() {
      await git.provenance(options);
      await git['trackerPreparation'].get('a.json');
    },
    async close() {
      const prewarms = [...git['trackerPrewarms'].values()];
      const preparing = [...git['trackerPreparation'].values()];
      git.stopProvenanceVerification();
      await Promise.allSettled(prewarms);
      await Promise.allSettled(preparing);
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

it('uses dirty witnesses per file, samples Git, and falls back for clean, unsupported, and default requests', async () => {
  const f = await fixture();
  try {
    await f.prime();
    expect(f.statusCalls()).toBe(1);
    await fs.writeFile(join(f.dir, 'a.json'), 'edit');
    // Verification warms guards without using the fast path.
    await f.git.provenance({ ...f.options, mode: 'verify' });
    const before = f.statusCalls();
    expect((await f.git.provenance(f.options)).dirty).toBe(true);
    expect(f.statusCalls()).toBe(before);
    expect(f.git.provenanceVerification().at(-1)?.result).toBe('used');
    await f.git.provenance(f.options);
    expect(f.statusCalls()).toBe(before + 1);
    expect(f.git.provenanceVerification().at(-1)?.result).toBe('agree');
    await f.git.provenance({ ...f.options, files: ['b.json'] });
    await f.git['trackerPreparation'].get('b.json');
    expect(f.git['readyTrackers'].get('b.json')?.baselineHead()).toBeTruthy();
    await fs.writeFile(join(f.dir, 'b.json'), 'other edit');
    await f.git.provenance({ ...f.options, files: ['b.json'], mode: 'verify' });
    const defaultBefore = f.statusCalls();
    await f.git.provenance();
    await f.git.provenance({ ...f.options, files: ['a.json', 'b.json'] });
    expect(f.statusCalls()).toBe(defaultBefore + 2);
    await f.external(['update-index', '--assume-unchanged', 'a.json']);
    const unsafeBefore = f.statusCalls();
    await f.git.provenance(f.options);
    expect(f.statusCalls()).toBe(unsafeBefore + 1);
  } finally {
    await f.close();
  }
});

it('blocks predictions throughout commits and rejects an in-flight result after invalidation', async () => {
  const f = await fixture();
  try {
    await f.prime();
    await fs.writeFile(join(f.dir, 'a.json'), 'edit');
    await f.git.provenance({ ...f.options, mode: 'verify' });
    const tracker = f.git['readyTrackers'].get('a.json')!;
    const original = tracker.predict.bind(tracker);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    jest.spyOn(tracker, 'predict').mockImplementationOnce(async () => {
      const result = await original();
      entered();
      await gate;
      return result;
    });
    const pending = f.git.provenance(f.options);
    await started;
    const end = f.git.beginProvenanceMutation();
    const before = f.statusCalls();
    release();
    await pending;
    await f.git.provenance(f.options);
    expect(f.statusCalls()).toBe(before + 2);
    expect(tracker.baselineHead()).toBeUndefined();
    end();
    await f.git.provenance(f.options);
    await f.git['trackerPreparation'].get('a.json');
    expect(tracker.baselineHead()).toBeTruthy();
    await f.git.commit({ message: 'commit edit', paths: ['a.json'] });
    expect(tracker.baselineHead()).toBeUndefined();
    const current = await f.git.provenance(f.options);
    expect(current.dirty).toBe(false);
    expect(current.head).toBe(await f.git.head());
    f.git.stopProvenanceVerification();
    const stopped = f.statusCalls();
    await f.git.provenance(f.options);
    expect(f.statusCalls()).toBe(stopped + 1);
    expect(f.git['readyTrackers'].size).toBe(0);
  } finally {
    await f.close();
  }
});

it('disables the fast path for the instance after a sampled mismatch', async () => {
  const f = await fixture();
  try {
    await f.prime();
    const tracker = f.git['readyTrackers'].get('a.json')!;
    const sample = await tracker.predict();
    jest
      .spyOn(tracker, 'predict')
      .mockResolvedValue({ ...sample, prediction: { head: 'wrong', dirty: true } });
    const result = await f.git.provenance({ ...f.options, verifyEvery: 1 });
    expect(result.head).toBe(await f.git.head());
    expect(f.git.provenanceVerification().at(-1)?.result).toBe('mismatch');
    const before = f.statusCalls();
    await f.git.provenance(f.options);
    expect(f.statusCalls()).toBe(before + 1);
  } finally {
    await f.close();
  }
});
