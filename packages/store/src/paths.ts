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
  characterFile(id: string): string {
    return join(this.charactersDir, id, 'character.md');
  }
  characterRefsDir(id: string): string {
    return join(this.charactersDir, id, 'refs');
  }
  get locationsDir(): string {
    return join(this.root, 'locations');
  }
  get screenplayDir(): string {
    return join(this.root, 'screenplay');
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
  sceneFile(id: string): string {
    return join(this.work, 'scenes', `${id}.md`);
  }

  // state/
  get tasksLog(): string {
    return join(this.state, 'tasks.jsonl');
  }
  reviewsDir(taskHash: string): string {
    return join(this.state, 'reviews', taskHash);
  }
}
