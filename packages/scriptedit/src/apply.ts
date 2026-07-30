/**
 * The write path for a scene edit: decide, prove, price the storyboard — then, separately, write.
 *
 * Split in two on purpose. `planSceneEdit` touches nothing, so a command's `check` and its `run`
 * ask the *same* function what will happen and a preview cannot drift from the write. `applyScenePlan`
 * takes a plan that already proved itself and does the I/O.
 *
 * Two things this does that a branch rewire does not have to. Scenes are **re-serialized** rather
 * than patched, because there is no surgical form of "insert a line" — which means the first prose
 * edit to a hand-authored chunk canonicalizes it, line-id marks included. And every scene is
 * validated *before* anything is written: the bytes must read back as the scene they were written
 * from, or the whole edit is refused with nothing touched.
 */
import { sceneFromDoc, sceneToDoc } from '@vn/model';
import { stringifyFrontMatter } from '@vn/parse';
import { deleteSceneChunk, deleteShots, readShots, writeShots, type ProjectPaths } from '@vn/store';
import type { Shot } from '@vn/types';
import { writeFileAtomic } from '@vn/util';
import type { LineOp, ScriptState } from './lineops.js';
import { scenesTouchedBy, shotFallout, type ShotFallout } from './shotfallout.js';
import { chunkText, scriptStateOf, type SceneSource } from './sources.js';

/**
 * Everything a scene edit is decided and written against. `sources` and `entry` must come from the
 * same load — a state read a moment earlier could already be stale by the time the patch lands.
 */
export interface SceneEditInput {
  paths: ProjectPaths;
  sources: readonly SceneSource[];
  /** The entry scene `start:` names, so deleting or merging it away can refuse. */
  entry?: string;
}

/** An edit that will happen, with everything needed to write it and nothing left to decide. */
export interface AppliedScenePlan {
  ok: true;
  /** The op's own message, before the storyboard note is appended. */
  message: string;
  /** Chunk files to write whole. Absent from the list means "leave that file alone". */
  pending: { file: string; text: string }[];
  /** Scene ids whose chunk the edit ended. */
  chunkRemoves: string[];
  fallout: ShotFallout;
}

export type ScenePlan = AppliedScenePlan | { ok: false; message: string };

/** The plan's message with the storyboard consequence appended, which is what a caller reports. */
export function scenePlanMessage(plan: AppliedScenePlan): string {
  return plan.fallout.note ? `${plan.message} ${plan.fallout.note}` : plan.message;
}

/**
 * Decide a scene edit and prove it, writing nothing: the chunk bytes, the chunks to delete, and
 * what all of it does to the storyboard.
 */
export async function planSceneEdit(
  input: SceneEditInput,
  decide: (state: ScriptState) => LineOp,
): Promise<ScenePlan> {
  const op = decide(scriptStateOf(input.sources, input.entry));
  if (!op.ok) return { ok: false, message: op.error };

  // Every file is serialized and proved before any is written: a split that is refused on its
  // second half must leave the first exactly as it was.
  const pending: { file: string; text: string }[] = [];
  for (const scene of op.writes) {
    const doc = sceneToDoc(scene);
    const read = sceneFromDoc(doc, scene.id);
    if (!read.ok) return { ok: false, message: read.diagnostic.message };
    const errors = read.value.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) return { ok: false, message: errors.map((d) => d.message).join(' ') };
    // The serializer is lossless, so a scene that reads back as itself writes back identically.
    // Comparing the text rather than the scenes keeps the check on the bytes being written.
    if (sceneToDoc(read.value.scene).body !== doc.body) {
      return {
        ok: false,
        message: `Writing ${scene.id} would not read back as the scene it was written from.`,
      };
    }

    // An existing chunk keeps its front-matter byte-exactly — only the body is ours to rewrite;
    // a new one is written the way the importer writes chunks.
    const source = input.sources.find((s) => s.id === scene.id);
    if (source === undefined) {
      pending.push({
        file: input.paths.sceneFile(scene.id),
        text: stringifyFrontMatter(doc.data, doc.body),
      });
      continue;
    }
    const text = chunkText(source.prefix, doc.body);
    if (text !== source.prefix + source.script) pending.push({ file: source.file, text });
  }

  // The shots as they sit on disk, unfiltered: `readShots(knownLineIds)` would drop the very
  // ids the edit is about to remap, which is the coverage this is here to carry.
  const shots = new Map<string, readonly Shot[]>();
  for (const sceneId of scenesTouchedBy(op)) {
    const loaded = await readShots(input.paths, sceneId);
    if (loaded) shots.set(sceneId, loaded.shots);
  }

  return {
    ok: true,
    message: op.message,
    pending,
    chunkRemoves: op.removes,
    fallout: shotFallout(op, shots),
  };
}

/**
 * Write a proved plan: the chunks, then the storyboards, then the removals. Paths come back
 * absolute — reporting them workspace-relative is the host's job, since `vnauthor` and the desktop
 * app say it differently.
 */
export async function applyScenePlan(
  input: SceneEditInput,
  plan: AppliedScenePlan,
): Promise<{ written: string[]; removed: string[] }> {
  const written: string[] = [];
  for (const { file, text } of plan.pending) {
    await writeFileAtomic(file, text);
    written.push(file);
  }
  for (const [sceneId, shots] of plan.fallout.writes) {
    if (await writeShots(input.paths, sceneId, shots)) {
      written.push(input.paths.shotsFile(sceneId));
    }
  }

  const removed: string[] = [];
  for (const id of plan.chunkRemoves) {
    if (await deleteSceneChunk(input.paths, id)) removed.push(input.paths.sceneFile(id));
  }
  for (const id of plan.fallout.removes) {
    if (await deleteShots(input.paths, id)) removed.push(input.paths.shotsFile(id));
  }
  return { written, removed };
}
