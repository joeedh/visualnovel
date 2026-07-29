import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationError, ensureDir } from '@vn/util';
import { ProjectPaths, readSceneChunk, readSceneChunks, writeSceneChunk } from '../index.js';

async function tempPaths(): Promise<ProjectPaths> {
  return new ProjectPaths(await mkdtemp(join(tmpdir(), 'vn-scenes-')));
}

const BODY =
  'EXT. SCHOOL GATE - AFTERNOON\n\n[[nextline: 2]]\n\n[[line: L1]]\nRain ticks off it.\n';

describe('scene chunks', () => {
  it('returns null when the project has no such chunk', async () => {
    expect(await readSceneChunk(await tempPaths(), 'arrival')).toBeNull();
  });

  it('round-trips front-matter and body through the file', async () => {
    const paths = await tempPaths();
    expect(
      await writeSceneChunk(paths, 'arrival', { data: { scene: 'arrival' }, body: BODY }),
    ).toBe(true);

    const read = await readSceneChunk(paths, 'arrival');
    expect(read?.id).toBe('arrival');
    expect(read?.file).toBe(paths.sceneFile('arrival'));
    expect(read?.doc.data).toEqual({ scene: 'arrival' });
    expect(read?.doc.body.trim()).toBe(BODY.trim());
  });

  it('skips a rewrite that would change nothing, so a committed tree stays clean', async () => {
    const paths = await tempPaths();
    const doc = { data: { scene: 'arrival' }, body: BODY };
    expect(await writeSceneChunk(paths, 'arrival', doc)).toBe(true);
    expect(await writeSceneChunk(paths, 'arrival', doc)).toBe(false);
    expect(await writeSceneChunk(paths, 'arrival', { ...doc, body: `${BODY}\nMore.\n` })).toBe(
      true,
    );
  });

  it('lists chunks by id, ignoring everything that is not a .md file', async () => {
    const paths = await tempPaths();
    for (const id of ['rooftop', 'arrival', 'hall']) {
      await writeSceneChunk(paths, id, { data: { scene: id }, body: BODY });
    }
    await writeFile(join(paths.scenesDir, 'notes.txt'), 'not a scene');
    await ensureDir(join(paths.scenesDir, 'nested'));

    const chunks = await readSceneChunks(paths);
    expect(chunks.map((c) => c.id)).toEqual(['arrival', 'hall', 'rooftop']);
  });

  it('has no chunks at all when scenes/ does not exist', async () => {
    expect(await readSceneChunks(await tempPaths())).toEqual([]);
  });

  it('throws on malformed front-matter rather than silently losing the scene', async () => {
    const paths = await tempPaths();
    await ensureDir(paths.scenesDir);
    await writeFile(paths.sceneFile('arrival'), '---\nscene: [unclosed\n---\n\nbody\n');
    await expect(readSceneChunk(paths, 'arrival')).rejects.toThrow(ValidationError);
    await expect(readSceneChunks(paths)).rejects.toThrow(/unparseable scene chunk "arrival\.md"/);
  });
});
