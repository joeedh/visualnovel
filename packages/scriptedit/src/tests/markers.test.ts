import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMarkerPlan, planMarkerEdit } from '../markers.js';
import type { SceneSource } from '../sources.js';

const script = (id: string, body: string) => `INT. ROOM - DAY\n\n[[scene: ${id}]]\n${body}`;

const source = (id: string, body = '', file = `${id}.md`): SceneSource => ({
  id,
  file,
  prefix: `---\nscene: ${id}\n---\n`,
  script: script(id, body),
});

const SOURCES = [source('arrival', '[[next: greet]]\n'), source('greet')];

describe('planMarkerEdit', () => {
  it('patches one file per edit and leaves the others out of the plan', () => {
    const plan = planMarkerEdit(SOURCES, [{ sceneId: 'arrival', outfits: { aiko: 'track' } }]);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0]!.source.id).toBe('arrival');
    expect(plan.patches[0]!.text).toContain('[[outfit: aiko=track]]');
    // The rewire it was not asked about survives untouched.
    expect(plan.patches[0]!.text).toContain('[[next: greet]]');
  });

  // The distinction the empty plan exists for: "already so" is a success, and the caller can say
  // so without diffing anything.
  it('plans no patch when the file already says it', () => {
    const already = source('arrival', '[[outfit: aiko=track]]\n');
    const plan = planMarkerEdit([already], [{ sceneId: 'arrival', outfits: { aiko: 'track' } }]);
    expect(plan).toEqual({ ok: true, patches: [] });
  });

  it('refuses a scene no file holds, and a project with no files at all', () => {
    expect(planMarkerEdit(SOURCES, [{ sceneId: 'rooftop', outfits: {} }])).toEqual({
      ok: false,
      message: 'No file holds scene "rooftop".',
    });
    expect(planMarkerEdit([], [{ sceneId: 'arrival', outfits: {} }])).toMatchObject({ ok: false });
  });

  /**
   * The all-or-nothing, which is the reason planning is separate from applying: a set spanning two
   * files and refused on the second must not have written the first.
   */
  it('refuses the whole set when one edit in it cannot be made', () => {
    const plan = planMarkerEdit(SOURCES, [
      { sceneId: 'arrival', outfits: { aiko: 'track' } },
      { sceneId: 'nowhere', outfits: {} },
    ]);
    expect(plan).toMatchObject({ ok: false });
  });
});

describe('applyMarkerPlan', () => {
  it('writes the front-matter back byte-exactly and reports the files', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'vn-markers-'));
    try {
      // Front-matter with a comment in it: re-serializing would eat it, splicing cannot.
      const prefix = '---\nscene: arrival\n# hand-written, keep me\n---\n';
      const src: SceneSource = { ...source('arrival'), file: join(dir, 'arrival.md'), prefix };
      await fs.writeFile(src.file, src.prefix + src.script);

      const plan = planMarkerEdit([src], [{ sceneId: 'arrival', outfits: { aiko: 'track' } }]);
      if (!plan.ok) throw new Error(plan.message);
      expect(await applyMarkerPlan(plan.patches)).toEqual([src.file]);

      const text = await fs.readFile(src.file, 'utf8');
      expect(text.startsWith(prefix)).toBe(true);
      expect(text).toContain('# hand-written, keep me');
      expect(text).toContain('[[outfit: aiko=track]]');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
