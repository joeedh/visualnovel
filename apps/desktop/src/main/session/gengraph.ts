import { resolveKeys, secretDirsFor } from '@vn/config';
import { join, sep } from 'node:path';
import {
  estimateGraph,
  priceEstimate,
  pricesAreStale,
  registerGenRuntimes,
  instancedRefs,
  writeGraphFile,
  writeGroupFile,
  type GenPricedEstimate,
  type Graph as GenGraph,
  type GraphJournalRecord,
} from '@vn/gengraph';
import {
  appendGraphJournal,
  executeGenGraph,
  graphBlobStore,
  graphJournalFile,
  readGraphJournal,
  refreshUserPrices,
  sharedAncestors,
  type GenRunContext,
} from '@vn/gengraph/state';
import {
  createGenServices,
  decomposeAll,
  decomposeAllPreview,
  hostPriceTables,
  indexGraphs,
  type DecomposeAllResult,
  type GraphRuntime,
} from '@vn/pipeline';
import { aspectFor, assetSlotLabel, imageParams, sheetSeeds, slotKey } from '@vn/artgen';
import { SHEET_CELL_REF, sheetCellDef, sheetGraph } from '@vn/gengraph';
import type { SheetCell } from '@vn/gengraph';
import { readShots } from '@vn/store';
import { projectModels, resolveRoutes } from '@vn/providers';
import { runPipeline, type RunSummary } from '@vn/scheduler';
import type { Asset } from '@vn/types';
import { BUSY_RUN } from '../../shared/ipc.js';
import { GRAPH_DOCS_DIR } from '../../shared/writes.js';
import type { GraphDocRead, GroupDocRead, PipelineRunResult } from '../../shared/ipc.js';
import {
  claimOf,
  freeName,
  graphPath,
  graphSlugs,
  groupPath,
  isGraphSlug,
  nodeIdOf,
  readGraph,
  readGroupDef,
  readGroupDoc,
  slugOfName,
  writeGraph,
  writeGroupDef,
  type GraphSlug,
} from '../doctree/graphs.js';
import { notify } from '../notify/notifications.js';
import type { WorkspaceSession, LoadedProject, LoadedGraphDoc, GenDeps } from './core.js';
import { graphSeeds } from './graphseeds.js';
import {
  relPath,
  loadProject,
  stampsOf,
  unmoved,
  activeOutputOf,
  buildGenDeps,
  buildProviders,
} from './core.js';

/** What `gengraph.scaffoldSheet` is about to write, decided once for its check and its run. */
export interface SheetScaffoldPlan {
  slug: GraphSlug;
  /** The member shots' ids, in sheet order. */
  members: string[];
  cells: SheetCell[];
  sheetAspect: string;
  /** Whether the `sheet-cell` definition is written too, on the project's first scaffold. */
  writesDef: boolean;
}

export class GengraphPart {
  constructor(private readonly session: WorkspaceSession) {}

  /**
   * Decides the graph a staging-sheet group is scaffolded as, or refuses in one sentence: the
   * scene must hold a storyboard with shots in that group, and no member's slot may already
   * be drawn by a graph. The slug is the name given, or `sheet-<scene>-<group>` and the next
   * free suffix after it.
   */
  async planSheet(
    sceneId: string,
    group: string,
    name: string,
  ): Promise<SheetScaffoldPlan | { refuse: string }> {
    const root = this.session.dir;
    const project = await loadProject(root);
    const scene = project.model.scenes.get(sceneId);
    if (scene === undefined) return { refuse: `there is no scene '${sceneId}'` };

    const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
    if (!loaded) return { refuse: `scene '${sceneId}' has no storyboard yet` };

    const said = group.trim();
    const seeds = sheetSeeds(
      { ...scene, shots: loaded.shots, ...(loaded.sheets ? { sheets: loaded.sheets } : {}) },
      said,
      project.model,
      project.config,
      project.store.manifest(),
    );
    if (seeds === undefined) {
      return { refuse: `no shot in scene '${sceneId}' is in a sheet group '${said}'` };
    }

    const slugs = await graphSlugs(root);
    const cells: SheetCell[] = [];
    for (const [i, shot] of seeds.members.entries()) {
      const slot = slotKey({ kind: 'shot', sceneId, shotId: shot.id });
      const claimed = await claimOf(root, slugs, slot);
      if (claimed !== undefined) return { refuse: claimed };
      cells.push({
        slot,
        rect  : seeds.layout.cells[i]!,
        aspect:
          aspectFor(imageParams(project.config), shot, project.config.image_params.page_aspect)
            .aspect ?? '',
      });
    }

    const taken = new Set<string>(slugs);
    const wanted = name.trim();
    let slug: GraphSlug;
    if (wanted === '') {
      slug = freeName(slugOfName(`sheet-${sceneId}-${said}`), taken);
    } else if (!isGraphSlug(wanted)) {
      return { refuse: `'${wanted}' is not a graph name` };
    } else if (taken.has(wanted)) {
      return { refuse: `this project already has a ${wanted} graph` };
    } else {
      slug = wanted;
    }

    return {
      slug,
      members: seeds.members.map((m) => m.id),
      cells,
      sheetAspect: seeds.layout.aspect,
      writesDef  : (await readGroupDef(root, SHEET_CELL_REF)) === undefined,
    };
  }

  /**
   * Writes the planned scaffold: the `sheet-cell` definition when the project has none yet,
   * then the graph, instanced against whichever definition the project now holds, so an
   * author's edits to the cell chain reach every later scaffold.
   */
  async scaffoldSheet(plan: SheetScaffoldPlan): Promise<string[]> {
    const root = this.session.dir;
    const written: string[] = [];
    if (plan.writesDef) written.push(await writeGroupDef(root, SHEET_CELL_REF, sheetCellDef()));
    const def = (await readGroupDef(root, SHEET_CELL_REF)) ?? sheetCellDef();
    written.push(await writeGraph(root, plan.slug, sheetGraph(plan.cells, plan.sheetAspect, def)));
    return written;
  }

  private async loadGraphs(
    project: LoadedProject,
    deps: GenDeps,
  ): Promise<{ loaded: LoadedGraphDoc[]; problems: string[] }> {
    registerGenRuntimes();

    const loaded: LoadedGraphDoc[] = [];
    const problems: string[] = [];

    for (const slug of await graphSlugs(this.session.dir)) {
      const read = await readGraph(this.session.dir, slug);
      if (!read.ok) {
        problems.push(read.reason);
        continue;
      }
      loaded.push({
        slug,
        graph   : read.graph,
        journal : await readGraphJournal(project.paths, slug),
        services: createGenServices({
          model       : project.model,
          store       : project.store,
          providers   : deps.providers,
          imageBackend: deps.imageBackend,
          imageModel  : project.config.models.image,
          blobs       : graphBlobStore(project.paths, slug),
          ...(deps.keys === undefined ? {} : { keys: deps.keys }),
        }),
        record  : (record: GraphJournalRecord) => appendGraphJournal(project.paths, slug, record),
      });
    }

    return { loaded, problems };
  }

  /**
   * The slot→graph index a run consults, or undefined when the project holds no graph to
   * consult. A graph that will not load and a slot two graphs claim are both filed as
   * notifications rather than thrown: the run still has the fixed runners to draw the rest of
   * the wave with, and refusing to start would cost the author that work.
   */
  private async graphRuntime(
    project: LoadedProject,
    deps: GenDeps,
  ): Promise<GraphRuntime | undefined> {
    const { loaded, problems } = await this.loadGraphs(project, deps);
    for (const problem of problems) {
      void notify({ category: 'error', level: 'warn', source: 'pipeline', message: problem });
    }
    if (loaded.length === 0) return undefined;

    const { runtime, conflicts } = indexGraphs(loaded);
    for (const slot of conflicts) {
      void notify({
        category: 'error',
        level   : 'warn',
        source  : 'pipeline',
        message : `More than one active output claims ${slot}, so no graph draws it.`,
      });
    }
    return runtime;
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
    const held = this.session.heldGraphs.get(slug);
    if (held && (await unmoved(held))) return held.read;

    const read = await readGraph(this.session.dir, slug);
    const answer: GraphDocRead = read.ok
      ? {
          ok         : true,
          path       : read.path,
          file       : writeGraphFile(read.graph),
          diagnostics: read.diagnostics,
        }
      : { ok: false, reason: read.reason };

    // Stamped after the read, so bytes that landed during it are described by the record rather
    // than hidden by it
    const files = [join(this.session.dir, graphPath(this.session.dir, slug))];
    if (read.ok) files.push(...this.groupFiles(instancedRefs(read.graph)));
    this.session.heldGraphs.set(slug, { read: answer, stamps: await stampsOf(files) });
    return answer;
  }

  /**
   * One group definition from `lib/`, for the pane's `groupLoader`. Held and stamped the way a
   * graph is, against its own file and those of the definitions it instances in turn.
   */
  async groupDoc(ref: string): Promise<GroupDocRead> {
    const held = this.session.heldGroups.get(ref);
    if (held && (await unmoved(held))) return held.read;

    const read = await readGroupDoc(this.session.dir, ref);
    const answer: GroupDocRead = read.ok
      ? {
          ok         : true,
          path       : read.path,
          file       : writeGroupFile(read.def),
          diagnostics: read.diagnostics,
        }
      : { ok: false, reason: read.reason };

    const files = this.groupFiles([ref, ...(read.ok ? instancedRefs(read.def.subgraph) : [])]);
    this.session.heldGroups.set(ref, { read: answer, stamps: await stampsOf(files) });
    return answer;
  }

  private groupFiles(refs: readonly string[]): string[] {
    return refs.map((ref) => join(this.session.dir, groupPath(this.session.dir, ref)));
  }

  /**
   * Drop every held parse when a write names anything under the graph directory.
   *
   * All of them rather than the one file written: the stamps would catch it on the next serve,
   * but the set is a handful of entries, and dropping them all is cheaper than being wrong.
   */
  forgetGraphDocs(written: readonly string[]): void {
    const dir = `${GRAPH_DOCS_DIR}/`;
    if (written.some((path) => path.split(sep).join('/').startsWith(dir))) {
      this.session.heldGraphs.clear();
      this.session.heldGroups.clear();
    }
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
    const read = await readGraph(this.session.dir, slug);
    if (!read.ok) return { ok: false, reason: read.reason };

    const { config } = await loadProject(this.session.dir);
    const counted = estimateGraph(read.graph, {
      maxRefineAttempts: config.max_refine_attempts,
      imageModel       : config.models.image,
    });
    const estimate = priceEstimate(counted.lines, await hostPriceTables());
    const asOf = estimate.pricesAsOf;
    return {
      ok: true,
      estimate,
      stale: asOf !== undefined && pricesAreStale(asOf, new Date()),
    };
  }

  /**
   * Runs a plugin's price agent and folds what it answers into the author's own table. The
   * caller has confirmed the spend, because the agent calls a model on the author's key.
   */
  async refreshPrices(
    plugin: string,
  ): Promise<{ ok: true; models: string[]; pricesAsOf: string } | { ok: false; reason: string }> {
    const project = await loadProject(this.session.dir);
    const deps = await buildGenDeps(project, false);
    const services = createGenServices({
      model       : project.model,
      store       : project.store,
      providers   : deps.providers,
      imageBackend: deps.imageBackend,
      imageModel  : project.config.models.image,
      ...(deps.keys === undefined ? {} : { keys: deps.keys }),
    });

    const done = await refreshUserPrices(plugin, services, new Date());
    if (!done.ok) return done;
    return { ok: true, models: done.models, pricesAsOf: done.table.pricesAsOf };
  }

  /**
   * Why a forced run of this graph is refused, or undefined when it is not. A node that feeds
   * more than one output, such as the sheet every cell of a staging graph is cut from, would
   * be redrawn for one output and leave the others' pictures cut from a sheet that no longer
   * exists; rerolling such a graph is done by changing the group's seed instead.
   */
  forceRefusal(graph: GenGraph): string | undefined {
    const shared = sharedAncestors(graph);
    if (shared.length === 0) return undefined;
    return (
      `node ${String(shared[0])} feeds more than one output, so a forced run would redraw it ` +
      'for one output and strand the others; change the sheet group’s seed to reroll it instead'
    );
  }

  /**
   * Run one graph interactively, through the executor and the journal the scheduler runs it
   * through, seeded for the slot its target binds as the scheduler would seed it. Nothing
   * enters the asset store here: a picture becomes an asset only on the bound path, where a
   * task's slot names the graph that draws it. `force` invalidates every paid ancestor of the
   * target first, so re-running an unchanged graph is a request rather than a resume that
   * does nothing.
   */
  async runGraph(
    slug: GraphSlug,
    opts: { node?: string; force?: boolean; mock?: boolean } = {},
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const read = await readGraph(this.session.dir, slug);
    if (!read.ok) return { ok: false, message: read.reason, written: [] };

    const target =
      opts.node === undefined ? activeOutputOf(read.graph) : nodeIdOf(read.graph, opts.node);
    if (target === undefined) {
      return {
        ok     : false,
        message: `the ${slug} graph has no active output node, so there is nothing to run to`,
        written: [],
      };
    }
    if (read.graph.nodeIdMap.get(target) === undefined) {
      return { ok: false, message: `the ${slug} graph holds no node ${target}`, written: [] };
    }
    const refused = opts.force === true ? this.forceRefusal(read.graph) : undefined;
    if (refused !== undefined) return { ok: false, message: refused, written: [] };

    return this.session.while(BUSY_RUN, async () => {
      const project = await loadProject(this.session.dir);
      const deps = await buildGenDeps(project, opts.mock ?? false);
      const entry = (await this.loadGraphs(project, deps)).loaded.find((g) => g.slug === slug);
      if (entry === undefined) {
        return { ok: false, message: `the ${slug} graph could not be loaded`, written: [] };
      }

      const ctx: GenRunContext = {
        services: entry.services,
        journal : entry.journal,
        record  : entry.record,
      };
      const result = await executeGenGraph(read.graph, ctx, {
        targets: [target],
        seeds  : await graphSeeds(project, read.graph, target),
        ...(opts.force === true ? { force: true } : {}),
      });

      const written = [relPath(this.session.dir, graphJournalFile(project.paths, slug))];
      const failure = result.failures[0];
      if (failure !== undefined) {
        return { ok: false, message: `node ${failure.nodeId} failed: ${failure.error}`, written };
      }
      const ran = result.ran.length;
      const skipped = result.skipped.length;
      return {
        ok     : true,
        message:
          `Ran ${ran} node${ran === 1 ? '' : 's'} in ${slug}` +
          `${skipped === 0 ? '' : `, resuming ${skipped} from the journal`}.`,
        written,
      };
    });
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
    const project = await loadProject(this.session.dir);
    let keyError: string | null = null;
    if (!mock) {
      try {
        const keys = await resolveKeys(project.config, {
          secretsDirs: await secretDirsFor(project.dir),
        });
        resolveRoutes(project.config, keys, projectModels(project.config));
      } catch (err) {
        keyError = err instanceof Error ? err.message : String(err);
      }
    }
    const deps = await buildGenDeps(project, true);
    const graphs = await this.graphRuntime(project, deps);
    const summary = await runPipeline({
      model    : project.model,
      graph    : project.graph,
      store    : project.store,
      providers: deps.providers,
      config   : project.config,
      paths    : project.paths,
      dryRun   : true,
      now      : () => new Date().toISOString(),
      ...(graphs === undefined ? {} : { graphs }),
    });
    return {
      pending      : summary.preview.pendingTasks,
      byKind       : summary.preview.byKind,
      imageCalls   : summary.preview.imageCalls,
      reviewCalls  : summary.preview.reviewCalls,
      blockedOnGate: summary.blockedOnGate,
      gatePending  : summary.gate.pending,
      keyError,
    };
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
    const project = await loadProject(this.session.dir);
    let keyError: string | null = null;
    try {
      const keys = await resolveKeys(project.config, {
        secretsDirs: await secretDirsFor(project.dir),
      });
      resolveRoutes(project.config, keys, { chat: [project.config.models.text] });
    } catch (err) {
      keyError = err instanceof Error ? err.message : String(err);
    }
    return { ...(await decomposeAllPreview(project.model, project.paths)), keyError };
  }

  /**
   * Decompose every reachable scene that has no storyboard yet. Real providers always: a mock
   * decomposition is the deterministic baseline, and `decomposeAll` would decline to write it —
   * so running this against mocks would be a no-op that looked like work.
   */
  async decomposeAllScenes(): Promise<DecomposeAllResult> {
    return this.session.while('decomposing scenes', async () => {
      const project = await loadProject(this.session.dir);
      return decomposeAll({
        model    : project.model,
        config   : project.config,
        providers: await buildProviders(project, false),
        paths    : project.paths,
      });
    });
  }

  /**
   * Run the pipeline, or with `only` just those tasks and what they need — the scheduler's own
   * `only`, which is what a regenerate and a slot's Generate button ask for.
   */
  async runPipeline(mock: boolean, only?: readonly string[]): Promise<PipelineRunResult> {
    // The whole method, loads included: `busy()` has to be true from the call, not from the
    // moment the scheduler starts, or a switch could land in the gap.
    const outer = this.session.cancel;
    const cancel = outer ?? new AbortController();
    this.session.cancel = cancel;
    const abort = new AbortController();
    this.session.abortTasks = abort;
    const { summary, assets } = await this.session
      .while(BUSY_RUN, async () => {
        const project = await loadProject(this.session.dir);
        const deps = await buildGenDeps(project, mock);
        const graphs = await this.graphRuntime(project, deps);
        const ran = await runPipeline({
          model    : project.model,
          graph    : project.graph,
          store    : project.store,
          providers: deps.providers,
          config   : project.config,
          paths    : project.paths,
          dryRun   : mock,
          now      : () => new Date().toISOString(),
          signal   : cancel.signal,
          abort    : abort.signal,
          ...(only === undefined ? {} : { only }),
          ...(graphs === undefined ? {} : { graphs }),
          onProgress: (p) => {
            this.session.progress = { ran: p.ran, pending: p.pending, activity: p.activity };
            this.session.announceBusy();
          },
        });
        // Read the manifest inside the closure, while the project that ran is still in hand — the
        // labels below name pictures this run produced, and reloading to find them is a second read
        // of everything for a handful of hashes.
        return { summary: ran, assets: project.store.manifest() };
      })
      .finally(() => {
        // A pass owns its controller for every round it still has to take, so only a run that made
        // its own clears it.
        if (!outer && this.session.cancel === cancel) this.session.cancel = undefined;
        if (this.session.abortTasks === abort) this.session.abortTasks = undefined;
      });
    this.announceRun(summary, assets, mock);
    return {
      ran          : summary.ran.length,
      blockedOnGate: summary.blockedOnGate,
      gatePending  : summary.gate.pending,
      preview: {
        pendingTasks: summary.preview.pendingTasks,
        imageCalls  : summary.preview.imageCalls,
        reviewCalls : summary.preview.reviewCalls,
      },
      failed       : summary.failed.length,
      failures     : summary.failed.map((t) => ({ hash: t.hash, kind: t.kind, error: t.error })),
      ...(summary.stopped ? { stopped: true } : {}),
      ...(summary.aborted ? { aborted: summary.aborted.length } : {}),
    };
  }

  /**
   * File what the run did: one notification per picture it produced, each linked to the asset
   * editor by the hash it made, and one for the run itself.
   *
   * These all arrive at the end, and deliberately: a notification is a durable record of what
   * happened, so the count that moves while a run is in flight is the `busy` push instead.
   */
  private announceRun(summary: RunSummary, assets: readonly Asset[], mock: boolean): void {
    for (const task of summary.ran) {
      const hash = task.output;
      if (task.status !== 'done' || !hash) continue;
      const asset = assets.find((a) => a.hash === hash);
      const label = asset ? assetSlotLabel(asset) : `${task.kind} ${hash.slice(0, 8)}`;
      void notify({
        category: 'asset',
        source  : 'pipeline',
        message : `Rendered ${label}.`,
        link    : { editor: 'asset', subject: hash },
      });
    }

    // A failure inherited from an earlier run is at its retry budget and was not attempted
    // again, so its error is not re-reported as if this run had produced it
    const attempted = new Set(summary.ran.map((t) => t.hash));
    const inherited: string[] = [];
    for (const task of summary.failed) {
      if (!attempted.has(task.hash)) {
        inherited.push(`${task.kind} ${task.hash.slice(0, 8)}`);
        continue;
      }
      void notify({
        category: 'error',
        level   : 'error',
        source  : 'pipeline',
        message: `${task.kind} ${task.hash.slice(0, 8)} failed: ${task.error ?? 'no reason recorded'}.`,
      });
    }
    if (inherited.length > 0) {
      void notify({
        category: 'pipeline',
        level   : 'warn',
        source  : 'pipeline',
        message:
          `${inherited.length} task${inherited.length === 1 ? '' : 's'} still failed from an ` +
          `earlier run and out of retries, not attempted again: ${inherited.join(', ')}. ` +
          'Regenerate one to try it again.',
      });
    }

    const ran = summary.ran.length;
    const how = mock ? 'Dry run' : 'Run';
    const gate = summary.blockedOnGate ? ', halted at the character gate' : '';
    const ended = summary.stopped ? 'stopped' : 'finished';
    // Named, because otherwise a picture the author did not ask for changes with no explanation
    const redrawn = summary.redrawn.length
      ? `, ${summary.redrawn.length} redrawn for an edited graph`
      : '';
    void notify({
      category: 'pipeline',
      level   : summary.failed.length > 0 ? 'warn' : 'info',
      source  : 'pipeline',
      message: `${how} ${ended}: ${ran} task${ran === 1 ? '' : 's'}, ${summary.failed.length} failed${redrawn}${gate}.`,
    });
  }
}
