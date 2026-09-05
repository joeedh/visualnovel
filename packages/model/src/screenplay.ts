/**
 * Both directions between one whole-screenplay Fountain file and one `scenes/<id>.md` chunk per
 * scene (Fountain import/export, steps 1–2). Pure — parsed input in, the text or documents to
 * write out — so the CLI commands are left with nothing but I/O and refusals.
 *
 * The two are not symmetric, on purpose. Import has to prove itself before a byte of it is
 * written, because an author cannot review a migration they have not seen: every chunk is re-read
 * through `sceneFromDoc` and compared against the scene the screenplay produced, and one
 * divergence empties `chunks`, the same way `branchpatch.ts` discards its patch. Export is a
 * projection with no such duty — it claims nothing about being re-importable, though the default
 * form is.
 */
import type { Diagnostic, Scene } from '@vn/types';
import type { FountainScript, FrontMatterDoc } from '@vn/parse';
import { canonicalScenes } from './canonical.js';
import { sceneFromDoc } from './entities.js';
import { splitScenes } from './scenes.js';
import { sceneToDoc, sceneToFountain } from './serialize.js';

/** One converted scene: the filename stem it belongs at, and the document to write there. */
export interface SceneChunk {
  id: string;
  doc: FrontMatterDoc;
}

/** What one conversion produced. */
export interface SceneChunksResult {
  /** One document per scene, in document order. Empty if any diagnostic is an error. */
  chunks: SceneChunk[];
  /**
   * What `project.yaml`'s `start:` must name. A directory of chunks has no document order to
   * infer an entry from, so the conversion has to hand one over; `undefined` means it failed.
   */
  entry: string | undefined;
  diagnostics: Diagnostic[];
}

/** Options for {@link sceneChunksFromScript}. */
export interface SceneChunksOptions {
  /**
   * `project.yaml`'s existing `start:`, if it has one. Carried through rather than re-derived:
   * a screenplay project may already name an entry that is not the first scene, and losing it
   * would silently re-root the story graph.
   */
  start?: string;
}

/**
 * A scene id has to be a filename stem, and the import will not invent one. `/`, `\`, spaces and
 * the characters a shell or a Windows path treats specially are all excluded.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function err(code: string, message: string, where?: string): Diagnostic {
  return { severity: 'error', code, message, ...(where ? { where } : {}) };
}

/** Elements `splitScenes` discards, so the conversion can report them rather than lose them. */
const DROPPED: { label: string; of: (el: FountainScript['elements'][number]) => boolean }[] = [
  { label: 'section heading', of: (el) => el.type === 'section' },
  { label: 'page break', of: (el) => el.type === 'page_break' },
  { label: 'dual-dialogue cue', of: (el) => el.type === 'character' && el.dual },
];

/**
 * Warn about everything the model does not keep. Dropping these is a deliberate, documented
 * choice (see `splitScenes`), but dropping them quietly during a migration leaves the author to
 * discover it months later from the export.
 */
function droppedWarnings(script: FountainScript): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const { label, of } of DROPPED) {
    const lines = script.elements.filter(of).map((el) => el.line + 1);
    if (lines.length === 0) continue;
    out.push({
      severity: 'warning',
      code    : 'dropped_element',
      message:
        `${lines.length} ${label}${lines.length > 1 ? 's' : ''} (source line ` +
        `${lines.join(', ')}) will be absent from the chunks; the model does not keep ${label}s`,
    });
  }
  const keys = Object.keys(script.title);
  if (keys.length > 0) {
    out.push({
      severity: 'warning',
      code    : 'dropped_title_page',
      message: `the title page (${keys.join(', ')}) will be absent from the chunks; a scene chunk's front-matter is its id and nothing else`,
    });
  }
  return out;
}

/**
 * Convert a parsed screenplay into the scene chunks that replace it.
 *
 * Scene ids are carried through exactly as the screenplay names them, `[[scene:]]` overrides
 * included: `work/shots/<sceneId>.json` and every generated asset bind to them, so a rename here
 * would detach art the author already paid for. An id that cannot be a filename is therefore an
 * error naming the fix, not a slug the tool picks.
 */
export function sceneChunksFromScript(
  script: FountainScript,
  opts: SceneChunksOptions = {},
): SceneChunksResult {
  const diagnostics: Diagnostic[] = droppedWarnings(script);
  const split = splitScenes(script);
  diagnostics.push(...split.diagnostics);

  if (split.scenes.length === 0) {
    diagnostics.push(
      err('import_no_scenes', 'the screenplay has no scene headings; there is nothing to convert'),
    );
  }

  const seen = new Map<string, string>();
  for (const scene of split.scenes) {
    if (!SAFE_ID.test(scene.id)) {
      diagnostics.push(
        err(
          'import_scene_id',
          `scene id "${scene.id}" cannot be a filename; give the scene a usable ` +
            `[[scene: …]] id in the screenplay and import again`,
          scene.id,
        ),
      );
      continue;
    }
    // Compared case-insensitively, because `Rooftop.md` and `rooftop.md` are one file on Windows.
    const first = seen.get(scene.id.toLowerCase());
    if (first !== undefined) {
      const also = first === scene.id ? '' : ` (spelled "${first}" elsewhere)`;
      diagnostics.push(
        err(
          'import_duplicate_scene',
          `two scenes claim the id "${scene.id}"${also}; one scene, one file`,
          scene.id,
        ),
      );
    } else seen.set(scene.id.toLowerCase(), scene.id);
  }

  if (opts.start !== undefined && !split.scenes.some((s) => s.id === opts.start)) {
    diagnostics.push(
      err(
        'import_unknown_start',
        `project.yaml start: names unknown scene "${opts.start}"`,
        opts.start,
      ),
    );
  }

  // Everything above is about the source, so it is reported before the conversion is attempted —
  // a screenplay that is already wrong would otherwise have each of its problems reported twice,
  // once from the read and once from re-reading what was written from it.
  if (diagnostics.some((d) => d.severity === 'error')) {
    return { chunks: [], entry: undefined, diagnostics };
  }

  const chunks = split.scenes.map((scene) => ({ id: scene.id, doc: sceneToDoc(scene) }));

  // Re-reading each chunk is the safety net. Anything the writer cannot express and the reader
  // cannot recover comes back as a scene that differs, which fails the whole conversion.
  const reread: Scene[] = [];
  let unreadable = false;
  for (const chunk of chunks) {
    const back = sceneFromDoc(chunk.doc, chunk.id);
    if (!back.ok) {
      diagnostics.push(back.diagnostic);
      unreadable = true;
      continue;
    }
    diagnostics.push(...back.value.diagnostics);
    reread.push(back.value.scene);
  }
  if (!unreadable && canonicalScenes(reread) !== canonicalScenes(split.scenes)) {
    diagnostics.push(
      err(
        'import_verify',
        'reading the converted scenes back did not reproduce the screenplay; nothing was converted',
      ),
    );
  }

  const failed = diagnostics.some((d) => d.severity === 'error');
  return {
    chunks: failed ? [] : chunks,
    entry : failed ? undefined : (opts.start ?? split.scenes[0]?.id),
    diagnostics,
  };
}

/**
 * The export needs only the scenes and where the story starts. A `ProjectModel` satisfies this, and
 * so does a bare scene list; the projection does not ask for characters, locations or diagnostics
 * it will not write.
 */
export interface SceneGraph {
  scenes: Map<string, Scene>;
  entry?: string | undefined;
}

/** Options for {@link scriptFromScenes}. */
export interface ScreenplayOptions {
  /**
   * Drop the `[[…]]` machine markers, for a destination that is a human or Final Draft. This is
   * one-way: the scene ids, the branch structure and `nextLineId` all live in those markers, so
   * clean output is a reading copy rather than an input to `vngen import`.
   */
  clean?: boolean;
}

/** A line holding only `[[…]]` markers — what `clean` removes. */
const MARKER_LINE = /^\s*(?:\[\[[\s\S]*?\]\]\s*)+$/;

/**
 * Remove marker-only lines and the doubled blank lines they leave behind. Marker lines carry part
 * of the file's blank-line structure, and in Fountain a blank line is structural.
 */
function stripMarkers(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (MARKER_LINE.test(line)) continue;
    if (line.trim() === '' && (out.length === 0 || out[out.length - 1]?.trim() === '')) continue;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Order the scenes breadth-first from the entry, `next` before `choices` — the order a playthrough
 * tends to meet them in. Deliberately not the order the scenes are stored in: a directory sorts
 * alphabetically, which produces a screenplay nobody can read.
 */
function readingOrder(graph: SceneGraph): { ordered: Scene[]; unreachable: Scene[] } {
  const ordered: Scene[] = [];
  const seen = new Set<string>();
  const queue = graph.entry === undefined ? [] : [graph.entry];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    const scene = graph.scenes.get(id);
    // A dangling goto is `buildModel`'s error to report; here it is simply not a scene to write.
    if (!scene) continue;
    seen.add(id);
    ordered.push(scene);
    if (scene.next) queue.push(scene.next);
    for (const choice of scene.choices) queue.push(choice.goto);
  }
  return { ordered, unreachable: [...graph.scenes.values()].filter((s) => !seen.has(s.id)) };
}

/**
 * Project a scene graph back into one Fountain screenplay — the export path out of the chunk
 * format. The result is read-only and stale as soon as it is written: it is produced on request
 * rather than kept in sync.
 *
 * Scenes come out in reading order, with anything the entry cannot reach appended under a
 * `# Unreachable` section rather than dropped, because an unreachable scene is still the author's
 * work. Machine markers are kept by default (they are Fountain notes, so every renderer ignores
 * them) which makes the output a valid `vngen import` input; `clean` drops them one-way.
 */
export function scriptFromScenes(graph: SceneGraph, opts: ScreenplayOptions = {}): string {
  const { ordered, unreachable } = readingOrder(graph);
  const blocks = ordered.map((scene) => sceneToFountain(scene));
  if (unreachable.length > 0) {
    blocks.push('# Unreachable\n', ...unreachable.map((scene) => sceneToFountain(scene)));
  }
  // Each block already ends in a newline, so joining on one puts a blank line between them —
  // which is what a scene heading needs above it.
  const text = blocks.join('\n');
  return opts.clean ? stripMarkers(text) : text;
}
