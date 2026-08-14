/**
 * The exporter: project model + asset store → {@link Playable} (`story.play.json`).
 *
 * `buildPlayable` is pure and in-memory. It flattens each scene's structured `lines` into an
 * ordered beat list: a `show` beat whenever the covering shot changes, then `say` (attributed
 * dialogue/parenthetical) or `narrate` (narration/action). Branch edges come straight from the
 * scene's `choices`/`next`, and the entry from the model.
 *
 * Assets are referenced by `{hash, ext}` and resolved from the manifest — never inlined, and
 * always *omitted* when absent so a partially-generated (or entirely un-generated) project
 * still plays (the runner shows a placeholder).
 */
import type {
  Asset,
  AssetRef,
  AssetStore,
  Playable,
  PlayableScene,
  Beat,
  ProjectModel,
  Scene,
  SceneLine,
  Shot,
} from '@vn/types';
import { bindsTo } from '@vn/types';
import { ProjectPaths, readShots } from '@vn/store';
import { writeFileAtomic } from '@vn/util';

/**
 * A shot reduced to what the exporter needs: its id (to resolve an image from the manifest)
 * and the line ids it covers.
 */
interface CoveringShot {
  id: string;
  coversLines: string[];
}

/**
 * Read every scene's persisted decomposition (`work/shots/<sceneId>.json`) for the exporter.
 *
 * A model rebuilt from disk carries no shots — they exist in memory only while the planner is
 * running — so without this the exporter falls back to reconstructing the deterministic
 * baseline for *every* scene. For a scene the LLM decomposed that reconstruction names shot
 * ids no run ever produced, and each one resolves to a `show` beat with no image: the art was
 * generated, paid for, and then never displayed.
 *
 * Stale `coversLines` are dropped the same way the planner drops them, so a screenplay edited
 * under its shots exports what the planner would next persist.
 */
export async function loadSceneShots(
  paths: ProjectPaths,
  model: ProjectModel,
): Promise<Map<string, Shot[]>> {
  const byScene = new Map<string, Shot[]>();
  for (const scene of model.scenes.values()) {
    const loaded = await readShots(paths, scene.id, new Set(scene.lines.map((l) => l.id)));
    if (loaded) byScene.set(scene.id, loaded.shots);
  }
  return byScene;
}

/**
 * The shots that bind lines → images for a scene. Prefers the persisted decomposition, then
 * the scene's own in-memory shots; with neither it reconstructs the *deterministic* baseline,
 * mirroring `@vn/pipeline`'s `deterministicShots` (which this package must not import): an
 * establishing shot over the scene's unattributed lines, plus one medium shot per character
 * over that character's dialogue lines. The reconstructed ids match the pipeline's
 * `${sceneId}__<raw>` scheme so images from a deterministic run resolve.
 */
function coveringShots(scene: Scene, persisted?: readonly Shot[]): CoveringShot[] {
  const own = persisted?.length ? persisted : scene.shots;
  if (own.length > 0) {
    return own.map((s) => ({ id: s.id, coversLines: s.coversLines }));
  }
  const lineIds = (predicate: (l: SceneLine) => boolean): string[] =>
    scene.lines.filter(predicate).map((l) => l.id);
  const shots: CoveringShot[] = [
    {
      id: `${scene.id}__establishing`,
      coversLines: lineIds((l) => l.kind !== 'dialogue' && l.kind !== 'parenthetical'),
    },
  ];
  scene.characters.forEach((characterId, i) => {
    shots.push({
      id: `${scene.id}__beat${i + 1}`,
      coversLines: lineIds((l) => l.kind === 'dialogue' && l.speaker === characterId),
    });
  });
  return shots;
}

/** Manifest lookups: content-addressed, filtered by kind + subject + acceptance. */
class AssetIndex {
  constructor(private readonly assets: readonly Asset[]) {}

  private ref(asset: Asset | undefined): AssetRef | undefined {
    return asset ? { hash: asset.hash, ext: asset.ext } : undefined;
  }

  /** The accepted shot image for a shot id, if one was generated. */
  shotImage(shotId: string): AssetRef | undefined {
    return this.ref(
      this.assets.find((a) => a.kind === 'shot_image' && bindsTo(a, { shotId }) && a.accepted),
    );
  }

  /** A portrait for a character: the explicitly approved hash, else any accepted portrait. */
  portrait(characterId: string, approvedHash?: string): AssetRef | undefined {
    if (approvedHash) {
      const byHash = this.assets.find((a) => a.hash === approvedHash);
      // The approved portrait may pre-date the manifest entry; fall back to a png ref.
      return byHash ? this.ref(byHash) : { hash: approvedHash, ext: 'png' };
    }
    return this.ref(
      this.assets.find((a) => a.kind === 'portrait' && bindsTo(a, { characterId }) && a.accepted),
    );
  }
}

/** Flatten one scene's lines into an ordered beat list. */
function sceneBeats(scene: Scene, assets: AssetIndex, persisted?: readonly Shot[]): Beat[] {
  const shots = coveringShots(scene, persisted);
  const beats: Beat[] = [];
  let currentShotId: string | undefined;

  for (const line of scene.lines) {
    const shot = shots.find((s) => s.coversLines.includes(line.id));
    if (shot && shot.id !== currentShotId) {
      currentShotId = shot.id;
      const image = assets.shotImage(shot.id);
      beats.push(image ? { type: 'show', shot: shot.id, image } : { type: 'show', shot: shot.id });
    }
    // A transition is coverable but is not shown: `CUT TO:` is an instruction to the reader
    // of a screenplay, not a line of the story. It still changes the frame above.
    if (line.kind === 'transition') continue;
    if ((line.kind === 'dialogue' || line.kind === 'parenthetical') && line.speaker) {
      beats.push({ type: 'say', who: line.speaker, text: line.text });
    } else {
      beats.push({ type: 'narrate', text: line.text });
    }
  }
  return beats;
}

/** Everything the projection needs beyond the model and the store. */
export interface PlayableOptions {
  /** Persisted decompositions — {@link loadSceneShots}'s result. */
  shots?: ReadonlyMap<string, readonly Shot[]>;
  /** `project.yaml`'s `portrait_overlay`; see {@link Playable.portraitOverlay}. */
  portraitOverlay?: boolean;
}

/**
 * Build the in-memory {@link Playable} from a project model + its asset store. Pure; hand it
 * {@link loadSceneShots}'s result whenever the model came off disk rather than out of a run.
 */
export function buildPlayable(
  model: ProjectModel,
  store: AssetStore,
  opts: PlayableOptions = {},
): Playable {
  const { shots, portraitOverlay = false } = opts;
  const assets = new AssetIndex(store.manifest());

  const characters: Playable['characters'] = {};
  for (const character of model.characters.values()) {
    const portrait = assets.portrait(character.id, character.approvedPortrait);
    characters[character.id] = { name: character.name, ...(portrait ? { portrait } : {}) };
  }

  const scenes: Record<string, PlayableScene> = {};
  for (const scene of model.scenes.values()) {
    scenes[scene.id] = {
      beats: sceneBeats(scene, assets, shots?.get(scene.id)),
      choices: scene.choices.map((c) => ({ label: c.label, goto: c.goto })),
      ...(scene.next ? { next: scene.next } : {}),
    };
  }

  return {
    version: 1,
    title: model.title,
    ...(model.entry ? { start: model.entry } : {}),
    // Written even when false. A missing asset ref means "not generated yet"; this is a knob,
    // and an author reading story.play.json should see it is there and off.
    portraitOverlay,
    characters,
    scenes,
  };
}

/** Write a playable to `vngen/build/story.play.json` (atomic). */
export async function writePlayable(paths: ProjectPaths, playable: Playable): Promise<void> {
  await writeFileAtomic(paths.storyPlay, JSON.stringify(playable, null, 2) + '\n');
}
