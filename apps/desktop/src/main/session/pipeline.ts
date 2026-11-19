import { join } from 'node:path';
import { scriptFromScenes } from '@vn/model';
import { VnError, writeFileAtomic } from '@vn/util';
import { fileCache } from '../workspace/filecache.js';
import { gateStatus, readTaskLog } from '@vn/pipeline';
import { ProjectPaths } from '@vn/store';
import { loadGraph } from '@vn/taskgraph';
import { solve, type Solution } from '@vn/constraint-solver';
import { stillsFamily, unapprovedTakes } from '@vn/stills';
import { buildPlayable, unapprovedSentence, withSceneShots } from '@vn/export';
import type { Playable, RefBinding } from '@vn/types';
import type { PipelineStatus, SlotNode, TaskLogView } from '../../shared/ipc.js';
import { taskLogView } from './tasklogview.js';
import { narrowTask } from '../agent/reviews.js';
import type { WorkspaceSession } from './core.js';
import { relPath, withShots, loadProject, sessionFacts } from './core.js';
import { taskActivity } from '../../shared/taskactivity.js';

/** Lists every slot the solver answered, in its order, in the shape the Task Graph pane reads. */
export function slotNodes(solved: Solution): SlotNode[] {
  return solved.order.map((key) => {
    const state = solved.slots.get(key)!;
    return {
      key,
      binding: state.binding as RefBinding,
      label  : state.label,
      refs   : [...state.refs],
      ...(state.taskHash ? { taskHash: state.taskHash } : {}),
      ...(state.status ? { status: state.status } : {}),
      ...(state.blocked === undefined ? {} : { blocked: state.blocked }),
      ...(state.pick ? { hash: state.pick } : {}),
      candidates: [...state.candidates],
      approved  : state.approved,
    };
  });
}

export class PipelinePart {
  constructor(private readonly session: WorkspaceSession) {}

  async playable(): Promise<Playable> {
    const project = await loadProject(this.session.dir);
    const model = await withSceneShots(project.paths, project.model);
    return buildPlayable(model, project.store, {
      portraitOverlay: project.config.portrait_overlay,
      bubbleNames    : project.config.bubble_names,
      lettering      : project.config.lettering,
    });
  }

  /**
   * Why the playable may not be exported right now: the first slot holding a take nobody has
   * approved, in the sentence `exportPlayable` throws with. The in-app player asks nothing, so
   * an author can watch an unapproved take; publishing one is what is refused.
   */
  async exportRefusal(): Promise<string | undefined> {
    const project = await loadProject(this.session.dir);
    const model = await withSceneShots(project.paths, project.model);
    return unapprovedSentence(unapprovedTakes(model, project.store.manifest()));
  }

  /**
   * Write the playable to `vngen/build/story.play.json` — the `vngen export` equivalent. Throws
   * `VnError('UNAPPROVED')` with {@link exportRefusal}'s sentence, so a command's check and its
   * run agree.
   */
  async exportPlayable(): Promise<{ path: string; scenes: number }> {
    const project = await loadProject(this.session.dir);
    const model = await withSceneShots(project.paths, project.model);
    const refusal = unapprovedSentence(unapprovedTakes(model, project.store.manifest()));
    if (refusal !== undefined) throw new VnError('UNAPPROVED', refusal);
    const playable = buildPlayable(model, project.store, {
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
    const manifest = project.store.manifest();
    const gate = gateStatus(project.model, manifest);
    const exts = new Map(manifest.map((a) => [a.hash, a.ext]));
    // The same solve `docTree` reads. Emitted in order, so the wire carries the topology the pane
    // needs without shipping the two Maps: upstream is always earlier in the array.
    const solved = solve(stillsFamily, sessionFacts(project, await withShots(project)));
    return {
      tasks: taskActivity(
        [...project.graph.all()].map((t) => narrowTask(t, (hash) => exts.get(hash))),
        this.session.progress.activity ?? {},
      ),
      gatePending  : gate.pending,
      blockedOnGate: !gate.cleared,
      slots        : slotNodes(solved),
    };
  }

  /**
   * One task's diagnostic log. Reads only the log file and `tasks.jsonl`, not the whole project,
   * because the Tasks pane asks again about once a second while the task runs.
   */
  async taskLog(hash: string): Promise<TaskLogView> {
    const paths = new ProjectPaths(this.session.dir);
    const [entries, graph] = await Promise.all([
      readTaskLog(paths.taskLog(hash)),
      loadGraph(paths),
    ]);
    return taskLogView(hash, entries, graph.get(hash));
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
