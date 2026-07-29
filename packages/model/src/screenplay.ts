/**
 * Turning one whole-screenplay Fountain file into one `scenes/<id>.md` chunk per scene
 * (Fountain import/export, step 1). Pure — a parsed script in, the documents to write out — so
 * the CLI command is left with nothing but I/O and refusals.
 *
 * The conversion has to prove itself before a byte of it is written, because an author cannot
 * review a migration they have not seen. Every chunk is re-read through `sceneFromDoc` and
 * compared against the scene the screenplay produced; one divergence empties `chunks`, the same
 * way `branchpatch.ts` discards its patch.
 */
import type { Diagnostic, Scene } from '@vn/types';
import type { FountainScript, FrontMatterDoc } from '@vn/parse';
import { canonicalScenes } from './canonical.js';
import { sceneFromDoc } from './entities.js';
import { splitScenes } from './scenes.js';
import { sceneToDoc } from './serialize.js';

/** One converted scene: the filename stem it belongs at, and the document to write there. */
export interface SceneChunk {
  id: string;
  doc: FrontMatterDoc;
}

/** What one conversion produced. */
export interface SceneChunksResult {
  /** One document per scene, in document order. **Empty** if any diagnostic is an error. */
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
 * the shapes a shell or a Windows path would fight over are all excluded.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function err(code: string, message: string, where?: string): Diagnostic {
  return { severity: 'error', code, message, ...(where ? { where } : {}) };
}

/** Elements `splitScenes` drops on the floor, so the conversion can say so rather than lose them. */
const DROPPED: { label: string; of: (el: FountainScript['elements'][number]) => boolean }[] = [
  { label: 'section heading', of: (el) => el.type === 'section' },
  { label: 'page break', of: (el) => el.type === 'page_break' },
  { label: 'dual-dialogue cue', of: (el) => el.type === 'character' && el.dual },
];

/**
 * Warn about everything the model does not keep. Dropping these is a deliberate, documented
 * choice (see `splitScenes`), but dropping them *quietly* during a migration is how an author
 * discovers it months later from the export.
 */
function droppedWarnings(script: FountainScript): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const { label, of } of DROPPED) {
    const lines = script.elements.filter(of).map((el) => el.line + 1);
    if (lines.length === 0) continue;
    out.push({
      severity: 'warning',
      code: 'dropped_element',
      message:
        `${lines.length} ${label}${lines.length > 1 ? 's' : ''} (source line ` +
        `${lines.join(', ')}) will be absent from the chunks; the model does not keep ${label}s`,
    });
  }
  const keys = Object.keys(script.title);
  if (keys.length > 0) {
    out.push({
      severity: 'warning',
      code: 'dropped_title_page',
      message: `the title page (${keys.join(', ')}) will be absent from the chunks; a scene chunk's front-matter is its id and nothing else`,
    });
  }
  return out;
}

/**
 * Convert a parsed screenplay into the scene chunks that replace it.
 *
 * Scene ids are carried through **exactly** as the screenplay names them, `[[scene:]]` overrides
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
    // Case-insensitively, because `Rooftop.md` and `rooftop.md` are one file on Windows.
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

  // The safety net. Anything the writer cannot say and the reader cannot recover comes back as a
  // scene that differs, and takes the whole conversion down with it.
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
    entry: failed ? undefined : (opts.start ?? split.scenes[0]?.id),
    diagnostics,
  };
}
