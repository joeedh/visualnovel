/**
 * Authored scene chunks — `scenes/<id>.md`, one file per scene.
 *
 * The store's half of the chunk mapping: bytes to a front-matter doc and back. Turning a doc
 * into a `Scene` is `@vn/model`'s `sceneFromDoc`, because `@vn/store` may not import the model
 * — the same seam `loadInputs` and `modelFromInputs` already split along.
 *
 * `shots.ts` is the behavioural model, including the two rules that make a committed,
 * hand-editable file safe: a malformed one throws rather than being silently rewritten, and a
 * rewrite that would change nothing does not touch the file.
 */
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import {
  parseFrontMatter,
  stringifyFrontMatter,
  type FrontMatterDoc,
  type SceneChunkDoc,
} from '@vn/parse';
import { exists, readText, ValidationError, writeFileAtomic } from '@vn/util';
import type { ProjectPaths } from './paths.js';

/** Split front-matter from body, turning a YAML syntax error into a diagnostic naming the file. */
function parseChunk(file: string, text: string): FrontMatterDoc {
  try {
    return parseFrontMatter(text);
  } catch (err) {
    throw new ValidationError(`unparseable scene chunk "${basename(file)}"`, [
      { code: 'scene_file', message: (err as Error).message, where: file },
    ]);
  }
}

/** Read one chunk, or `null` when the project has no such file. */
export async function readSceneChunk(
  paths: ProjectPaths,
  id: string,
): Promise<SceneChunkDoc | null> {
  const file = paths.sceneFile(id);
  if (!(await exists(file))) return null;
  const text = await readText(file);
  return { id, file, doc: parseChunk(file, text), text };
}

/**
 * Every chunk in `scenes/`, ordered by id. The order is for stable diagnostics and nothing
 * else — a directory has no document order, which is why the entry scene is `start:` in
 * `project.yaml` rather than whichever file sorts first.
 */
export async function readSceneChunks(paths: ProjectPaths): Promise<SceneChunkDoc[]> {
  if (!(await exists(paths.scenesDir))) return [];
  const entries = await fs.readdir(paths.scenesDir, { withFileTypes: true });
  const ids = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name.slice(0, -'.md'.length))
    .sort();

  const chunks: SceneChunkDoc[] = [];
  for (const id of ids) {
    const file = join(paths.scenesDir, `${id}.md`);
    const text = await readText(file);
    chunks.push({ id, file, doc: parseChunk(file, text), text });
  }
  return chunks;
}

/**
 * Write one chunk, skipping a byte-identical rewrite: `scenes/` is committed, so a rewrite
 * that changes nothing must leave the tree clean. Returns whether anything was written.
 */
export async function writeSceneChunk(
  paths: ProjectPaths,
  id: string,
  doc: FrontMatterDoc,
): Promise<boolean> {
  const file = paths.sceneFile(id);
  const next = stringifyFrontMatter(doc.data, doc.body);
  if ((await exists(file)) && (await readText(file)) === next) return false;
  await writeFileAtomic(file, next);
  return true;
}

/**
 * Delete one chunk — a scene that stopped existing. Returns whether there was a file to remove;
 * an absent one is not an error, because the caller's decision was made against a load that may
 * be a moment old. Nothing else in the tree is touched: `work/shots/<id>.json` outlives the scene
 * until its owner cleans it up with {@link deleteShots}, which is a separate decision because the
 * shots of a scene that stopped existing may have followed their lines somewhere else.
 */
export async function deleteSceneChunk(paths: ProjectPaths, id: string): Promise<boolean> {
  const file = paths.sceneFile(id);
  if (!(await exists(file))) return false;
  await fs.rm(file);
  return true;
}
