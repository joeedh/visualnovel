/**
 * Which files hold scenes, and what a scene writer patches: the reader decides, and every writer
 * works from that same read.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pins } from '@vn/contracts';
import { loadInputs, ProjectPaths } from '@vn/store';
import { scriptSceneSourcesOneLoad, sourcesOf } from '../sources.js';

const CHUNK = (id: string): string =>
  `---\nscene: ${id}\n---\n\nINT. ROOF - NIGHT\n\n[[line: L1]]\nShe hesitates.\n`;

async function project(files: Record<string, string>): Promise<ProjectPaths> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-sources-'));
  for (const [path, text] of Object.entries(files)) {
    await fs.mkdir(join(dir, path, '..'), { recursive: true });
    await fs.writeFile(join(dir, path), text, 'utf8');
  }
  return new ProjectPaths(dir);
}

describe(pins(scriptSceneSourcesOneLoad), () => {
  it('patches exactly the chunk files the load read, and nothing it did not', async () => {
    const paths = await project({
      'scenes/rooftop.md'      : CHUNK('rooftop'),
      'scenes/arrival.md'      : CHUNK('arrival'),
      'scenes/notes.txt'       : 'not a scene',
      'screenplay/old.fountain': 'INT. ROOF - NIGHT\n\nShe hesitates.\n',
    });
    try {
      const inputs = await loadInputs(paths);
      const sources = sourcesOf(inputs);

      expect(sources.map((s) => s.id)).toEqual(inputs.sceneDocs.map((d) => d.id));
      expect(sources.map((s) => s.file)).toEqual(inputs.sceneDocs.map((d) => d.file));
      expect(sources.map((s) => s.id).sort()).toEqual(['arrival', 'rooftop']);
      // The leftover screenplay builds nothing; the reader names it rather than reading it
      expect(inputs.diagnostics.map((d) => d.code)).toEqual(['stray_screenplay']);
    } finally {
      await fs.rm(paths.root, { recursive: true, force: true });
    }
  });

  it('reads no scenes from a screenplay alone, and names the import that converts it', async () => {
    const paths = await project({
      'screenplay/old.fountain': 'INT. ROOF - NIGHT\n\nShe hesitates.\n',
    });
    try {
      const inputs = await loadInputs(paths);
      expect(sourcesOf(inputs)).toEqual([]);
      const legacy = inputs.diagnostics.find((d) => d.code === 'legacy_screenplay');
      expect(legacy?.message).toContain('vngen import');
    } finally {
      await fs.rm(paths.root, { recursive: true, force: true });
    }
  });
});
