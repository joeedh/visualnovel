/**
 * Where a model key goes, and what the app is willing to say about one it did not write.
 *
 * The invariant under test is the same in both halves: a key value reaches exactly one file and
 * nothing else. Every message, every status row and every recorded property is checked for the
 * string that was pasted, because the interesting failure here is not a wrong answer — it is a
 * right answer with the secret in it.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { makeProject, SCRIPTS, type TestProject } from '@vn/testkit';
import { userKeysDir } from '@vn/config';
import { WorkspaceSession, describeKeySource, type SessionDeps } from '../session.js';

const deps: SessionDeps = {
  emitEvent: () => {},
  requestPlan: () => Promise.resolve({ approved: false }),
  requestAnswer: () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy: () => {},
};

const SECRET = 'sk-not-a-real-key-0123456789';

describe('project.setKey — the two scopes', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeEach(async () => {
    p = await makeProject({ script: SCRIPTS.linear });
    session = new WorkspaceSession(p.dir, true, deps);
  });

  afterEach(async () => {
    await p.cleanup();
  });

  it("writes into the project's keys/ by default, and ignores it first", async () => {
    const result = await session.setKey('gemini', SECRET);
    expect(result.ok).toBe(true);
    expect(await fs.readFile(join(p.dir, 'keys', 'gemini.txt'), 'utf8')).toBe(`${SECRET}\n`);

    // The .gitignore is the one file reported as written: the key file is ignored, so nothing
    // downstream may treat it as a document.
    expect(result.written).toEqual(['.gitignore']);
    expect(await fs.readFile(join(p.dir, '.gitignore'), 'utf8')).toMatch(/^keys$/m);
    expect(result.message).not.toContain(SECRET);
  });

  it('writes above the project when asked, and touches no .gitignore', async () => {
    // $VNAUTHOR_HOME is what jest already points somewhere empty; pointing it inside the project
    // keeps the write in a directory the fixture cleans up.
    const home = join(p.dir, 'userhome');
    process.env.VNAUTHOR_HOME = home;
    try {
      const result = await session.setKey('anthropic', SECRET, 'user');
      expect(result.ok).toBe(true);
      expect(await fs.readFile(join(home, 'keys', 'claude.txt'), 'utf8')).toBe(`${SECRET}\n`);
      // Nothing in the repository changed, because nothing in the repository is involved.
      expect(result.written).toEqual([]);
      expect(result.message).toContain('outside every repository');
      expect(result.message).not.toContain(SECRET);
    } finally {
      delete process.env.VNAUTHOR_HOME;
    }
  });

  it('refuses an empty key rather than writing an empty file', async () => {
    const result = await session.setKey('gemini', '   ');
    expect(result.ok).toBe(false);
    await expect(fs.access(join(p.dir, 'keys', 'gemini.txt'))).rejects.toThrow();
  });

  it('previewKey says where it would go and how far it would reach, without writing', async () => {
    const project = await session.previewKey('gemini', 'project');
    expect(project.message).toContain('keys/gemini.txt');
    expect(project.message).toContain('This project reads it.');

    const user = await session.previewKey('gemini', 'user');
    expect(user.message).toContain('Every project on this machine');
    await expect(fs.access(join(p.dir, 'keys', 'gemini.txt'))).rejects.toThrow();
  });

  it('says so when an environment variable would shadow the file it is about to write', async () => {
    process.env.GEMINI_API_KEY = 'from-the-shell';
    try {
      const preview = await session.previewKey('gemini');
      expect(preview.message).toContain('$GEMINI_API_KEY is set and is read first');
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });
});

describe('project.keyStatus', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeEach(async () => {
    p = await makeProject({ script: SCRIPTS.linear });
    session = new WorkspaceSession(p.dir, true, deps);
  });

  afterEach(async () => {
    await p.cleanup();
  });

  it('reports a vendor with no key, in KEY_VENDORS order', async () => {
    const view = await session.keyStatusView();
    expect(view.vendors.map((v) => v.vendor)).toEqual(['gemini', 'anthropic']);
    for (const vendor of view.vendors) {
      expect(vendor.resolved).toBe(false);
      expect(vendor.source).toBe('Not set.');
      expect(vendor.writesTo.project).toMatch(/^keys\//);
    }
    expect(view.userKeysDir).toBe(userKeysDir());
  });

  it('names the project as the source after a project-scoped write, and never the key', async () => {
    await session.setKey('gemini', SECRET);
    const view = await session.keyStatusView();
    const gemini = view.vendors.find((v) => v.vendor === 'gemini')!;
    expect(gemini.resolved).toBe(true);
    expect(gemini.source).toContain('in this project');
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it('names the environment variable, and flags it as a shadow', async () => {
    await session.setKey('gemini', SECRET);
    process.env.GEMINI_API_KEY = 'from-the-shell';
    try {
      const view = await session.keyStatusView();
      const gemini = view.vendors.find((v) => v.vendor === 'gemini')!;
      // The variable is read before every file, so it is both the source and the reason the file
      // the author just wrote is doing nothing.
      expect(gemini.source).toBe('From $GEMINI_API_KEY.');
      expect(gemini.envShadow).toBe(true);
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });
});

/**
 * The refusal, not the call. `testKey` itself makes a real request and so is not something a test
 * suite may run; what is testable — and what the Setup pane's greyed-out button shows — is the
 * sentence that says why there is nothing to try.
 */
describe('project.testKey — what it says before it calls', () => {
  let p: TestProject;

  beforeEach(async () => {
    p = await makeProject({ script: SCRIPTS.linear });
  });

  afterEach(async () => {
    await p.cleanup();
  });

  it('refuses under --mock, because a mock run calls no provider', async () => {
    const session = new WorkspaceSession(p.dir, true, deps);
    const verdict = await session.previewTestKey('gemini');
    expect(verdict).toEqual({ ok: false, message: expect.stringContaining('Mock mode') });
    // And the call itself is the same answer, so a palette invocation cannot get further.
    expect((await session.testKey('gemini')).message).toContain('Mock mode');
  });

  it('refuses when no key resolves, naming the vendor', async () => {
    const session = new WorkspaceSession(p.dir, false, deps);
    const verdict = await session.previewTestKey('anthropic');
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('anthropic');
  });

  it('accepts once a key resolves, and does not repeat it', async () => {
    const session = new WorkspaceSession(p.dir, false, deps);
    await session.setKey('gemini', SECRET);
    const verdict = await session.previewTestKey('gemini');
    expect(verdict.ok).toBe(true);
    expect(verdict.message).not.toContain(SECRET);
  });
});

describe('describeKeySource', () => {
  const dir = join('/tmp', 'a-project');

  it('distinguishes the four rungs', () => {
    expect(describeKeySource(dir, undefined)).toBe('Not set.');

    expect(
      describeKeySource(dir, {
        vendor: 'gemini',
        resolved: true,
        source: { kind: 'env', name: 'GEMINI_API_KEY' },
        envName: 'GEMINI_API_KEY',
        envShadow: true,
      }),
    ).toBe('From $GEMINI_API_KEY.');

    expect(
      describeKeySource(dir, {
        vendor: 'gemini',
        resolved: true,
        source: { kind: 'file', dir: join(dir, 'keys'), file: 'gemini.txt' },
        envName: 'GEMINI_API_KEY',
        envShadow: false,
      }),
    ).toBe('From keys/gemini.txt in this project.');

    // An enclosing repository's keys/ is outside the project, so it is named in full rather than
    // as a relative path climbing out of the workspace.
    const elsewhere = describeKeySource(dir, {
      vendor: 'gemini',
      resolved: true,
      source: { kind: 'file', dir: join('/tmp', 'keys'), file: 'gemini.txt' },
      envName: 'GEMINI_API_KEY',
      envShadow: false,
    });
    expect(elsewhere).toContain(join('/tmp', 'keys', 'gemini.txt'));
    expect(elsewhere).not.toContain('..');

    expect(
      describeKeySource(dir, {
        vendor: 'anthropic',
        resolved: true,
        source: { kind: 'file', dir: userKeysDir(), file: 'claude.txt' },
        envName: 'ANTHROPIC_API_KEY',
        envShadow: false,
      }),
    ).toContain('every project on this machine');
  });
});
