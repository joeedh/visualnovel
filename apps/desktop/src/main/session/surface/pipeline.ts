import type { GenPricedEstimate, Graph as GenGraph } from '@vn/gengraph';
import type { DecomposeAllResult } from '@vn/pipeline';
import type { Playable } from '@vn/types';
import type {
  GraphDocRead,
  GroupDocRead,
  PipelineRunResult,
  PipelineStatus,
  TaskLogView,
} from '../../../shared/ipc.js';
import type { GraphSlug } from '../../doctree/graphs.js';
import type { PipelinePart } from '../pipeline.js';
import type { GengraphPart, SheetScaffoldPlan } from '../gengraph.js';
import { StorySurface } from './story.js';
export abstract class PipelineSurface extends StorySurface {
  abstract readonly pipelinePart: PipelinePart;
  abstract readonly gengraphPart: GengraphPart;

  async playable(): Promise<Playable> {
    return this.pipelinePart.playable();
  }

  async exportRefusal(): Promise<string | undefined> {
    return this.pipelinePart.exportRefusal();
  }

  async exportPlayable(): Promise<{ path: string; scenes: number }> {
    return this.pipelinePart.exportPlayable();
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
    return this.pipelinePart.writeScreenplay(clean);
  }

  async status(): Promise<PipelineStatus> {
    return this.pipelinePart.status();
  }

  taskLog(hash: string): Promise<TaskLogView> {
    return this.pipelinePart.taskLog(hash);
  }

  /**
   * One graph's document, for a renderer that cannot reach the file. The graph is serialized
   * back to the file's own layout rather than to the DSL, because the DSL carries no node
   * positions and the pane has to draw the graph where the author left it.
   *
   * Answered from the held parse when a stat says neither the file nor any definition it resolved
   * has moved. Building one costs a read, a JSON parse, an nstructjs deserialize, a walk of the
   * group library off disk, a validation pass and a re-serialize, and a pane re-reads after every
   * write — so the reads that change nothing are the ones worth not paying for. The stats are what
   * keep a writer this process never saw, such as the CLI or a `git checkout` touching `lib/`,
   * from being served a stale parse.
   */
  async graphDoc(slug: GraphSlug): Promise<GraphDocRead> {
    return this.gengraphPart.graphDoc(slug);
  }

  /**
   * One group definition from `lib/`, for the pane's `groupLoader`. Held and stamped the way a
   * graph is, against its own file and those of the definitions it instances in turn.
   */
  async groupDoc(ref: string): Promise<GroupDocRead> {
    return this.gengraphPart.groupDoc(ref);
  }

  /**
   * Drop every held parse when a write names anything under the graph directory.
   *
   * All of them rather than the one file written: the stamps would catch it on the next serve,
   * but the set is a handful of entries, and dropping them all is cheaper than being wrong.
   */
  forgetGraphDocs(written: readonly string[]): void {
    return this.gengraphPart.forgetGraphDocs(written);
  }

  /**
   * What one graph is expected to spend if it runs from nothing. The refine tail is counted
   * `max_refine_attempts` times, so the figure is the worst case rather than what a run that
   * passes first time costs.
   */
  async graphEstimate(slug: GraphSlug): Promise<
    | { ok: false; reason: string }
    | {
        ok: true;
        estimate: GenPricedEstimate;
        /** Set when the oldest table an estimate drew on is older than `PRICES_STALE_DAYS`. */
        stale: boolean;
      }
  > {
    return this.gengraphPart.graphEstimate(slug);
  }

  /**
   * Runs a plugin's price agent and folds what it answers into the author's own table. The
   * caller has confirmed the spend, because the agent calls a model on the author's key.
   */
  async refreshPrices(
    plugin: string,
  ): Promise<{ ok: true; models: string[]; pricesAsOf: string } | { ok: false; reason: string }> {
    return this.gengraphPart.refreshPrices(plugin);
  }

  /**
   * Run one graph interactively, through the executor and the journal the scheduler runs it
   * through. A run to the active output of a bound graph files the picture it ends on as the
   * slot's current take, `via: 'graph'`; every other target, and a mock run, stays journal-only.
   * `force` invalidates every paid ancestor of the target first, so re-running an unchanged
   * graph is a request rather than a resume that does nothing.
   */
  async runGraph(
    slug: GraphSlug,
    opts: { node?: string; force?: boolean; mock?: boolean } = {},
  ): Promise<{ ok: boolean; message: string; written: string[]; filed?: string }> {
    return this.gengraphPart.runGraph(slug, opts);
  }

  /** What `runGraph` would run to and file, or the refusal it would give; see `GengraphPart`. */
  runTarget(slug: GraphSlug, node?: string): ReturnType<GengraphPart['runTarget']> {
    return this.gengraphPart.runTarget(slug, node);
  }

  /** Why `runGraph` with `force` would refuse this graph, or undefined when it would run. */
  forceRefusal(graph: GenGraph): string | undefined {
    return this.gengraphPart.forceRefusal(graph);
  }

  /** The scaffold `gengraph.scaffoldSheet` would write for a scene's sheet group, or a refusal. */
  async planSheet(
    sceneId: string,
    group: string,
    name: string,
  ): Promise<SheetScaffoldPlan | { refuse: string }> {
    return this.gengraphPart.planSheet(sceneId, group, name);
  }

  /** Writes a planned sheet scaffold and reports the workspace paths it wrote. */
  async scaffoldSheet(plan: SheetScaffoldPlan): Promise<string[]> {
    return this.gengraphPart.scaffoldSheet(plan);
  }

  async runPreconditions(mock: boolean): Promise<{
    pending: number;
    byKind: Record<string, number>;
    imageCalls: number;
    reviewCalls: number;
    blockedOnGate: boolean;
    gatePending: string[];
    /** Why keys did not resolve — naming the source, never a value. Null when they did. */
    keyError: string | null;
  }> {
    return this.gengraphPart.runPreconditions(mock);
  }

  /**
   * What `decomposeAllScenes` would do, computed without calling the model. A `check` may not
   * spend a model call, so this is the cheap half: how many scenes have no storyboard, which
   * files will not parse, which scenes name a character the project does not have yet — and
   * whether the text key resolves.
   *
   * Deliberately `anthropic` and not `gemini`: decomposition draws nothing, and refusing it for a
   * missing image key would be a refusal the author cannot act on.
   */
  async decomposePreconditions(): Promise<{
    pending: string[];
    kept: string[];
    unreadable: string[];
    atRisk: string[];
    /** Why the text key did not resolve — naming the source, never a value. Null when it did. */
    keyError: string | null;
  }> {
    return this.gengraphPart.decomposePreconditions();
  }

  /**
   * Decompose every reachable scene that has no storyboard yet. Real providers always: a mock
   * decomposition is the deterministic baseline, and `decomposeAll` would decline to write it —
   * so running this against mocks would be a no-op that looked like work.
   */
  async decomposeAllScenes(): Promise<DecomposeAllResult> {
    return this.gengraphPart.decomposeAllScenes();
  }

  async runPipeline(mock: boolean, only?: readonly string[]): Promise<PipelineRunResult> {
    return this.gengraphPart.runPipeline(mock, only);
  }
}
