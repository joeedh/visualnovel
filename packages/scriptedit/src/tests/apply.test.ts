import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneFromDoc } from '@vn/model';
import { parseFrontMatter, splitFrontMatter } from '@vn/parse';
import { ProjectPaths } from '@vn/store';
import { setLineText } from '../lineops.js';
import { applyScenePlan, planSceneEdit } from '../apply.js';
import type { SceneSource } from '../sources.js';

/**
 * A chunk exactly as `sourcesOf` would hand it over: the front-matter block byte-exact, the body
 * as it parses, and the scene the model builds from it.
 */
function sourceOf(file: string, text: string, id: string): SceneSource {
  const doc = parseFrontMatter(text);
  const read = sceneFromDoc(doc, id);
  if (!read.ok) throw new Error(read.diagnostic.message);
  const { prefix } = splitFrontMatter(text);
  return { id, file, prefix, script: doc.body, scene: read.value.scene };
}

const CHUNK = (extra: string): string => `---
scene: rooftop
---

INT. ROOF - NIGHT

[[line: L1]]
She hesitates.
${extra}`;

async function tempProject(): Promise<{ paths: ProjectPaths; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-apply-'));
  await fs.mkdir(join(dir, 'scenes'), { recursive: true });
  return {
    paths: new ProjectPaths(dir),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

describe('planSceneEdit and a note the model does not keep', () => {
  it('refuses the edit, naming the note, and leaves the file alone', async () => {
    const { paths, cleanup } = await tempProject();
    try {
      const file = paths.sceneFile('rooftop');
      const text = CHUNK('\n[[TODO: fix the ending]]\n');
      await fs.writeFile(file, text, 'utf8');

      const plan = await planSceneEdit(
        { paths, sources: [sourceOf(file, text, 'rooftop')], entry: 'rooftop' },
        (state) => setLineText(state, { line: 'rooftop:L1', text: 'She does not hesitate.' }),
      );

      expect(plan.ok).toBe(false);
      if (plan.ok) throw new Error('expected a refusal');
      expect(plan.message).toContain('TODO: fix the ending');
      expect(plan.message).toContain('the model does not keep');
      // The refusal wrote nothing, so the file still carries the note
      expect(await fs.readFile(file, 'utf8')).toBe(text);
    } finally {
      await cleanup();
    }
  });

  it('lets an edit through when every note is a marker, canonicalizing [[goto:]]', async () => {
    const { paths, cleanup } = await tempProject();
    try {
      const file = paths.sceneFile('rooftop');
      const text = CHUNK('\n[[goto: s13]]\n');
      await fs.writeFile(file, text, 'utf8');

      const plan = await planSceneEdit(
        { paths, sources: [sourceOf(file, text, 'rooftop')], entry: 'rooftop' },
        (state) => setLineText(state, { line: 'rooftop:L1', text: 'She does not hesitate.' }),
      );

      expect(plan.ok).toBe(true);
      if (!plan.ok) throw new Error(plan.message);
      await applyScenePlan({ paths, sources: [] }, plan);
      const after = await fs.readFile(file, 'utf8');
      expect(after).toContain('She does not hesitate.');
      // A marker note is re-emitted in canonical form; the rewrite is intentional, not a loss
      expect(after).toContain('[[next: s13]]');
    } finally {
      await cleanup();
    }
  });

  it('says nothing about a note that was already absent from the source', async () => {
    const { paths, cleanup } = await tempProject();
    try {
      const file = paths.sceneFile('rooftop');
      const text = CHUNK('');
      await fs.writeFile(file, text, 'utf8');

      const plan = await planSceneEdit(
        { paths, sources: [sourceOf(file, text, 'rooftop')], entry: 'rooftop' },
        (state) => setLineText(state, { line: 'rooftop:L1', text: 'She does not hesitate.' }),
      );

      expect(plan.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
