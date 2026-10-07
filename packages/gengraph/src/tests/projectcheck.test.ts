/**
 * `validateProject` over a project the mock pipeline has run, damaged one way per test. Each test
 * works on its own copy of one run, so the run is paid for once.
 */
import { cp, mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { makeProject, TestProject } from '@vn/testkit';
import type { ProjectFinding } from '@vn/artgen';
import type { Asset } from '@vn/types';

import { GenImageFile, Graph, GroupDef, registerGenNodes } from '../index.js';
import { writeGraphDoc, writeGroupDef } from '../document.js';
import { validateProject } from '../projectcheck.js';

registerGenNodes();

const GONE = 'dead'.repeat(16);

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
  const dir = await mkdtemp(join(tmpdir(), 'vn-projectcheck-'));
  await cp(built.dir, dir, { recursive: true });
  p = new TestProject(dir);
});

afterEach(async () => {
  await p.cleanup();
});

async function check(): Promise<ProjectFinding[]> {
  const { model } = await p.reload();
  return validateProject({ root: p.dir, model });
}

const about = (findings: ProjectFinding[], hash: string): [string, string][] =>
  findings.filter((f) => f.hash === hash).map((f) => [f.severity, f.kind]);

interface ManifestFile {
  version: 1;
  assets: Asset[];
}

async function readManifest(): Promise<ManifestFile> {
  return JSON.parse(await readFile(p.paths.manifest, 'utf8')) as ManifestFile;
}

async function writeManifest(manifest: ManifestFile): Promise<void> {
  await writeFile(p.paths.manifest, JSON.stringify(manifest, null, 2));
}

/** A shot frame the run drew, from the project root's manifest. */
async function shotRow(): Promise<Asset> {
  const row = (await readManifest()).assets.find((a) => a.kind === 'shot_image' && a.current);
  if (!row) throw new Error('the run drew no shot');
  return row;
}

async function write(abs: string, text: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text);
}

describe('validateProject', () => {
  it('finds nothing in a project the pipeline has just run', async () => {
    expect(await check()).toEqual([]);
  });

  it('reports a deleted picture once for its task and once for its row', async () => {
    const row = await shotRow();
    await unlink(join(p.paths.assetsDir, `${row.hash}.${row.ext}`));
    const findings = await check();
    expect(about(findings, row.hash)).toEqual([
      ['blocking', 'missing-output'],
      ['blocking', 'missing-file'],
    ]);
    expect(findings.find((f) => f.kind === 'missing-output')?.where).toBe(
      'vngen/state/tasks.jsonl',
    );
  });

  it('reports a row dropped from the manifest, and what still names it', async () => {
    const row = await shotRow();
    const manifest = await readManifest();
    manifest.assets = manifest.assets.filter((a) => a.hash !== row.hash);
    await writeManifest(manifest);
    expect(about(await check(), row.hash).sort()).toEqual([
      ['blocking', 'missing-row'],
      ['blocking', 'unlisted-output'],
      ['information', 'stray-file'],
    ]);
  });

  it('reports an approved portrait no manifest lists', async () => {
    const file = p.paths.characterFile('aiko');
    const sheet = await readFile(file, 'utf8');
    await writeFile(file, sheet.replace(/approved_portrait: .*/, `approved_portrait: ${GONE}`));
    const findings = (await check()).filter((f) => f.hash === GONE);
    expect(findings).toMatchObject([
      { severity: 'blocking', kind: 'missing-row', referrer: 'character aiko' },
    ]);
  });

  it('reports a pin on a shot override that no manifest lists', async () => {
    const row = await shotRow();
    const sceneId = row.satisfies.find((b) => b.sceneId !== undefined)!.sceneId!;
    const file = p.paths.shotsFile(sceneId);
    const shots = JSON.parse(await readFile(file, 'utf8')) as {
      shots: { id: string; promptOverride?: unknown }[];
    };
    const shot = shots.shots[0]!;
    shot.promptOverride = { mode: 'chunks', refs: { subject: [{ pin: GONE, ext: 'png' }] } };
    await writeFile(file, JSON.stringify(shots, null, 2));
    expect((await check()).filter((f) => f.hash === GONE)).toMatchObject([
      {
        severity: 'blocking',
        kind    : 'missing-row',
        referrer: `shot ${shot.id}`,
        where   : `vngen/work/shots/${sceneId}.json`,
      },
    ]);
  });

  it('reports a slot holding two current pictures, which the repair would have fixed', async () => {
    const row = await shotRow();
    const twin = { ...row, hash: 'f'.repeat(64) };
    const manifest = await readManifest();
    manifest.assets.push(twin);
    await writeManifest(manifest);
    await writeFile(join(p.paths.assetsDir, `${twin.hash}.${twin.ext}`), 'twin');
    const findings = await check();
    expect(findings.map((f) => f.kind)).toEqual(['over-held']);
    expect(findings[0]!.message).toContain('2 current pictures');
  });

  it('reports a row drawn from a reference no manifest lists, for information', async () => {
    const row = await shotRow();
    const manifest = await readManifest();
    manifest.assets.find((a) => a.hash === row.hash)!.refs.push(GONE);
    await writeManifest(manifest);
    expect(about(await check(), GONE)).toEqual([['information', 'stale-ref']]);
  });

  it('reports a graph and a group naming a picture no manifest lists', async () => {
    const graph = new Graph();
    const file = new GenImageFile();
    graph.add(file);
    file.props.hash!.setValue(GONE);
    await writeGraphDoc(p.dir, 'lookbook', graph);

    const def = new GroupDef();
    const inner = new GenImageFile();
    def.subgraph.add(inner);
    inner.props.hash!.setValue(GONE);
    await writeGroupDef(p.dir, 'swatch', def);

    expect((await check()).filter((f) => f.hash === GONE)).toMatchObject([
      {
        kind    : 'missing-row',
        where   : 'vngen/work/graphs/lookbook.json',
        referrer: `graph lookbook, node ${file.id}`,
      },
      {
        kind    : 'missing-row',
        where   : 'vngen/work/graphs/lib/swatch.json',
        referrer: `group swatch, node ${inner.id}`,
      },
    ]);
  });

  it('reports each file that does not parse as unchecked rather than skipping it', async () => {
    await write(join(p.dir, 'vngen/work/graphs/broken.json'), 'not json');
    await write(join(p.dir, 'vngen/work/graphs/lib/broken.json'), 'not json');
    await write(p.paths.storyPlay, '{"version": 2}');
    const findings = await check();
    expect(findings.map((f) => [f.severity, f.kind, f.message])).toEqual([
      [
        'information',
        'unparsed',
        'vngen/build/story.play.json could not be checked (parse errors).',
      ],
      [
        'information',
        'unparsed',
        'vngen/work/graphs/broken.json could not be checked (parse errors).',
      ],
      [
        'information',
        'unparsed',
        'vngen/work/graphs/lib/broken.json could not be checked (parse errors).',
      ],
    ]);
  });

  it('reports a storyboard that does not parse as unchecked', async () => {
    const row = await shotRow();
    const sceneId = row.satisfies.find((b) => b.sceneId !== undefined)!.sceneId!;
    await writeFile(p.paths.shotsFile(sceneId), '{"shots": "no"}');
    expect((await check()).filter((f) => f.kind === 'unparsed')).toMatchObject([
      {
        referrer: `scene ${sceneId}`,
        message : `vngen/work/shots/${sceneId}.json could not be checked (parse errors).`,
      },
    ]);
  });

  it('reports a playable showing a picture that is gone', async () => {
    const playable = {
      version: 1,
      title  : 'x',
      scenes: {
        arrival: {
          beats: [{ type: 'show', shot: 'arrival_1', image: { hash: GONE, ext: 'png' } }],
        },
      },
    };
    await write(p.paths.storyPlay, JSON.stringify(playable));
    expect((await check()).filter((f) => f.hash === GONE)).toMatchObject([
      { severity: 'information', kind: 'stale-playable', referrer: 'shot arrival_1' },
    ]);
  });
});
