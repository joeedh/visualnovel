/**
 * The pure halves of `vngen import` and `vngen screenplay`.
 *
 * For the importer, two things are being asserted and only the second is about diagnostics: that
 * every fixture screenplay converts to chunks that re-read as the same scenes (the migration is
 * faithful), and that each way it can go wrong empties `chunks` rather than writing a partial
 * conversion. For the exporter it is one thing — the default output is still a screenplay this
 * repo can read back, which is what makes the chunk format an escape hatch rather than lock-in.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFountain, parseFrontMatter } from '@vn/parse';
import type { Scene } from '@vn/types';
import { SCRIPTS } from '@vn/testkit';
import { canonicalScenes } from '../canonical.js';
import { sceneFromDoc } from '../entities.js';
import { splitScenes } from '../scenes.js';
import { sceneChunksFromScript, scriptFromScenes, type SceneGraph } from '../screenplay.js';
import { docToMarkdown } from '../serialize.js';

/** The scene graph a script describes, as the exporter wants it. */
function graphOf(script: string, entry = 'arrival'): SceneGraph {
  const { scenes } = splitScenes(parseFountain(script));
  return { scenes: new Map(scenes.map((s) => [s.id, s])), entry };
}

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

describe('scriptFromScenes', () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    it(`writes '${name}' as a screenplay that reads back as the same scenes`, () => {
      const graph = graphOf(script);
      const out = scriptFromScenes(graph);
      const back = splitScenes(parseFountain(out));

      expect(back.diagnostics).toEqual([]);
      // Reading order, not storage order — so compare against the ids the export chose.
      const written = out.match(/\[\[scene: (\S+)\]\]/g)?.map((m) => /: (\S+)\]\]/.exec(m)?.[1]);
      expect(back.scenes.map((s) => s.id)).toEqual(written);
      expect(canonicalScenes(back.scenes)).toBe(
        canonicalScenes(back.scenes.map((s) => graph.scenes.get(s.id) as Scene)),
      );
    });
  }

  // Pinned verbatim: this is a file a user opens, so its layout is part of the contract and a
  // reformat should have to be deliberate. `clean` is the version a screenwriting tool sees.
  it('lays a screenplay out the way an author expects', () => {
    expect(scriptFromScenes(graphOf(SCRIPTS.linear))).toBe(
      `INT. CLASSROOM - DAY

[[scene: arrival]]
[[next: rooftop]]
[[nextline: 3]]

[[line: L1]]
Aiko sets her bag down by the window.

AIKO
[[line: L2]]
It's quieter than I expected.

EXT. ROOFTOP - EVENING

[[scene: rooftop]]
[[nextline: 2]]

[[line: L1]]
The city hums somewhere below.
`,
    );
    expect(scriptFromScenes(graphOf(SCRIPTS.linear), { clean: true })).toBe(
      `INT. CLASSROOM - DAY

Aiko sets her bag down by the window.

AIKO
It's quieter than I expected.

EXT. ROOFTOP - EVENING

The city hums somewhere below.
`,
    );
  });

  it('orders breadth-first from the entry, next before choices', () => {
    const out = scriptFromScenes(graphOf(SCRIPTS.branching));
    expect(splitScenes(parseFountain(out)).scenes.map((s) => s.id)).toEqual([
      'arrival',
      'rooftop',
      'good_end',
      'bad_end',
    ]);
  });

  it('appends what the entry cannot reach under a section rather than dropping it', () => {
    const out = scriptFromScenes(graphOf(SCRIPTS.orphan));
    expect(out).toContain('# Unreachable');
    expect(out.indexOf('[[scene: forgotten]]')).toBeGreaterThan(out.indexOf('# Unreachable'));
    expect(splitScenes(parseFountain(out)).scenes.map((s) => s.id)).toEqual([
      'arrival',
      'rooftop',
      'forgotten',
    ]);
  });

  it('writes nothing but the section when there is no entry to walk from', () => {
    const out = scriptFromScenes({ scenes: graphOf(SCRIPTS.linear).scenes, entry: undefined });
    expect(out.startsWith('# Unreachable')).toBe(true);
    expect(splitScenes(parseFountain(out)).scenes).toHaveLength(2);
  });

  it('clean output drops every marker and leaves readable Fountain', () => {
    const out = scriptFromScenes(graphOf(SCRIPTS.branching), { clean: true });
    expect(out).not.toContain('[[');
    expect(out).not.toMatch(/\n\n\n/);
    // Still a screenplay: headings, cues and dialogue survive; only the machine notes went.
    expect(out).toContain('INT. CLASSROOM - AFTERNOON');
    expect(out).toContain('AIKO');
    expect(out).toContain('Um... hello.');
    const back = splitScenes(parseFountain(out));
    expect(back.scenes.map((s) => s.characters)).toEqual([['AIKO'], ['AIKO', 'HARUKI'], [], []]);
  });

  it('clean output is one-way: the branch structure went with the markers', () => {
    const back = splitScenes(
      parseFountain(scriptFromScenes(graphOf(SCRIPTS.branching), { clean: true })),
    );
    expect(back.scenes.map((s) => s.next)).toEqual([undefined, undefined, undefined, undefined]);
    expect(back.scenes.flatMap((s) => s.choices)).toEqual([]);
    expect(back.scenes.map((s) => s.id)).not.toContain('arrival');
  });
});

/**
 * `examples/sample` was converted by running `vngen import` on it, so the committed chunks are a
 * fixed point of the pair: export them and import the result, and the same bytes come back. That
 * is a stronger claim than "the scenes survive" — it pins the layout a user actually reads, and it
 * fails if either projection drifts.
 */
describe('examples/sample is a fixed point of screenplay ↔ import', () => {
  const root = resolve(__dirname, '../../../../examples/sample');
  const dir = join(root, 'scenes');
  const start = /^start:\s*(\S+)/m.exec(readFileSync(join(root, 'project.yaml'), 'utf8'))?.[1];

  it('writes the committed chunk files back byte for byte', () => {
    const ids = readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -'.md'.length));
    expect(ids.length).toBeGreaterThan(2);
    expect(start).toBeDefined();

    const scenes = new Map(
      ids.map((id) => {
        const back = sceneFromDoc(
          parseFrontMatter(readFileSync(join(dir, `${id}.md`), 'utf8')),
          id,
        );
        if (!back.ok) throw new Error(back.diagnostic.message);
        return [id, back.value.scene];
      }),
    );

    const script = scriptFromScenes({ scenes, entry: start });
    const result = sceneChunksFromScript(parseFountain(script), { start: start as string });
    expect(result.diagnostics).toEqual([]);
    expect(result.entry).toBe(start);
    expect(result.chunks.map((c) => c.id).sort()).toEqual([...ids].sort());
    for (const chunk of result.chunks) {
      expect(docToMarkdown(chunk.doc)).toBe(readFileSync(join(dir, `${chunk.id}.md`), 'utf8'));
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
