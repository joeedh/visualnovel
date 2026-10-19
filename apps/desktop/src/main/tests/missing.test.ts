/**
 * The missing-picture check, `asset.recover` and `asset.forget`, over a project the mock pipeline
 * has run, in real git repositories: a delete taken back after the collection that removed its art,
 * and two projects sharing one `assets/` repository, where a claim keeps what the other uses.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandStack, type CommandOutcome } from '@vn/commands';
import { UndoJournal } from '@vn/commands/snapshot';
import { loadConfig } from '@vn/config';
import { openGit } from '@vn/git';
import { AssetStore, readClaims } from '@vn/store';
import { latestRecords } from '@vn/taskgraph';
import { makeProject, TestProject } from '@vn/testkit';
import { exists, readText } from '@vn/util';
import { UNDO_EXCLUDES } from '../../shared/affects.js';
import { createDesktopRegistry, type CommandHost } from '../commands/index.js';
import { WorkspaceSession, type SessionDeps } from '../session.js';

const deps: SessionDeps = {
  emitEvent     : () => {},
  emitReport    : () => {},
  requestPlan   : () => Promise.resolve({ approved: false }),
  requestAnswer : () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy      : () => {},
};

let built: TestProject;
const made: string[] = [];

beforeAll(async () => {
  built = await makeProject();
  await built.run();
  await built.approveAll();
  await built.run();
}, 60_000);

afterAll(async () => {
  await built.cleanup();
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** Runs git in `cwd` with an identity of its own, answering what it printed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** Commits everything in `cwd`, answering the new `HEAD`. */
function commit(cwd: string, message: string): string {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '--allow-empty', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

async function copyOfBuilt(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vn-missing-')));
  made.push(dir);
  await cp(built.dir, dir, { recursive: true });
  return dir;
}

/** Opens a session and a command stack over `dir`, with a `run` that throws on a refusal. */
function open(dir: string) {
  const session = new WorkspaceSession(dir, true, deps);
  const host = { session, ui: () => {}, uiAll: () => {} } as unknown as CommandHost;
  const stack = new CommandStack<CommandHost>({
    registry: createDesktopRegistry(),
    context: {
      root: dir,
      git : openGit(dir),
      host,
      log    : () => {},
      confirm: () => Promise.resolve(true),
    },
    journal : new UndoJournal({ root: dir, exclude: UNDO_EXCLUDES }),
  });
  const run = async (id: string, props: Record<string, unknown> = {}): Promise<CommandOutcome> => {
    const outcome = await stack.exec(id, props, 'ui');
    if (!outcome.ok) throw new Error(`${id} refused: ${outcome.error}`);
    return outcome;
  };
  return { session, stack, run, p: new TestProject(dir) };
}

const writtenOf = (outcome: CommandOutcome): string[] =>
  outcome.ok ? (outcome.record.written ?? []) : [];

/**
 * Deletes haruki and the one scene he is drawn in, so no kept frame was drawn from his portrait,
 * collects with nothing held, then takes back the delete's commit: his sheet names the portrait
 * again, which the collection's commit removed.
 */
async function deleteCollectTakeBack(
  dir: string,
  run: (id: string, props?: Record<string, unknown>) => Promise<CommandOutcome>,
): Promise<void> {
  await run('story.deleteScene', { scene: 'rooftop', edges: 'cut' });
  await run('character.delete', { character: 'haruki', lines: 'narrate', mergeInto: '' });
  const deleted = commit(dir, 'Delete haruki and the rooftop');
  await run('asset.collect', { keepForUndo: false });
  commit(dir, 'Collect');
  git(dir, 'revert', '--no-edit', deleted);
}

describe('a delete taken back after the collection that removed its art', () => {
  it('finds the portrait missing, and Recover brings it back so a run does not draw it', async () => {
    const dir = await copyOfBuilt();
    git(dir, 'init', '-q');
    commit(dir, 'Run');
    const { session, run, p } = open(dir);
    const portrait = (await p.reload()).model.characters.get('haruki')!.approvedPortrait!;

    await deleteCollectTakeBack(dir, run);
    expect((await AssetStore.open(p.paths)).has(portrait)).toBe(false);

    const report = await session.missingPart.check();
    const found = report.pictures.find((picture) => picture.hash === portrait);
    expect(found).toMatchObject({ label: 'haruki portrait' });
    expect(found?.unrecoverable).toBeUndefined();
    expect(found?.referrers).toEqual(expect.arrayContaining(['character haruki']));

    for (const picture of report.pictures) {
      const outcome = await run('asset.recover', { hash: picture.hash });
      for (const path of writtenOf(outcome)) {
        expect(path).toMatch(/^(assets\/|vngen\/build\/|vngen\/state\/|project\.yaml$)/);
      }
    }
    expect(session.missingPart.report.pictures).toEqual([]);
    const records = await latestRecords(p.paths);
    const portraitTask = [...records.values()].find((r) => r.output === portrait);
    expect(portraitTask).toMatchObject({ status: 'done', restored: expect.any(String) });
    const ran = (await p.run()).ran;
    expect(ran.filter((task) => task.kind === 'portrait')).toEqual([]);
  }, 120_000);

  it('Forget drops the references instead, and the check finds nothing after it', async () => {
    const dir = await copyOfBuilt();
    git(dir, 'init', '-q');
    commit(dir, 'Run');
    const { session, run, p } = open(dir);
    const portrait = (await p.reload()).model.characters.get('haruki')!.approvedPortrait!;
    await deleteCollectTakeBack(dir, run);

    for (const picture of (await session.missingPart.check()).pictures) {
      const outcome = await run('asset.forget', { hash: picture.hash });
      for (const path of writtenOf(outcome)) {
        expect(path).toMatch(/^(characters|locations|wiki|assets|vngen)\//);
      }
    }
    expect(session.missingPart.report.pictures).toEqual([]);
    expect((await p.reload()).model.characters.get('haruki')?.approvedPortrait).toBeUndefined();
    expect(await readText(p.paths.characterFile('haruki'))).not.toContain(portrait);
  }, 120_000);

  it('names the picture git history does not hold, and refuses to recover it', async () => {
    const dir = await copyOfBuilt();
    const { session, stack, p } = open(dir);
    git(dir, 'init', '-q');
    commit(dir, 'Run');
    const store = await AssetStore.open(p.paths);
    const row = store.manifest().find((a) => a.kind === 'portrait')!;
    await rm(store.pathOf(row));

    const report = await session.missingPart.check();
    const found = report.pictures.find((picture) => picture.hash === row.hash);
    expect(found?.unrecoverable).toMatch(/is not in git history, so it cannot be recovered/);
    expect(await stack.check('asset.recover', { hash: row.hash })).toMatchObject({
      state  : 'refuse',
      message: expect.stringMatching(/is not in git history/),
    });
  }, 60_000);
});

describe('two projects sharing one assets repository', () => {
  it('keeps a plate one project collected while the other claims it', async () => {
    const a = await copyOfBuilt();
    git(join(a, 'assets'), 'init', '-q');
    commit(join(a, 'assets'), 'Base art');
    await writeFile(join(a, '.gitignore'), 'assets/\n');
    git(a, 'init', '-q');
    commit(a, 'Run');

    const b = await copyOfBuilt();
    await rm(join(b, 'assets'), { recursive: true, force: true });
    git(b, 'clone', '-q', join(a, 'assets'), 'assets');
    await writeFile(join(b, '.gitignore'), 'assets/\n');
    git(b, 'init', '-q');
    commit(b, 'Run');

    const A = open(a);
    const B = open(b);
    const plates = (await AssetStore.open(A.p.paths))
      .manifest()
      .filter(
        (row) => row.kind === 'location_ref' && row.satisfies.some((s) => s.locationId === 'hall'),
      );
    expect(plates.length).toBeGreaterThan(0);

    // bad_end is the hall's only scene, so once it goes no kept frame was drawn from the plate
    await A.run('story.deleteScene', { scene: 'bad_end', edges: 'cut' });
    await A.run('location.delete', { location: 'hall', replaceWith: '' });
    await A.run('asset.collect', { keepForUndo: false });
    commit(join(a, 'assets'), 'Collect');
    commit(a, 'Collect');
    git(join(b, 'assets'), 'pull', '-q', '--rebase', 'origin', 'HEAD');

    const missing = (await B.session.missingPart.check()).pictures;
    for (const plate of plates) expect(missing.map((m) => m.hash)).toContain(plate.hash);
    for (const plate of plates) await B.run('asset.recover', { hash: plate.hash });
    const id = (await loadConfig(b)).project_id!;
    const claims = await readClaims(B.p.paths);
    for (const plate of plates) expect(claims.get(plate.hash)).toEqual(new Set([id]));
    commit(join(b, 'assets'), 'Recover');

    git(join(a, 'assets'), 'pull', '-q', '--rebase', join(b, 'assets'), 'HEAD');
    await A.run('asset.collect', { keepForUndo: false });
    const names = await readdir(A.p.paths.baseObjects);
    for (const plate of plates) {
      expect(names).toContain(`${plate.hash}.${plate.ext}`);
      expect((await AssetStore.open(A.p.paths)).has(plate.hash)).toBe(true);
    }
    expect(await exists(join(a, 'assets', 'claims'))).toBe(true);
  }, 180_000);
});
