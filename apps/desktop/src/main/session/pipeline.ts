import { join } from 'node:path';
import { scriptFromScenes } from '@vn/model';
import { writeFileAtomic } from '@vn/util';
import { fileCache } from '../workspace/filecache.js';
import { gateStatus } from '@vn/pipeline';
import { buildSlotGraph } from '@vn/artgen';
import { buildPlayable, loadSceneShots } from '@vn/export';
import type { Playable } from '@vn/types';
import type { PipelineStatus } from '../../shared/ipc.js';
import { narrowTask } from '../agent/reviews.js';
import { labelContext } from '../assets/assetlabel.js';
import type { WorkspaceSession } from './core.js';
import { relPath, readAllShots, loadProject } from './core.js';

export class PipelinePart {
  constructor(private readonly session: WorkspaceSession) {}

  async playable(): Promise<Playable> {
    const project = await loadProject(this.session.dir);
    const shots = await loadSceneShots(project.paths, project.model);
    return buildPlayable(project.model, project.store, {
      shots,
      portraitOverlay: project.config.portrait_overlay,
      bubbleNames    : project.config.bubble_names,
      lettering      : project.config.lettering,
    });
  }

  /** Write the playable to `vngen/build/story.play.json` — the `vngen export` equivalent. */
  async exportPlayable(): Promise<{ path: string; scenes: number }> {
    const project = await loadProject(this.session.dir);
    const shots = await loadSceneShots(project.paths, project.model);
    const playable = buildPlayable(project.model, project.store, {
      shots,
      portraitOverlay: project.config.portrait_overlay,
      bubbleNames    : project.config.bubble_names,
      lettering      : project.config.lettering,
    });
    await writeFileAtomic(project.paths.storyPlay, JSON.stringify(playable, null, 2) + '\n');
    return { path: project.paths.storyPlay, scenes: Object.keys(playable.scenes).length };
  }

  /**
   * Project the scenes back into one Fountain screenplay at the project root — the `vngen
   * screenplay` equivalent. Never into `screenplay/`, which is a second source of truth for every
   * scene; `clean` drops the `[[…]]` markers and with them the scene ids, the branches and
   * `nextLineId`, so that output is a reading copy and not an input.
   */
  async writeScreenplay(clean: boolean): Promise<{
    ok: boolean;
    message: string;
    written: string[];
  }> {
    const project = await loadProject(this.session.dir);
    if (project.model.scenes.size === 0) {
      return { ok: false, message: 'There is no scene to write.', written: [] };
    }
    const file = join(this.session.dir, 'screenplay.fountain');
    await fileCache.write(file, scriptFromScenes(project.model, { clean }));
    return {
      ok     : true,
      message: `Wrote ${project.model.scenes.size} scene(s) to screenplay.fountain${
        clean ? ' (clean: markers dropped, so it cannot be imported back)' : ''
      }.`,
      written: [relPath(this.session.dir, file)],
    };
  }

  async status(): Promise<PipelineStatus> {
    const project = await loadProject(this.session.dir);
    const gate = gateStatus(project.model);
    const manifest = project.store.manifest();
    const exts = new Map(manifest.map((a) => [a.hash, a.ext]));
    // The same walk `docTree` reads. Emitted in `order`, so the wire carries the topology the
    // pane needs without shipping the two Maps: upstream is always earlier in the array.
    const slots = buildSlotGraph({
      ...labelContext(project.model, project.graph),
      assets: manifest,
      shots : await readAllShots(project),
      config: project.config,
      graph : project.graph,
    });
    return {
      tasks        : [...project.graph.all()].map((t) => narrowTask(t, (hash) => exts.get(hash))),
      gatePending  : gate.pending,
      blockedOnGate: !gate.cleared,
      slots        : slots.order.map((key) => slots.nodes.get(key)!),
    };
  }

  /**
   * What a run would find. The count is a dry run against mock providers — what `vngen cost`
   * does — rather than a read of the replayed graph: `tasks.jsonl` holds only what earlier runs
   * planned, so on a project that has never run it says zero while the work is not zero. Nothing
   * is written; a dry run plans with `readOnlyShots` and requeues in memory.
   *
   * The number is still a floor, because planning is incremental and a wave that unlocks later
   * work has not run. So it is reported, never refused — and the keys a real run needs are
   * checked separately, since a dry run needs none.
   */
  /**
   * Every graph the project holds, with its journal replayed and its blobs kept under its own
   * slug. A graph that will not load is left out and its problem reported, because a run that
   * quietly fell back to the fixed runners would draw a picture nobody asked for.
   */
}
