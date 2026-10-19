/**
 * `asset.collect` over a project the mock pipeline has run, through a real `CommandStack` with an
 * undo journal: what it holds for undo, how undo and redo put it back and take it away again, and
 * the guards that refuse when the task log moved underneath it. Each test works on its own copy of
 * one run, so the run is paid for once.
 */
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandStack, type CommandOutcome } from '@vn/commands';
import { UndoJournal } from '@vn/commands/snapshot';
import { openGit } from '@vn/git';
import { AssetStore } from '@vn/store';
import { latestRecords, logTask, type TaskRecord } from '@vn/taskgraph';
import { makeProject, TestProject } from '@vn/testkit';
import type { AnyTask, Asset } from '@vn/types';
import { exists } from '@vn/util';
import { UNDO_EXCLUDES } from '../../shared/affects.js';
import { createDesktopRegistry, type CommandHost } from '../commands/index.js';
import { WorkspaceSession, type SessionDeps } from '../session.js';
import { clearHeldCollections, COLLECTED_DIR } from '../workspace/workspace.js';

const deps: SessionDeps = {
  emitEvent     : () => {},
  emitReport    : () => {},
  requestPlan   : () => Promise.resolve({ approved: false }),
  requestAnswer : () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy      : () => {},
};

let built: TestProject;
let p: TestProject;
let stack: CommandStack<CommandHost>;
let session: WorkspaceSession;

beforeAll(async () => {
  built = await makeProject();
  await built.run();
  await built.approveAll();
  await built.run();
}, 60_000);

afterAll(async () => {
  await built.cleanup();
});

beforeEach(async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vn-collect-')));
  await cp(built.dir, dir, { recursive: true });
  p = new TestProject(dir);
  session = new WorkspaceSession(dir, true, deps);
  const host = { session, ui: () => {}, uiAll: () => {} } as unknown as CommandHost;
  stack = new CommandStack<CommandHost>({
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
});

afterEach(async () => {
  await p.cleanup();
});

const run = async (id: string, props: Record<string, unknown> = {}): Promise<CommandOutcome> => {
  const outcome = await stack.exec(id, props, 'ui');
  if (!outcome.ok) throw new Error(`${id} refused: ${outcome.error}`);
  return outcome;
};

/** Reads both manifests' rows by hash, and each task's latest record, as the project holds now. */
async function state(): Promise<{ rows: Map<string, Asset>; tasks: Map<string, TaskRecord> }> {
  const read = async (file: string): Promise<Asset[]> =>
    (await exists(file))
      ? (JSON.parse(await readFile(file, 'utf8')) as { assets: Asset[] }).assets
      : [];
  const rows = new Map<string, Asset>();
  for (const row of await read(p.paths.baseManifest)) rows.set(`base:${row.hash}`, row);
  for (const row of await read(p.paths.manifest)) rows.set(`project:${row.hash}`, row);
  return { rows, tasks: await latestRecords(p.paths) };
}

/** Each task that was done before is done again with the same output. */
function sameWork(before: Map<string, TaskRecord>, after: Map<string, TaskRecord>): void {
  for (const [hash, task] of before) {
    if (task.status !== 'done') continue;
    expect([hash, after.get(hash)?.status, after.get(hash)?.output]).toEqual([
      hash,
      'done',
      task.output,
    ]);
  }
}

async function noBlocking(): Promise<void> {
  const blocking = (await session.validateProject()).filter((f) => f.severity === 'blocking');
  expect(blocking).toEqual([]);
}

const holdOf = (outcome: CommandOutcome): string => {
  const hold = outcome.ok ? outcome.record.sidecar : undefined;
  if (!hold) throw new Error('the collection held nothing for undo');
  return hold;
};

async function heldPlan(hold: string): Promise<{ tombstones: AnyTask[]; moved: string[] }> {
  return JSON.parse(await readFile(join(p.dir, COLLECTED_DIR, hold, 'plan.json'), 'utf8')) as {
    tombstones: AnyTask[];
    moved: string[];
  };
}

describe('asset.collect after deleting a character', () => {
  it('is undone back to the full project, and redone again', async () => {
    const before = await state();
    await run('character.delete', { character: 'haruki', lines: 'narrate', mergeInto: '' });
    const collected = await run('asset.collect');
    const hold = holdOf(collected);
    const { moved } = await heldPlan(hold);
    const pictures = moved.filter((m) => m.endsWith('.png'));
    expect(pictures.length).toBeGreaterThan(0);
    for (const path of pictures) expect(await exists(join(p.dir, path))).toBe(false);
    const gone = await state();
    const haruki = [...before.rows].filter(([, r]) =>
      r.satisfies.some((b) => b.characterId === 'haruki'),
    );
    const removed = [...before.rows.keys()].filter((key) => !gone.rows.has(key));
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((key) => haruki.some(([k]) => k === key))).toBe(true);
    // What stays is named in the refs of a take the collector keeps, such as a frame drawn from it
    const refd = new Set([...gone.rows.values()].flatMap((r) => r.refs));
    for (const [key, row] of haruki) {
      if (gone.rows.has(key)) expect(refd.has(row.hash)).toBe(true);
    }

    await stack.undo();
    await stack.undo();
    const back = await state();
    expect([...back.rows.keys()].sort()).toEqual([...before.rows.keys()].sort());
    for (const [key, row] of before.rows) expect(back.rows.get(key)).toEqual(row);
    sameWork(before.tasks, back.tasks);
    for (const path of pictures) expect(await exists(join(p.dir, path))).toBe(true);
    expect(await exists(p.paths.characterFile('haruki'))).toBe(true);
    await noBlocking();
    expect((await p.run()).ran).toEqual([]);

    await stack.redo();
    await stack.redo();
    const again = await state();
    expect([...again.rows.keys()].sort()).toEqual([...gone.rows.keys()].sort());
    for (const path of pictures) expect(await exists(join(p.dir, path))).toBe(false);
    expect(await exists(p.paths.characterFile('haruki'))).toBe(false);
  }, 120_000);
});

describe('asset.collect after deleting a scene', () => {
  const deleteScene = () => run('story.deleteScene', { scene: 'good_end', edges: 'cut' });

  it('puts the frames back with one undo, and the scene with the next', async () => {
    const before = await state();
    await deleteScene();
    const collected = await run('asset.collect');
    // Only project-root frames went, which no snapshot holds
    expect(collected.ok && collected.record.undo).toMatchObject({ changed: false });
    const frames = [...before.rows].filter(([, r]) =>
      r.satisfies.some((b) => b.sceneId === 'good_end'),
    );
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(([key]) => key.startsWith('project:'))).toBe(true);
    for (const [key] of frames) expect((await state()).rows.has(key)).toBe(false);

    await stack.undo();
    const back = await state();
    for (const [key, row] of frames) expect(back.rows.get(key)).toEqual(row);
    expect(await exists(p.paths.shotsFile('good_end'))).toBe(false);
    await stack.undo();
    expect(await exists(p.paths.shotsFile('good_end'))).toBe(true);
    sameWork(before.tasks, (await state()).tasks);
    await noBlocking();
  });

  it('refuses to undo once a tombstoned task was written again', async () => {
    await deleteScene();
    const hold = holdOf(await run('asset.collect'));
    const [task] = (await heldPlan(hold)).tombstones;
    await logTask(p.paths, { ...task!, status: 'pending', output: undefined, attempts: [] });

    const outcome = await stack.undo();
    expect(outcome).toMatchObject({ ok: false });
    expect(!outcome.ok && outcome.error).toMatch(/was written again since the collection/);
    for (const path of (await heldPlan(hold)).moved) {
      expect(await exists(join(p.dir, COLLECTED_DIR, hold, path))).toBe(true);
    }
  });

  it('refuses to redo once a restored task was written again', async () => {
    await deleteScene();
    const hold = holdOf(await run('asset.collect'));
    await stack.undo();
    const [task] = (await heldPlan(hold)).tombstones;
    await logTask(p.paths, { ...task!, status: 'pending', output: undefined, attempts: [] });

    const outcome = await stack.redo();
    expect(!outcome.ok && outcome.error).toMatch(/was written again since the collection/);
  });

  it('is not undone by a store opened before it writing afterwards', async () => {
    await deleteScene();
    const stale = await AssetStore.open(p.paths);
    const kept = stale.manifest().find((a) => !a.satisfies.some((b) => b.sceneId === 'good_end'));
    await run('asset.collect');
    await stale.accept(kept!.hash);
    const rows = (await state()).rows;
    expect([...rows.values()].some((r) => r.satisfies.some((b) => b.sceneId === 'good_end'))).toBe(
      false,
    );
  });

  it('with keepForUndo off, deletes at once and leaves Undo naming it', async () => {
    await deleteScene();
    const outcome = await run('asset.collect', { keepForUndo: false });
    expect(outcome.ok && outcome.record.undo).toBeUndefined();
    expect(outcome.ok && outcome.record.sidecar).toBeUndefined();
    expect(await exists(join(p.dir, COLLECTED_DIR))).toBe(false);
    expect(stack.undoState()).toMatchObject({
      undoLabel: null,
      blocked  : expect.stringMatching(/^asset\.collect\(/),
    });
  });

  it('says what it would remove, and how long undo can bring it back', async () => {
    await deleteScene();
    const check = await stack.check('asset.collect', {});
    expect(check).toMatchObject({ state: 'accept' });
    const lines = check.state === 'accept' ? check.message.split('\n') : [];
    expect(lines[0]).toMatch(/^Removes \d+ pictures? \(.*\) that nothing in the project uses\.$/);
    expect(lines).toEqual(
      expect.arrayContaining([expect.stringMatching(/^They are shots of good_end \(\d+\)\.$/)]),
    );
    expect(lines.at(-1)).toMatch(/^Undo brings all of it back until the next command/);
  });
});

describe('held collections', () => {
  it('are deleted when the app opens the project again', async () => {
    const leftover = join(p.dir, COLLECTED_DIR, 'abc123');
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, 'plan.json'), '{}');
    await clearHeldCollections(p.dir);
    expect(await exists(join(p.dir, COLLECTED_DIR))).toBe(false);
  });
});
