/**
 * `collectProject` and `applyCollection` over a project the mock pipeline has run. Each test works
 * on its own copy of one run, so the run is paid for once.
 */
import { cp, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeProject, TestProject } from '@vn/testkit';
import { addClaim, AssetStore, loadInputs, readClaims, removeClaim } from '@vn/store';
import { latestRecords, logTombstone } from '@vn/taskgraph';
import { exists } from '@vn/util';

import { GenImageFile, Graph, registerGenNodes } from '../index.js';
import { writeGraphDoc } from '../document.js';
import { graphBlobDir, graphJournalFile } from '../paths.js';
import { validateProject } from '../projectcheck.js';
import {
  applyCollection,
  collectProject,
  collectsNothing,
  describeCollection,
  unreadInputs,
  type CollectionPlan,
} from '../collect.js';

registerGenNodes();

let built: TestProject;
let p: TestProject;

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
  const dir = await mkdtemp(join(tmpdir(), 'vn-collect-'));
  await cp(built.dir, dir, { recursive: true });
  p = new TestProject(dir);
});

afterEach(async () => {
  await p.cleanup();
});

async function plan(): Promise<CollectionPlan> {
  const { model, config } = await p.reload();
  return collectProject({ root: p.dir, model, config });
}

/** Applies a plan the way `vnauthor` does: what goes is deleted. */
function apply(planned: CollectionPlan) {
  return applyCollection(p.dir, planned, async (path) => {
    await rm(join(p.dir, path), { recursive: true, force: true });
    return true;
  });
}

/** The scene whose frames the run drew first, and the hashes of those frames. */
async function framesOfAScene(): Promise<{ sceneId: string; hashes: string[] }> {
  const store = await AssetStore.open(p.paths);
  const frame = store.manifest().find((a) => a.kind === 'shot_image');
  const sceneId = frame?.satisfies.find((b) => b.sceneId)?.sceneId;
  if (!sceneId) throw new Error('the run drew no shot');
  const hashes = store
    .manifest()
    .filter((a) => a.satisfies.some((b) => b.sceneId === sceneId))
    .map((a) => a.hash);
  return { sceneId, hashes };
}

describe('collectProject and the claims ledger', () => {
  /** A base picture this project made and nothing uses. */
  async function unusedBasePicture(): Promise<string> {
    const [task] = (await latestRecords(p.paths)).keys();
    const store = await AssetStore.open(p.paths);
    const row = await store.write(new TextEncoder().encode('plate'), 'png', {
      kind      : 'location_ref',
      sourceTask: task!,
      modelId   : 'mock',
    });
    return row.hash;
  }

  it('keeps a picture another project claims, and drops this project’s own claim on one', async () => {
    const hash = await unusedBasePicture();
    const { model, config } = await p.reload();
    const collect = (id?: string) =>
      collectProject({
        root: p.dir,
        model,
        config: id === undefined ? config : { ...config, project_id: id },
      });
    expect((await collect()).assets.rows.base.map((r) => r.hash)).toEqual([hash]);

    await addClaim(p.paths, hash, 'other');
    expect((await collect('me')).assets.rows.base).toEqual([]);
    expect((await collect('me')).assets.released).toEqual([]);

    await removeClaim(p.paths, hash, 'other');
    await addClaim(p.paths, hash, 'me');
    const planned = await collect('me');
    expect(planned.assets.rows.base.map((r) => r.hash)).toEqual([hash]);
    expect(planned.assets.released).toEqual([hash]);
    const applied = await apply(planned);
    expect(applied.released).toEqual([`assets/claims/${hash}/me`]);
    expect(await readClaims(p.paths)).toEqual(new Map());
  });
});
describe('collectProject', () => {
  it('finds nothing to collect in a project the pipeline has just run', async () => {
    const planned = await plan();
    expect(collectsNothing(planned)).toBe(true);
    expect(describeCollection(planned, { uncommitted: 0 })).toMatch(/^Nothing to collect/);
  });

  it('removes the frames of a storyboard that is gone, and keeps an upload', async () => {
    const { sceneId, hashes } = await framesOfAScene();
    const store = await AssetStore.open(p.paths);
    const upload = await store.write(new TextEncoder().encode('ref'), 'png', {
      kind      : 'reference',
      sourceTask: 'upload',
      modelId   : 'none',
    });
    await unlink(p.paths.shotsFile(sceneId));

    const planned = await plan();
    expect(planned.assets.rows.project.map((r) => r.hash).sort()).toEqual([...hashes].sort());
    expect(planned.assets.rows.base).toEqual([]);
    expect(planned.assets.tombstones.length).toBeGreaterThan(0);
    expect(describeCollection(planned, { uncommitted: 2 }).split('\n')).toEqual([
      expect.stringMatching(new RegExp(`^Removes ${hashes.length} pictures? \\(`)),
      '2 pictures are in no commit, so git cannot bring them back.',
      `They are shots of ${sceneId} (${hashes.length}).`,
      expect.stringMatching(/^Also removes \d+ task records?\.$/),
      'A picture that is still wanted after this is planned again on the next run.',
    ]);

    const applied = await apply(planned);
    expect(applied.stuck).toEqual([]);
    const after = await AssetStore.open(p.paths);
    for (const hash of hashes) expect(after.has(hash)).toBe(false);
    expect(after.has(upload.hash)).toBe(true);
    const latest = await latestRecords(p.paths);
    for (const task of planned.assets.tombstones) {
      expect(latest.get(task.hash)).toMatchObject({ removed: true });
    }

    const { model } = await p.reload();
    const findings = await validateProject({ root: p.dir, model });
    expect(findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    // The scene is storyboarded and drawn again, without reaching for a file that is gone
    await expect(p.run()).resolves.toBeDefined();
    expect(collectsNothing(await plan())).toBe(true);
  }, 60_000);

  it('finishes the job when a collection stopped after its tombstones', async () => {
    const { sceneId, hashes } = await framesOfAScene();
    await unlink(p.paths.shotsFile(sceneId));
    const first = await plan();
    for (const task of first.assets.tombstones) await logTombstone(p.paths, task);

    const second = await plan();
    expect(second.assets.rows.project.map((r) => r.hash).sort()).toEqual([...hashes].sort());
    await apply(second);
    const after = await AssetStore.open(p.paths);
    for (const hash of hashes) expect(after.has(hash)).toBe(false);
    for (const hash of hashes) {
      expect(await exists(join(p.paths.assetsDir, `${hash}.png`))).toBe(false);
    }
  });

  it('collects a file no manifest row lists', async () => {
    const stray = join(p.paths.assetsDir, `${'ab'.repeat(32)}.png`);
    await writeFile(stray, 'left behind');
    const planned = await plan();
    expect(planned.assets.files.map((f) => f.file)).toEqual([
      `vngen/build/assets/${'ab'.repeat(32)}.png`,
    ]);
    await apply(planned);
    expect(await exists(stray)).toBe(false);
  });

  it('keeps a picture another project made in a shared assets folder', async () => {
    const store = await AssetStore.open(p.paths);
    const theirs = await store.write(new TextEncoder().encode('theirs'), 'png', {
      kind      : 'portrait',
      sourceTask: 'f'.repeat(64),
      modelId   : 'm',
      satisfies : { characterId: 'someone_else' },
    });
    const planned = await plan();
    expect(planned.assets.rows.base.map((r) => r.hash)).not.toContain(theirs.hash);
    expect(collectsNothing(planned)).toBe(true);
  });

  it('removes the state of a deleted graph, and blobs no record of a live graph names', async () => {
    const orphan = graphBlobDir(p.paths, 'gone');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, `${'cd'.repeat(32)}.png`), 'blob');
    await writeFile(graphJournalFile(p.paths, 'gone'), '{}\n');

    const graph = new Graph();
    graph.add(new GenImageFile());
    await writeGraphDoc(p.dir, 'kept', graph);
    const blobs = graphBlobDir(p.paths, 'kept');
    await mkdir(blobs, { recursive: true });
    await writeFile(join(blobs, `${'ef'.repeat(32)}.png`), 'blob');

    const planned = await plan();
    expect(planned.graphs.orphans.map((o) => [o.slug, o.paths.sort()])).toEqual([
      ['gone', ['vngen/state/graphs/gone', 'vngen/state/graphs/gone.jsonl']],
    ]);
    expect(planned.graphs.blobs.map((b) => b.file)).toEqual([
      `vngen/state/graphs/kept/${'ef'.repeat(32)}.png`,
    ]);
    expect(describeCollection(planned, { uncommitted: 0 })).toMatch(
      /^Removes the run history of 1 deleted graph \(gone\) and 1 graph intermediate no run record names \(/,
    );
    await apply(planned);
    expect(await exists(orphan)).toBe(false);
    expect(await readdir(blobs)).toEqual([]);
  });

  it('refuses over a sheet that does not load, since its entity would look unused', async () => {
    await writeFile(p.paths.characterFile('aiko'), '---\nname: [unclosed\n---\n');
    const { model } = await p.reload();
    const inputs = await loadInputs(p.paths);
    expect(unreadInputs([...inputs.diagnostics, ...model.diagnostics])).toMatch(
      /^Nothing was collected: \d+ input problems? means? what the project uses cannot be known/,
    );
  });
});
