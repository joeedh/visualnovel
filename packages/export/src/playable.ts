/**
 * The exporter. Projects a project model plus an asset store into a {@link Playable}
 * (`story.play.json`).
 *
 * `buildPlayable` is pure and in-memory. It flattens each scene's structured `lines` into an
 * ordered beat list: a `show` beat whenever the covering shot changes, then `say` (attributed
 * dialogue/parenthetical) or `narrate` (narration/action). Each scene's edges are the narrative
 * engine's exits for it, and the entry is the model's.
 *
 * Assets are referenced by `{hash, ext}` and resolved from the manifest, never inlined. An
 * absent asset is omitted, so a partially-generated (or entirely un-generated) project still
 * plays and the runner shows a placeholder.
 */
import type {
  Asset,
  AssetRef,
  AssetStore,
  Playable,
  PlayablePanel,
  PlayableScene,
  Beat,
  Lettering,
  ProductionData,
  ProjectModel,
  Scene,
  SceneLine,
  Shot,
} from '@vn/types';
import { bindsTo, shotsOf } from '@vn/types';
import { productionOf, ProjectPaths, readShots } from '@vn/store';
import { writeFileAtomic } from '@vn/util';

/**
 * A shot reduced to what the exporter needs: its id (to resolve an image from the manifest),
 * the line ids it covers, and its panels when it is a page.
 */
interface CoveringShot {
  id: string;
  coversLines: string[];
  panels?: PlayablePanel[];
}

/**
 * A page's panels as the playable carries them; `undefined` for a single frame. Bubbles ride
 * along only when the runner letters the page: under `lettering: model` the words are in the
 * picture, and a bubble over them would say each line twice.
 */
function panelsOf(shot: Shot, bubbles: boolean): PlayablePanel[] | undefined {
  return shot.panels?.map((p) => ({
    shape: p.shape,
    lines: p.coversLines,
    ...(bubbles && p.bubbles?.length
      ? {
          bubbles: p.bubbles.map((b) => ({
            line  : b.lineId,
            anchor: b.anchor,
            ...(b.tail ? { tail: b.tail } : {}),
            ...(b.name === undefined ? {} : { name: b.name }),
          })),
        }
      : {}),
  }));
}

/**
 * A copy of `model` whose production map holds every scene's persisted decomposition
 * (`work/shots/<sceneId>.json`), for the exporter.
 *
 * A model rebuilt from disk carries no storyboards, so without this the exporter falls back to
 * reconstructing the deterministic baseline for every scene. For a scene the LLM decomposed that
 * reconstruction names shot ids no run ever produced, and each one resolves to a `show` beat with
 * no image: the art was generated, paid for, and then never displayed.
 *
 * Stale `coversLines` are dropped the same way the planner drops them, so a screenplay edited
 * under its shots exports what the planner would next persist. A storyboard that will not parse
 * throws, rather than exporting its scene from the baseline.
 */
export async function withSceneShots(
  paths: ProjectPaths,
  model: ProjectModel,
): Promise<ProjectModel> {
  const production = new Map<string, ProductionData>();
  for (const scene of model.scenes.values()) {
    const loaded = await readShots(paths, scene.id, new Set(scene.lines.map((l) => l.id)));
    if (loaded) production.set(scene.id, productionOf(loaded));
  }
  return { ...model, production };
}

/**
 * The shots that bind lines → images for a scene: its storyboard's shots, or with none a
 * reconstruction of the deterministic baseline, mirroring `@vn/stills`' `deterministicShots`
 * (which this package must not import): an establishing shot over the scene's unattributed
 * lines, plus one medium shot per character over that character's dialogue lines. The
 * reconstructed ids match the pipeline's `${sceneId}__<raw>` scheme so images from a deterministic
 * run resolve.
 */
function coveringShots(scene: Scene, own: readonly Shot[], bubbles: boolean): CoveringShot[] {
  if (own.length > 0) {
    return own.map((s) => {
      const panels = panelsOf(s, bubbles);
      return { id: s.id, coversLines: s.coversLines, ...(panels ? { panels } : {}) };
    });
  }
  const lineIds = (predicate: (l: SceneLine) => boolean): string[] =>
    scene.lines.filter(predicate).map((l) => l.id);
  const shots: CoveringShot[] = [
    {
      id         : `${scene.id}__establishing`,
      coversLines: lineIds((l) => l.kind !== 'dialogue' && l.kind !== 'parenthetical'),
    },
  ];
  scene.characters.forEach((characterId, i) => {
    shots.push({
      id         : `${scene.id}__beat${i + 1}`,
      coversLines: lineIds((l) => l.kind === 'dialogue' && l.speaker === characterId),
    });
  });
  return shots;
}

/**
 * Content-addressed manifest lookups, filtered by kind and subject, answering the take a slot
 * holds. Whether that take is approved is not asked here.
 */
class AssetIndex {
  constructor(private readonly assets: readonly Asset[]) {}

  private ref(asset: Asset | undefined): AssetRef | undefined {
    return asset ? { hash: asset.hash, ext: asset.ext } : undefined;
  }

  /** The shot image a shot's slot holds, if one was generated. */
  shotImage(shotId: string): AssetRef | undefined {
    return this.ref(
      this.assets.find((a) => a.kind === 'shot_image' && bindsTo(a, { shotId }) && a.current),
    );
  }

  /** The portrait a character's slot holds, approved or not; `unapprovedTakes` says which. */
  portrait(characterId: string): AssetRef | undefined {
    return this.ref(
      this.assets.find((a) => a.kind === 'portrait' && bindsTo(a, { characterId }) && a.current),
    );
  }
}

/** Flatten one scene's lines into an ordered beat list. */
function sceneBeats(
  scene: Scene,
  assets: AssetIndex,
  own: readonly Shot[],
  bubbles: boolean,
): Beat[] {
  const shots = coveringShots(scene, own, bubbles);
  const beats: Beat[] = [];
  let currentShotId: string | undefined;

  for (const line of scene.lines) {
    const shot = shots.find((s) => s.coversLines.includes(line.id));
    if (shot && shot.id !== currentShotId) {
      currentShotId = shot.id;
      const image = assets.shotImage(shot.id);
      beats.push({
        type: 'show',
        shot: shot.id,
        ...(image ? { image } : {}),
        ...(shot.panels ? { panels: shot.panels } : {}),
      });
    }
    // A transition is coverable but is not shown: `CUT TO:` is an instruction to the reader of
    // a screenplay, not a line of the story. The show beat emitted above still changes the frame.
    if (line.kind === 'transition') continue;
    if ((line.kind === 'dialogue' || line.kind === 'parenthetical') && line.speaker) {
      beats.push({ type: 'say', who: line.speaker, text: line.text, line: line.id });
    } else {
      beats.push({ type: 'narrate', text: line.text, line: line.id });
    }
  }
  return beats;
}

/** Everything the projection needs beyond the model and the store. */
export interface PlayableOptions {
  /** `project.yaml`'s `portrait_overlay`; see {@link Playable.portraitOverlay}. */
  portraitOverlay?: boolean;
  /** `project.yaml`'s `bubble_names`; see {@link Playable.bubbleNames}. */
  bubbleNames?: boolean;
  /**
   * `project.yaml`'s `lettering`. Bubbles are exported only under `runner`; left out, none are,
   * which is what every playable carried before the field existed.
   */
  lettering?: Lettering;
}

/**
 * Build the in-memory {@link Playable} from a project model + its asset store. Pure; hand it
 * {@link withSceneShots}'s model whenever the model came off disk rather than out of a run.
 */
export function buildPlayable(
  model: ProjectModel,
  store: AssetStore,
  opts: PlayableOptions = {},
): Playable {
  const { portraitOverlay = false, bubbleNames = false, lettering } = opts;
  const bubbles = lettering === 'runner';
  const assets = new AssetIndex(store.manifest());

  const characters: Playable['characters'] = {};
  for (const character of model.characters.values()) {
    const portrait = assets.portrait(character.id);
    characters[character.id] = { name: character.name, ...(portrait ? { portrait } : {}) };
  }

  const scenes: Record<string, PlayableScene> = {};
  for (const scene of model.scenes.values()) {
    const exits = model.narrative.exits(scene.id);
    scenes[scene.id] = {
      beats  : sceneBeats(scene, assets, shotsOf(model, scene.id), bubbles),
      choices: exits.choices.map((c) => ({ label: c.label, goto: c.goto })),
      ...(exits.next ? { next: exits.next } : {}),
    };
  }

  return {
    version: 1,
    title  : model.title,
    ...(model.entry ? { start: model.entry } : {}),
    // Written even when false, so an author reading story.play.json sees the setting present
    // and off. An omitted field would read as "not generated yet", the way a missing ref does.
    portraitOverlay,
    bubbleNames,
    characters,
    scenes,
  };
}

/** Write a playable to `vngen/build/story.play.json` (atomic). */
export async function writePlayable(paths: ProjectPaths, playable: Playable): Promise<void> {
  await writeFileAtomic(paths.storyPlay, JSON.stringify(playable, null, 2) + '\n');
}
