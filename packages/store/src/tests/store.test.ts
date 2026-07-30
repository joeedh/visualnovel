import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontMatter } from '@vn/parse';
import {
  AssetStore,
  ProjectPaths,
  loadInputs,
  setCharacterApproval,
  writeSceneChunk,
} from '../index.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vn-store-'));
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('AssetStore — content addressing', () => {
  it('stores identical bytes once and persists a manifest', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);

    const ref1 = await store.write(bytes('IMG'), 'png', {
      kind: 'portrait',
      sourceTask: 't1',
      modelId: 'm',
    });
    const ref2 = await store.write(bytes('IMG'), 'png', {
      kind: 'portrait',
      sourceTask: 't2',
      modelId: 'm',
    });
    expect(ref1.hash).toBe(ref2.hash);
    expect(store.manifest()).toHaveLength(1);
    expect(store.has(ref1.hash)).toBe(true);

    // Reopening loads the manifest from disk.
    const reopened = await AssetStore.open(paths);
    expect(reopened.manifest()).toHaveLength(1);
    expect(new TextDecoder().decode(await reopened.read(ref1))).toBe('IMG');
  });

  it('records provenance and supports accept()', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const ref = await store.write(bytes('X'), 'png', {
      kind: 'shot_image',
      sourceTask: 'task',
      modelId: 'gemini',
      prompt: 'a prompt',
      refs: ['ref1'],
      satisfies: { shotId: 's1' },
    });
    await store.accept(ref.hash);
    const asset = store.manifest()[0]!;
    expect(asset.prompt).toBe('a prompt');
    expect(asset.satisfies.shotId).toBe('s1');
    expect(asset.accepted).toBe(true);
  });
});

describe('worktree IO', () => {
  it('loads authored input docs', async () => {
    const paths = new ProjectPaths(await tempRoot());
    await mkdir(join(paths.charactersDir, 'aiko'), { recursive: true });
    await writeFile(paths.characterFile('aiko'), '---\nid: aiko\nname: Aiko\n---\n\nAiko.\n');
    await writeSceneChunk(paths, 'arrival', {
      data: { scene: 'arrival' },
      body: 'INT. ROOM - DAY\n\nAction.\n',
    });

    const inputs = await loadInputs(paths);
    expect(inputs.characterDocs).toHaveLength(1);
    expect(inputs.characterDocs[0]!.data['id']).toBe('aiko');
    expect(inputs.sceneDocs.map((c) => c.id)).toEqual(['arrival']);
    expect(inputs.legacyScreenplay).toBeUndefined();
    expect(inputs.diagnostics).toEqual([]);
  });

  it('does not read a screenplay: names it, and reports no scenes at all', async () => {
    const paths = new ProjectPaths(await tempRoot());
    await mkdir(paths.screenplayDir, { recursive: true });
    await writeFile(join(paths.screenplayDir, 'script.fountain'), 'INT. ROOM - DAY\n\nAction.\n');

    const inputs = await loadInputs(paths);
    expect(inputs.sceneDocs).toEqual([]);
    expect(inputs.legacyScreenplay).toContain('script.fountain');
    expect(inputs.diagnostics).toHaveLength(1);
    expect(inputs.diagnostics[0]!.severity).toBe('error');
    expect(inputs.diagnostics[0]!.code).toBe('legacy_screenplay');
    expect(inputs.diagnostics[0]!.message).toContain('vngen import');
  });

  it('warns rather than fails when a screenplay is left beside chunks', async () => {
    const paths = new ProjectPaths(await tempRoot());
    await writeSceneChunk(paths, 'arrival', {
      data: { scene: 'arrival' },
      body: 'INT. ROOM - DAY\n\nAction.\n',
    });
    await mkdir(paths.screenplayDir, { recursive: true });
    await writeFile(join(paths.screenplayDir, 'script.fountain'), 'INT. OLD - DAY\n\nStale.\n');

    // The chunks still load — a leftover file builds nothing, so it cannot contend with them.
    const inputs = await loadInputs(paths);
    expect(inputs.sceneDocs.map((c) => c.id)).toEqual(['arrival']);
    expect(inputs.diagnostics).toHaveLength(1);
    expect(inputs.diagnostics[0]!.severity).toBe('warning');
    expect(inputs.diagnostics[0]!.code).toBe('stray_screenplay');
    expect(inputs.diagnostics[0]!.message).toContain('script.fountain');
  });

  it('flips a character to approved with the chosen portrait hash', async () => {
    const paths = new ProjectPaths(await tempRoot());
    await mkdir(join(paths.charactersDir, 'aiko'), { recursive: true });
    await writeFile(
      paths.characterFile('aiko'),
      '---\nid: aiko\nname: Aiko\nstatus: candidates\n---\n\nAiko.\n',
    );

    const ok = await setCharacterApproval(paths, 'aiko', 'deadbeef');
    expect(ok).toBe(true);
    const doc = parseFrontMatter(await readFile(paths.characterFile('aiko'), 'utf8'));
    expect(doc.data['status']).toBe('approved');
    expect(doc.data['approved_portrait']).toBe('deadbeef');
  });
});
