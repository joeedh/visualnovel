import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneFromDoc } from '@vn/model';
import { parseFrontMatter, splitFrontMatter } from '@vn/parse';
import { ProjectPaths } from '@vn/store';
import { planSceneEdit } from '../apply.js';
import { conflictedRefusal, conflictedSentence } from '../conflicted.js';
import { mergeScene, setLineText } from '../lineops.js';
import { planMarkerEdit } from '../markers.js';
import type { SceneSource } from '../sources.js';

/** A chunk as `sourcesOf` hands it over; the scene is built from the marked text as git leaves it. */
function sourceOf(file: string, text: string, id: string): SceneSource {
  const doc = parseFrontMatter(text);
  const read = sceneFromDoc(doc, id);
  if (!read.ok) throw new Error(read.diagnostic.message);
  const { prefix } = splitFrontMatter(text);
  return { id, file, prefix, script: doc.body, scene: read.value.scene };
}

const CLEAN = `---
scene: rooftop
---

INT. ROOF - NIGHT

[[line: L1]]
She hesitates.
`;

// The same line changed on both sides, so the id sits inside the marker block
const MARKED = `---
scene: rooftop
---

INT. ROOF - NIGHT

<<<<<<< HEAD
[[line: L1]]
She hesitates, then stops.
=======
[[line: L1]]
She does not hesitate.
>>>>>>> 1234567 (Mine)
`;

const OTHER = `---
scene: hall
---

INT. HALL - DAY

[[line: L1]]
He waits.

[[next: rooftop]]
`;

async function tempProject(): Promise<{ paths: ProjectPaths; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-conflicted-'));
  await fs.mkdir(join(dir, 'scenes'), { recursive: true });
  return {
    paths  : new ProjectPaths(dir),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

describe('a scene git left conflict markers in', () => {
  it('still loads, which is why the guard has to exist', () => {
    const doc = parseFrontMatter(MARKED);
    expect(sceneFromDoc(doc, 'rooftop').ok).toBe(true);
  });

  it('is named by conflictedRefusal, and a clean one is not', () => {
    const marked = sourceOf('rooftop.md', MARKED, 'rooftop');
    const clean = sourceOf('hall.md', OTHER, 'hall');
    expect(conflictedRefusal([marked, clean], ['hall'])).toBeUndefined();
    expect(conflictedRefusal([marked, clean], ['hall', 'rooftop'])).toBe(
      conflictedSentence('rooftop'),
    );
    expect(conflictedRefusal([clean], ['nowhere'])).toBeUndefined();
  });

  it('refuses a prose edit on it, and one that merges it into another scene', async () => {
    const { paths, cleanup } = await tempProject();
    try {
      const rooftop = paths.sceneFile('rooftop');
      const hall = paths.sceneFile('hall');
      await fs.writeFile(rooftop, MARKED, 'utf8');
      await fs.writeFile(hall, OTHER, 'utf8');
      const sources = [sourceOf(rooftop, MARKED, 'rooftop'), sourceOf(hall, OTHER, 'hall')];

      const edit = await planSceneEdit({ paths, sources, entry: 'hall' }, (state) =>
        setLineText(state, { line: 'rooftop:L1', text: 'She runs.' }),
      );
      expect(edit).toEqual({ ok: false, message: conflictedSentence('rooftop') });

      const merge = await planSceneEdit({ paths, sources, entry: 'hall' }, (state) =>
        mergeScene(state, { scene: 'rooftop', into: 'hall' }),
      );
      expect(merge).toEqual({ ok: false, message: conflictedSentence('rooftop') });

      // The other scene is still editable
      const other = await planSceneEdit({ paths, sources, entry: 'hall' }, (state) =>
        setLineText(state, { line: 'hall:L1', text: 'He leaves.' }),
      );
      expect(other.ok).toBe(true);
      expect(await fs.readFile(rooftop, 'utf8')).toBe(MARKED);
    } finally {
      await cleanup();
    }
  });

  it('refuses a marker edit on it', () => {
    const sources = [sourceOf('rooftop.md', MARKED, 'rooftop'), sourceOf('hall.md', OTHER, 'hall')];
    expect(planMarkerEdit(sources, [{ sceneId: 'rooftop', outfits: { aiko: 'track' } }])).toEqual({
      ok     : false,
      message: conflictedSentence('rooftop'),
    });
    expect(planMarkerEdit(sources, [{ sceneId: 'hall', outfits: { aiko: 'track' } }]).ok).toBe(
      true,
    );
  });

  it('lets the same edit through once the markers are gone', async () => {
    const { paths, cleanup } = await tempProject();
    try {
      const rooftop = paths.sceneFile('rooftop');
      await fs.writeFile(rooftop, CLEAN, 'utf8');
      const sources = [sourceOf(rooftop, CLEAN, 'rooftop')];
      const edit = await planSceneEdit({ paths, sources, entry: 'rooftop' }, (state) =>
        setLineText(state, { line: 'rooftop:L1', text: 'She runs.' }),
      );
      expect(edit.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
