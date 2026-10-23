import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '../index.js';
import { RepositoryTracker } from '../tracker.js';
import nodeFs from 'node:fs';
import { EventEmitter } from 'node:events';

it.each(['setup', 'error', 'unnamed'] as const)(
  'identifies a watcher %s failure and keeps predictions disabled',
  async (failure) => {
    const watcher = Object.assign(new EventEmitter(), {
      close: jest.fn(),
      unref: jest.fn(),
      ref  : jest.fn(),
    });
    let listener!: nodeFs.WatchListener<string>;
    const spy = jest.spyOn(nodeFs, 'watch').mockImplementation(((...args: unknown[]) => {
      if (failure === 'setup') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      listener = args[2] as nodeFs.WatchListener<string>;
      return watcher;
    }) as typeof nodeFs.watch);
    let tracker: RepositoryTracker | undefined;
    try {
      tracker = new RepositoryTracker('/ws', '/ws', '/ws', 'shots.json', async () => null, []);
      if (failure === 'error')
        watcher.emit('error', Object.assign(new Error('watch failed'), { code: 'EPERM' }));
      if (failure === 'unnamed') {
        listener('rename', null);
      }
      const reason = {
        setup  : 'watcher setup failed: /ws (EACCES)',
        error  : 'watcher error: /ws (EPERM)',
        unnamed: 'watcher unnamed event: /ws (rename)',
      }[failure];
      expect(await tracker.predict()).toMatchObject({ prediction: null, reason });
      // A refreshed baseline cannot turn an unreliable watcher into a valid witness.
      tracker.setBaseline('abc', Buffer.from('baseline'));
      expect(await tracker.predict()).toMatchObject({ prediction: null, reason });
      tracker.close();
      expect(await tracker.predict()).toMatchObject({ prediction: null, reason: 'tracker closed' });
    } finally {
      tracker?.close();
      spy.mockRestore();
    }
  },
);

it.each(['success', 'unsupported', 'failure'] as const)(
  'coalesces concurrent %s audits and releases flights for retry',
  async (outcome) => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'vn-tracker-flight-'));
    const gitdir = join(dir, '.git');
    await fs.mkdir(gitdir);
    await fs.writeFile(join(gitdir, 'HEAD'), 'abc');
    await fs.writeFile(join(gitdir, 'index'), 'index');
    await fs.writeFile(join(dir, 'shots.json'), 'edit');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let audits = 0;
    const tracker = new RepositoryTracker(
      dir,
      gitdir,
      gitdir,
      'shots.json',
      async () => {
        audits++;
        await gate;
        if (outcome === 'failure') throw new Error('audit failed');
        return outcome === 'unsupported' ? 'unsupported test state' : null;
      },
      [],
    );
    try {
      tracker.setBaseline('abc', Buffer.from('baseline'));
      const pending = Promise.all(Array.from({ length: 4 }, () => tracker.predict()));
      const deadline = Date.now() + 5000;
      while ([...tracker['guardFlights'].values()][0]?.users !== 4 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect([...tracker['guardFlights'].values()][0]?.users).toBe(4);
      release();
      const results = await pending;
      expect(audits).toBe(1);
      expect(results.filter((s) => s.guardAuditShared)).toHaveLength(3);
      expect(tracker['guardFlights'].size).toBe(0);
      expect(
        results.every(
          (s) =>
            s.reason ===
            (outcome === 'success'
              ? 'dirty witness'
              : outcome === 'unsupported'
                ? 'unsupported test state'
                : 'unreadable state'),
        ),
      ).toBe(true);
      await tracker.predict();
      expect(audits).toBe(outcome === 'success' ? 1 : 2);
    } finally {
      release();
      tracker.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

it('invalidates dependency races, separates changed audit flights, and detects same-time content changes', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-tracker-flight-change-'));
  const gitdir = join(dir, '.git');
  await fs.mkdir(gitdir);
  await fs.writeFile(join(gitdir, 'HEAD'), 'abc');
  await fs.writeFile(join(gitdir, 'index'), 'index');
  await fs.writeFile(join(dir, 'shots.json'), 'edit');
  const dependency = `${dir}-config`;
  await fs.writeFile(dependency, 'one');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let audits = 0;
  const tracker = new RepositoryTracker(
    dir,
    gitdir,
    gitdir,
    'shots.json',
    async () => {
      audits++;
      if (audits === 1) await fs.writeFile(dependency, 'two');
      if (audits === 3) {
        entered();
        await gate;
      }
      return null;
    },
    [dependency],
  );
  try {
    tracker.setBaseline('abc', Buffer.from('baseline'));
    // A raced audit cannot populate an otherwise empty cache.
    expect((await tracker.predict()).reason).toBe('changed during check');
    expect((await tracker.predict()).guardCacheHit).toBe(false);
    expect((await tracker.predict()).guardCacheHit).toBe(true);
    expect(audits).toBe(2);
    // A second caller with different bytes must not join the blocked audit.
    await fs.writeFile(dependency, 'new');
    const first = tracker.predict();
    await started;
    await fs.writeFile(dependency, 'six');
    const second = await tracker.predict();
    expect(second.guardAuditShared).toBe(false);
    expect(second.reason).toBe('dirty witness');
    expect(audits).toBe(4);
    release();
    expect((await first).reason).toBe('changed during check');
    expect((await tracker.predict()).guardCacheHit).toBe(true);
    // Outside the watch roots, identical size/mtime still cannot hide changed bytes.
    const previous = await fs.stat(dependency);
    await fs.writeFile(dependency, 'ten');
    await fs.utimes(dependency, previous.atime, previous.mtime);
    expect((await tracker.predict()).guardCacheHit).toBe(false);
    expect(audits).toBe(5);
  } finally {
    release();
    tracker.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(dependency, { force: true });
  }
});

it('verifies predictions through external edits, staging, commits, branch changes and an unsafe index flag', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-tracker-'));
  const git = openGit(dir);
  const external = (args: string[]) =>
    promisify(execFile)('git', args, { cwd: dir, windowsHide: true });
  try {
    await external(['init']);
    await external(['config', 'user.name', 'Tracker test']);
    await external(['config', 'user.email', 'tracker@example.com']);
    await external(['config', 'core.autocrlf', 'false']);
    await fs.writeFile(join(dir, 'shots.json'), 'baseline');
    await external(['add', '.']);
    await external(['commit', '-m', 'baseline']);
    await git.verifyProvenance('shots.json');
    await git.provenance(); // Establish baseline; no prediction can precede this.
    await fs.writeFile(join(dir, 'shots.json'), 'bubble edit');
    await git.provenance();
    await git.provenance(); // Allow queued filesystem events to settle.
    expect(git.provenanceVerification().at(-1)).toMatchObject({
      result       : 'agree',
      prediction   : { dirty: true },
      guardCacheHit: true,
      guardAuditMs : 0,
    });
    await external(['add', 'shots.json']);
    expect((await git.provenance()).dirty).toBe(true);
    expect(git.provenanceVerification().at(-1)?.guardCacheHit).toBe(false);
    await external(['commit', '-m', 'external commit']);
    expect((await git.provenance()).dirty).toBe(false);
    expect(git.provenanceVerification().at(-1)?.result).toBe('fallback');
    await external(['checkout', '--detach', 'HEAD~1']);
    expect((await git.provenance()).dirty).toBe(false);
    await external(['checkout', '-b', 'other']);
    await fs.writeFile(join(dir, 'unrelated.txt'), 'external');
    expect((await git.provenance()).dirty).toBe(true);
    expect(git.provenanceVerification().at(-1)?.prediction).toBeNull();
    await fs.rm(join(dir, 'unrelated.txt'));
    // Git deliberately hides this edit: the tracker must now refuse to predict.
    await external(['update-index', '--assume-unchanged', 'shots.json']);
    await fs.writeFile(join(dir, 'shots.json'), 'hidden external edit');
    await git.provenance();
    await git.provenance();
    expect(git.provenanceVerification().at(-1)?.result).toBe('fallback');
    expect(git.provenanceVerification().some((s) => s.result === 'mismatch')).toBe(false);
    expect((await git.provenance()).dirty).toBe(false);
    await external(['update-index', '--no-assume-unchanged', 'shots.json']);
    await external(['update-index', '--skip-worktree', 'shots.json']);
    await git.provenance();
    expect(git.provenanceVerification().at(-1)?.result).toBe('fallback');
    await external(['update-index', '--no-skip-worktree', 'shots.json']);
    await fs.writeFile(join(dir, '.gitattributes'), 'shots.json text eol=lf\n');
    await git.provenance();
    expect(git.provenanceVerification().at(-1)?.reason).toBe('file attributes or filters');
    await fs.rm(join(dir, '.gitattributes'));
    await git.provenance();
    await git.provenance();
    expect(git.provenanceVerification().at(-1)?.result).toBe('agree');
    await external(['config', 'core.autocrlf', 'true']);
    await git.provenance();
    expect(git.provenanceVerification().at(-1)?.reason).toBe('unsupported Git configuration');
    expect(git.provenanceVerification().at(-1)?.guardCacheHit).toBe(false);
    await external(['config', 'core.autocrlf', 'false']);
    await fs.writeFile(join(dir, '.git/MERGE_HEAD'), 'operation in progress');
    // Exercise the predictor directly through provenance: even if Git refuses the malformed
    // operation metadata, it cannot promote a tracker answer to authoritative provenance.
    await git.provenance();
    expect(git.provenanceVerification().at(-1)?.reason).toBe('repository operation: MERGE_HEAD');
    await fs.rm(join(dir, '.git/MERGE_HEAD'));
    await external(['reset', '--hard', 'HEAD']);
    await external(['rm', '--cached', 'shots.json']);
    await external(['add', '-N', 'shots.json']);
    await git.provenance();
    expect(git.provenanceVerification().at(-1)?.result).toBe('fallback');
    await external(['reset', '--hard', 'HEAD']);
    const linked = join(dir, 'linked');
    await external(['worktree', 'add', '--detach', linked, 'HEAD']);
    const linkedGit = openGit(linked);
    try {
      await linkedGit.verifyProvenance('shots.json');
      await linkedGit.provenance();
      await linkedGit.provenance();
      expect(linkedGit.provenanceVerification().at(-1)?.reason).toBe('linked worktree');
    } finally {
      linkedGit.stopProvenanceVerification();
    }
    await external(['worktree', 'remove', linked]);
    expect(git.provenanceVerification().some((s) => s.result === 'mismatch')).toBe(false);
  } finally {
    // Release the verification watchers by disabling the instance before deleting its temp repo.
    git.stopProvenanceVerification();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('invalidates cached guards for newly created global config and attributes, includes, and environment changes', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-tracker-cache-'));
  const git = openGit(dir);
  const external = (args: string[]) =>
    promisify(execFile)('git', args, { cwd: dir, windowsHide: true });
  const originalGlobal = process.env['GIT_CONFIG_GLOBAL'];
  const originalXdg = process.env['XDG_CONFIG_HOME'];
  const globalConfig = join(dir, 'global-config');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['XDG_CONFIG_HOME'] = join(dir, 'xdg');
  try {
    await external(['init']);
    await external(['config', 'user.name', 'Tracker test']);
    await external(['config', 'user.email', 'tracker@example.com']);
    await external(['config', 'core.autocrlf', 'false']);
    await fs.writeFile(join(dir, 'shots.json'), 'baseline');
    await external(['add', 'shots.json']);
    await external(['commit', '-m', 'baseline']);
    await git.verifyProvenance('shots.json');
    await git.provenance();
    await fs.writeFile(join(dir, 'shots.json'), 'edit');
    await git.provenance();
    await git.provenance();
    expect(git.provenanceVerification().at(-1)?.guardCacheHit).toBe(true);
    await fs.writeFile(globalConfig, '[core]\nignoreStat = true\n');
    await git.provenance();
    expect(git.provenanceVerification().at(-1)).toMatchObject({
      guardCacheHit: false,
      reason       : 'unsupported Git configuration',
    });
    await fs.writeFile(globalConfig, '');
    await git.provenance();
    await git.provenance();
    expect(git.provenanceVerification().at(-1)?.guardCacheHit).toBe(true);
    await fs.mkdir(join(dir, 'xdg/git'), { recursive: true });
    await fs.writeFile(join(dir, 'xdg/git/attributes'), 'shots.json text eol=lf\n');
    await git.provenance();
    expect(git.provenanceVerification().at(-1)).toMatchObject({
      guardCacheHit: false,
      reason       : 'file attributes or filters',
    });
    await fs.rm(join(dir, 'xdg/git/attributes'));
    await fs.writeFile(join(dir, 'included-config'), '');
    await external(['config', 'include.path', '../included-config']);
    await git.provenance();
    expect(git.provenanceVerification().at(-1)?.reason).toBe('unsupported Git configuration');
    await external(['config', '--unset', 'include.path']);
    await git.provenance();
    process.env['XDG_CONFIG_HOME'] = join(dir, 'different-xdg');
    await git.provenance();
    expect(git.provenanceVerification().at(-1)?.reason).toBe('environment changed');
    expect(git.provenanceVerification().some((s) => s.result === 'mismatch')).toBe(false);
  } finally {
    git.stopProvenanceVerification();
    if (originalGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = originalGlobal;
    if (originalXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = originalXdg;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
