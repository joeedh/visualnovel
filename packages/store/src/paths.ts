import { join } from 'node:path';

/**
 * The on-disk layout for a project (report §9). Input files live at the project root;
 * everything generated lives under `vngen/` split into a human-editable `work/` tree,
 * a machine `build/` tree, and pipeline `state/`.
 */
export class ProjectPaths {
  constructor(readonly root: string) {}

  // Input (authored by the user) — report §9.1
  get projectConfig(): string {
    return join(this.root, 'project.yaml');
  }
  get charactersDir(): string {
    return join(this.root, 'characters');
  }
  /**
   * Where a *new* character sheet is created — never where an existing one is looked up.
   * Characters are discovered by their `type:` tag, so an existing one lives wherever the file
   * carrying that tag lives; `loadInputs` reports the real path on the `EntityDoc` and every
   * reader and writer takes it from there.
   */
  characterFile(id: string): string {
    return join(this.charactersDir, id, 'character.md');
  }
  characterRefsDir(id: string): string {
    return join(this.charactersDir, id, 'refs');
  }
  get locationsDir(): string {
    return join(this.root, 'locations');
  }
  /** Where a *new* set-location sheet is created; see {@link characterFile} on lookup. */
  locationFile(id: string): string {
    return join(this.locationsDir, `${id}.md`);
  }
  /**
   * The story bible. Walked for `type:`-tagged entity sheets; everything else in it is not an
   * input and `loadInputs` ignores it.
   */
  get wikiDir(): string {
    return join(this.root, 'wiki');
  }
  /**
   * Base assets — generated art every later prompt references (portraits, model sheets,
   * location refs). Beside the authored inputs rather than under `vngen/`, because it is its
   * own subtree and may be its own git repo: `vngen/build/assets/` could not be either without
   * dragging the build tree along. See `docs/asset-stores.md`.
   */
  get baseAssets(): string {
    return join(this.root, 'assets');
  }
  get baseObjects(): string {
    return join(this.baseAssets, 'objects');
  }
  baseAssetFile(hash: string, ext: string): string {
    return join(this.baseObjects, `${hash}.${ext}`);
  }
  /** The base manifest. Provenance travels with the bytes, so it lives in that subtree. */
  get baseManifest(): string {
    return join(this.baseAssets, 'manifest.json');
  }
  get screenplayDir(): string {
    return join(this.root, 'screenplay');
  }
  get scenesDir(): string {
    return join(this.root, 'scenes');
  }
  /** One authored scene chunk: front-matter identity plus a one-scene Fountain body. */
  sceneFile(id: string): string {
    return join(this.scenesDir, `${id}.md`);
  }

  // Generated — report §9.2
  get vngen(): string {
    return join(this.root, 'vngen');
  }
  get work(): string {
    return join(this.vngen, 'work');
  }
  get build(): string {
    return join(this.vngen, 'build');
  }
  get state(): string {
    return join(this.vngen, 'state');
  }

  // build/
  get assetsDir(): string {
    return join(this.build, 'assets');
  }
  assetFile(hash: string, ext: string): string {
    return join(this.assetsDir, `${hash}.${ext}`);
  }
  get manifest(): string {
    return join(this.build, 'manifest.json');
  }
  /** The flattened, ordered playable a runner interprets (`vngen export`). */
  get storyPlay(): string {
    return join(this.build, 'story.play.json');
  }

  // work/
  get storyGraph(): string {
    return join(this.work, 'story.graph.mmd');
  }
  workCharacterDir(id: string): string {
    return join(this.work, 'characters', id);
  }
  candidatesDir(id: string): string {
    return join(this.workCharacterDir(id), 'candidates');
  }
  approvedPortrait(id: string): string {
    return join(this.workCharacterDir(id), 'approved.png');
  }
  outfitSheetDir(characterId: string, outfit: string): string {
    return join(this.workCharacterDir(characterId), 'outfits', outfit, 'sheet');
  }
  locationBreakdown(id: string): string {
    return join(this.work, 'locations', id, 'breakdown.md');
  }
  locationRefsDir(id: string): string {
    return join(this.work, 'locations', id, 'refs');
  }
  /** One scene's persisted shot decomposition (P5); human-editable, committed. */
  shotsFile(sceneId: string): string {
    return join(this.work, 'shots', `${sceneId}.json`);
  }

  // state/
  get tasksLog(): string {
    return join(this.state, 'tasks.jsonl');
  }
  /** Append-only history of executed commands (`@vn/commands`), mirroring `tasksLog`. */
  get commandsLog(): string {
    return join(this.state, 'commands.jsonl');
  }
  /**
   * Append-only notification log. Flags are patched in place at a byte offset rather than appended
   * as deltas, and the file is union-merged by git — see the project's own `.gitattributes` and
   * `apps/desktop/src/main/notifications.ts`, which owns both contracts.
   */
  get notificationsLog(): string {
    return join(this.state, 'notifications.jsonl');
  }
  reviewsDir(taskHash: string): string {
    return join(this.state, 'reviews', taskHash);
  }
}
