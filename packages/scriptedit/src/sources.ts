/**
 * The authored files a scene edit patches, and the state it is decided against.
 *
 * The one contract here is the one every prose writer rests on: a source list is derived from the
 * *same* `loadInputs` result the model was built from, never from a second look at `scenes/`. So a
 * writer patches exactly the bytes the model was read from rather than whatever is on disk by the
 * time it writes. Both write paths — prose edits (`apply.ts`) and marker edits (`markers.ts`) —
 * take their targets from this one function for that reason.
 */
import { sceneFromDoc } from '@vn/model';
import { splitFrontMatter, type LoadedInputs } from '@vn/parse';
import type { Scene } from '@vn/types';
import type { ScriptState } from './lineops.js';

/**
 * One authored file holding scene prose, as the prose writers need it: `prefix + script` is the
 * file, and only `script` is ever patched. A chunk's `prefix` is its front-matter block, kept
 * byte-exact so a rewire never reformats YAML the author wrote.
 */
export interface SceneSource {
  /** The one scene this file holds — the id front-matter gives it, which its body cannot override. */
  id: string;
  file: string;
  prefix: string;
  script: string;
  /**
   * The scene as this file parses, **before** `buildModel` resolves anything: speakers are still
   * the cues the author typed (`AIKO`, not `aiko`). A prose edit is decided and re-serialized
   * against this rather than against the model's scene, or writing it back would rewrite every
   * cue as the character id it resolved to.
   */
  scene?: Scene;
}

/** The prose files behind a model, in the order `loadInputs` read them. */
export function sourcesOf(inputs: LoadedInputs): SceneSource[] {
  return inputs.sceneDocs.map((chunk) => {
    // The same `sceneFromDoc` the model build runs. A chunk it refuses stays a source — the
    // branch patchers work on its text — but carries no scene, so no prose edit can touch it.
    const read = sceneFromDoc(chunk.doc, chunk.id);
    return {
      id: chunk.id,
      file: chunk.file,
      prefix: splitFrontMatter(chunk.text).prefix,
      script: chunk.doc.body,
      ...(read.ok ? { scene: read.value.scene } : {}),
    };
  });
}

/**
 * What a prose edit is decided against. The scenes come off the sources — the chunk files as they
 * parse — and the entry from `project.yaml`, which is the only place a chunk project records one.
 */
export function scriptStateOf(sources: readonly SceneSource[], entry?: string): ScriptState {
  const scenes = new Map<string, Scene>();
  for (const source of sources) {
    if (source.scene) scenes.set(source.id, source.scene);
  }
  return { scenes, ...(entry === undefined ? {} : { entry }) };
}

/**
 * A chunk's bytes from its own front-matter block and a freshly serialized body. `prefix` ends at
 * the closing fence's single newline, and `stringifyFrontMatter` puts one blank line after it — so
 * this is the form a chunk the app wrote already has, and a rewrite of one is not a diff.
 */
export function chunkText(prefix: string, body: string): string {
  return `${prefix}\n${body.replace(/^\n+/, '')}`;
}
