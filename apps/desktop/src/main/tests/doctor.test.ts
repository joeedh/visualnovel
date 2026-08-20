/**
 * The startup doctor, and how a version is written down. Both are pure given their probe, which
 * is why the probe is a parameter.
 */
import { checkGit, gitHealth, gitVersionOf, noteGitHealth } from '../doctor.js';
import { describeVersion } from '../version.js';

describe('checkGit', () => {
  it('reads the number out of what git printed', async () => {
    const health = await checkGit(async () => ({ code: 0, stdout: 'git version 2.45.1\n' }));
    expect(health).toEqual({ ok: true, version: '2.45.1' });
  });

  it('accepts a git it could not parse, because a git that ran is a git that works', async () => {
    const health = await checkGit(async () => ({ code: 0, stdout: 'git version (unreleased)\n' }));
    expect(health).toEqual({ ok: true });
  });

  it('counts a non-zero exit as absent', async () => {
    expect(await checkGit(async () => ({ code: 1, stdout: '' }))).toEqual({ ok: false });
  });

  // ENOENT arrives as a rejection rather than an exit code, and it is the case that actually
  // happens: git is not on PATH at all.
  it('counts a probe that throws as absent', async () => {
    expect(await checkGit(() => Promise.reject(new Error('spawn git ENOENT')))).toEqual({
      ok: false,
    });
  });
});

describe('gitVersionOf', () => {
  it('takes the first number and leaves the platform suffix', () => {
    expect(gitVersionOf('git version 2.45.1.windows.1')).toBe('2.45.1');
  });

  it('answers undefined rather than guessing', () => {
    expect(gitVersionOf('')).toBeUndefined();
  });
});

describe('describeVersion', () => {
  it('says only the version when packaged', () => {
    expect(describeVersion('0.1.0', { packaged: true, sha: 'abc1234' })).toBe('0.1.0');
  });

  it('carries the commit in a development build', () => {
    expect(describeVersion('0.1.0', { packaged: false, sha: 'abc1234' })).toBe(
      '0.1.0 (dev abc1234)',
    );
  });

  it('still says dev when there is no repository to ask', () => {
    expect(describeVersion('0.1.0', { packaged: false })).toBe('0.1.0 (dev)');
  });
});

describe('the recorded finding', () => {
  afterEach(() => noteGitHealth({ ok: true }));

  // Callers run after startup has checked, so the default has to be the harmless one: reporting
  // `false` before the probe ran would put the app in read-only mode on a machine that has git.
  it('reads ok until told otherwise', () => {
    expect(gitHealth()).toEqual({ ok: true });
  });

  it('is what checkGit last found, once it is written down', async () => {
    noteGitHealth(await checkGit(async () => ({ code: 1, stdout: '' })));
    expect(gitHealth().ok).toBe(false);
  });

  // `checkGit` and `noteGitHealth` are separate so that a `checkGit` call in one test does not
  // leave its answer behind.
  it('is not moved by checkGit alone', async () => {
    await checkGit(async () => ({ code: 1, stdout: '' }));
    expect(gitHealth()).toEqual({ ok: true });
  });
});
