/**
 * `sceneChunksFromScript` — the pure half of `vngen import`.
 *
 * Two things are being asserted, and only the second is about diagnostics: that every fixture
 * screenplay converts to chunks that re-read as the same scenes (the migration is faithful), and
 * that each way it can go wrong empties `chunks` rather than writing a partial conversion.
 */
import { parseFountain, parseFrontMatter } from '@vn/parse';
import type { Scene } from '@vn/types';
import { SCRIPTS } from '@vn/testkit';
import { canonicalScenes } from '../canonical.js';
import { sceneFromDoc } from '../entities.js';
import { splitScenes } from '../scenes.js';
import { sceneChunksFromScript } from '../screenplay.js';
import { docToMarkdown } from '../serialize.js';

const codes = (script: string, start?: string): string[] =>
  sceneChunksFromScript(
    parseFountain(script),
    start === undefined ? {} : { start },
  ).diagnostics.map((d) => d.code);

describe('sceneChunksFromScript — the fixture screenplays', () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    it(`converts '${name}' to chunks that read back as the same scenes`, () => {
      const parsed = parseFountain(script);
      const expected = splitScenes(parsed);
      const result = sceneChunksFromScript(parsed);

      expect(result.diagnostics).toEqual([]);
      expect(result.chunks.map((c) => c.id)).toEqual(expected.scenes.map((s) => s.id));
      expect(result.entry).toBe(expected.scenes[0]?.id);

      // Through the file text, so the front-matter fence is part of what is being trusted.
      const reread = result.chunks.map((chunk) => {
        const back = sceneFromDoc(parseFrontMatter(docToMarkdown(chunk.doc)), chunk.id);
        if (!back.ok) throw new Error(back.diagnostic.message);
        expect(back.value.diagnostics).toEqual([]);
        return back.value.scene;
      });
      expect(canonicalScenes(reread)).toBe(canonicalScenes(expected.scenes));
    });
  }

  it('writes line-id marks and an allocator into every chunk', () => {
    const { chunks } = sceneChunksFromScript(parseFountain(SCRIPTS.branching));
    for (const chunk of chunks) {
      expect(chunk.doc.data).toEqual({ scene: chunk.id });
      expect(chunk.doc.body).toMatch(/\[\[nextline: \d+\]\]/);
      expect(chunk.doc.body).toMatch(/\[\[line: L\d+\]\]/);
      // The id lives in front-matter; a second copy in the body would give it two homes.
      expect(chunk.doc.body).not.toMatch(/\[\[scene:/);
    }
  });

  it('honours an existing start: rather than re-rooting the graph', () => {
    const result = sceneChunksFromScript(parseFountain(SCRIPTS.orphan), { start: 'rooftop' });
    expect(result.diagnostics).toEqual([]);
    expect(result.entry).toBe('rooftop');
  });
});

describe('sceneChunksFromScript — refusals', () => {
  it('reports a start: that names no scene', () => {
    expect(codes(SCRIPTS.linear, 'nowhere')).toEqual(['import_unknown_start']);
    expect(
      sceneChunksFromScript(parseFountain(SCRIPTS.linear), { start: 'nowhere' }).chunks,
    ).toEqual([]);
  });

  it('refuses a screenplay with no scene headings', () => {
    expect(codes('Just a paragraph with no heading above it.\n')).toEqual(['import_no_scenes']);
  });

  it('refuses two scenes that claim one id', () => {
    const script = `INT. CLASSROOM - DAY

[[scene: arrival]]

She sets her bag down.

EXT. ROOFTOP - NIGHT

[[scene: Arrival]]

The city hums below.
`;
    const result = sceneChunksFromScript(parseFountain(script));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['import_duplicate_scene']);
    expect(result.chunks).toEqual([]);
    expect(result.entry).toBeUndefined();
  });

  it('refuses a scene id that cannot be a filename', () => {
    const script = `INT. CLASSROOM - DAY

[[scene: act one/arrival]]

She sets her bag down.
`;
    const result = sceneChunksFromScript(parseFountain(script));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['import_scene_id']);
    expect(result.diagnostics[0]?.message).toContain('act one/arrival');
    expect(result.chunks).toEqual([]);
  });

  it('carries a line-id error out of splitScenes rather than converting anyway', () => {
    const script = `INT. CLASSROOM - DAY

[[scene: arrival]]

[[line: L2]]
She sets her bag down.

[[line: L2]]
She sits.
`;
    const result = sceneChunksFromScript(parseFountain(script));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['duplicate_line_id']);
    expect(result.chunks).toEqual([]);
  });
});

describe('sceneChunksFromScript — what the model does not keep', () => {
  it('warns about sections, page breaks and dual dialogue, and still converts', () => {
    const script = `Title: Rooftops

# Act One

INT. CLASSROOM - DAY

[[scene: arrival]]

AIKO
Hello.

HARUKI ^
Hello.

===

She sets her bag down.
`;
    const result = sceneChunksFromScript(parseFountain(script));
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      'dropped_element',
      'dropped_element',
      'dropped_element',
      'dropped_title_page',
    ]);
    expect(result.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
    expect(result.chunks.map((c) => c.id)).toEqual(['arrival']);
  });

  it('warns about nothing when the source has nothing to drop', () => {
    for (const script of Object.values(SCRIPTS)) {
      expect(codes(script)).toEqual([]);
    }
  });
});

/** Guard the shared projection the safety net compares with: a moved line id must be visible. */
describe('canonicalScenes', () => {
  it('distinguishes scenes that differ only in a line id', () => {
    const [scene] = splitScenes(parseFountain(SCRIPTS.linear)).scenes;
    const moved = {
      ...(scene as Scene),
      lines: (scene as Scene).lines.map((l, i) => (i === 0 ? { ...l, id: `${l.id}x` } : l)),
    };
    expect(canonicalScenes([moved])).not.toBe(canonicalScenes([scene as Scene]));
  });
});
