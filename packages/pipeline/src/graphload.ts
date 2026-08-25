/**
 * Loading a project's generation graphs, and reporting what they bind, what they are expected
 * to spend, and which of them have moved since they last ran. The desktop session reads a
 * graph through git so a conflicted file is refused by name and the CLI reads the file
 * directly, so the reader is a parameter. Everything either host does with the result lives
 * here, which is also how `vngen` reaches `@vn/gengraph` without importing it: the CLI's
 * allow-list stops at `@vn/pipeline`.
 */
import type { AnyTask, Asset, ProjectModel, Shot } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { ProjectPaths } from '@vn/store';
import { buildSlotGraph } from '@vn/artgen';
import {
  activeOutputs,
  bindSlots,
  estimateGraph,
  genPriceTables,
  priceEstimate,
  pricesAreStale,
  registerGenRuntimes,
} from '@vn/gengraph';
import type {
  GenPriceTable,
  GenPricedEstimate,
  Graph,
  GraphId,
  GraphJournal,
  GraphJournalRecord,
} from '@vn/gengraph';
import {
  appendGraphJournal,
  graphBlobStore,
  graphDrift,
  graphSlugs,
  installedPriceTables,
  readGraphDoc,
  readGraphJournal,
  readUserPrices,
  type GraphRead,
} from '@vn/gengraph/state';
import type { GenServicesDeps } from './genservices.js';
import { createGenServices } from './genservices.js';
import { indexGraphs, type GraphIndex, type LoadedGraph } from './graphrun.js';

/** One graph as it stands on disk, with the journal its runs have written so far. */
export interface GraphDoc {
  slug: string;
  graph: Graph;
  journal: GraphJournal;
}

/** How a host turns a slug into a graph. The default reads the file with no conflict check. */
export type GraphReader = (root: string, slug: string) => Promise<GraphRead>;

export interface ProjectGraphs {
  docs: GraphDoc[];
  /** One sentence for each graph that would not load, in the words the reader refused it with. */
  problems: string[];
}

/**
 * Every graph the project holds, with its journal replayed. A graph that will not load is left
 * out and its reason reported rather than thrown, because a run that quietly fell back to the
 * fixed runners would draw a picture nobody asked for.
 */
export async function readProjectGraphs(
  root: string,
  paths: ProjectPaths,
  opts: { read?: GraphReader } = {},
): Promise<ProjectGraphs> {
  const read = opts.read ?? readGraphDoc;
  const docs: GraphDoc[] = [];
  const problems: string[] = [];

  for (const slug of await graphSlugs(root)) {
    const answer = await read(root, slug);
    if (!answer.ok) {
      problems.push(answer.reason);
      continue;
    }
    docs.push({ slug, graph: answer.graph, journal: await readGraphJournal(paths, slug) });
  }

  return { docs, problems };
}

/** What a graph's services are built from, apart from the blob store each graph gets its own of. */
export type GraphHostDeps = Omit<GenServicesDeps, 'blobs'>;

/**
 * The slot→graph index a run consults, built by giving each graph its services and journal
 * writer and indexing the outputs. The built-in runtimes are registered first, because a graph
 * deserialized before them carries nodes that cannot run.
 */
export function graphRuntime(
  paths: ProjectPaths,
  docs: readonly GraphDoc[],
  deps: GraphHostDeps,
): GraphIndex {
  registerGenRuntimes();

  const loaded: LoadedGraph[] = docs.map((doc) => ({
    graph: doc.graph,
    journal: doc.journal,
    services: createGenServices({ ...deps, blobs: graphBlobStore(paths, doc.slug) }),
    record: (record: GraphJournalRecord) => appendGraphJournal(paths, doc.slug, record),
  }));

  return indexGraphs(loaded);
}

/** One slot a graph draws, with what a run of that graph is expected to spend. */
export interface GraphSlotEstimate {
  slug: string;
  nodeId: GraphId;
  /**
   * One whole run of the graph, priced. Every node counts, so a graph carrying a second output
   * quotes more than drawing this slot alone spends.
   */
  estimate: GenPricedEstimate;
}

/** One output node whose graph has changed since that node last ran. */
export interface GraphSlotDrift {
  slug: string;
  nodeId: GraphId;
  /** The slot the node fills. Empty where the node is no longer active or names no slot. */
  slot: string;
}

export interface GraphsReport {
  /** Slot key → the graph that draws it. A slot two active outputs claim is left out. */
  bound: Map<string, GraphSlotEstimate>;
  /** Slots more than one active output claims, which stay bound to no graph. */
  conflicts: string[];
  drifted: GraphSlotDrift[];
  /** The oldest `pricesAsOf` any estimate drew on. */
  pricesAsOf?: string;
  /** True once that table is older than `PRICES_STALE_DAYS`. */
  stale: boolean;
}

export interface GraphsReportOptions {
  /** From `config.max_refine_attempts`; the refine tail is counted this many times. */
  maxRefineAttempts?: number;
  /** The clock a price table's age is measured against. Defaults to the current time. */
  now?: Date;
  /**
   * The price tables to consult, in order, the way `genPriceTables` arranges them. Only the
   * shipped table is consulted when this is left out, so a host that has not read the author's
   * own table still prices the models this repository configures.
   */
  tables?: readonly GenPriceTable[];
}

/**
 * The tables a host prices an estimate against, in the order they are consulted: the author's
 * own first, then the one this release shipped with, then whatever the installed plugins
 * declare. It reads the per-user directory rather than the project, so two projects on one
 * machine quote the same figures.
 */
export async function hostPriceTables(): Promise<GenPriceTable[]> {
  const user = await readUserPrices();
  return genPriceTables({
    ...(user === undefined ? {} : { user }),
    plugins: await installedPriceTables(),
  });
}

/**
 * What the project's graphs bind and are expected to spend. Nothing here reads the task graph,
 * so a slot no wave has planned yet is priced the same as one already pending.
 */
export function reportGraphs(
  docs: readonly GraphDoc[],
  opts: GraphsReportOptions = {},
): GraphsReport {
  const priced: { slug: string; graph: Graph; estimate: GenPricedEstimate }[] = [];
  const drifted: GraphSlotDrift[] = [];
  const dates: string[] = [];

  for (const doc of docs) {
    const counted = estimateGraph(doc.graph, {
      ...(opts.maxRefineAttempts === undefined
        ? {}
        : { maxRefineAttempts: opts.maxRefineAttempts }),
    });
    const estimate =
      opts.tables === undefined
        ? priceEstimate(counted.lines)
        : priceEstimate(counted.lines, opts.tables);
    if (estimate.pricesAsOf !== undefined) {
      dates.push(estimate.pricesAsOf);
    }
    priced.push({ slug: doc.slug, graph: doc.graph, estimate });

    const slotOfNode = new Map<GraphId, string>(
      activeOutputs(doc.graph).map((output) => [output.id, output.slot]),
    );
    for (const drift of graphDrift(doc.graph, doc.journal)) {
      drifted.push({
        slug: doc.slug,
        nodeId: drift.nodeId,
        slot: slotOfNode.get(drift.nodeId) ?? '',
      });
    }
  }

  const { bound: claims, conflicts } = bindSlots(priced);
  const bound = new Map<string, GraphSlotEstimate>(
    [...claims].map(([slot, { entry, target }]) => [
      slot,
      { slug: entry.slug, nodeId: target, estimate: entry.estimate },
    ]),
  );

  dates.sort();
  const pricesAsOf = dates[0];
  return {
    bound,
    conflicts,
    drifted,
    ...(pricesAsOf === undefined ? {} : { pricesAsOf }),
    stale: pricesAsOf === undefined ? false : pricesAreStale(pricesAsOf, opts.now ?? new Date()),
  };
}

/** What the project holds that says which pictures it implies and which of them exist. */
export interface ProjectSlotInputs {
  model: ProjectModel;
  config: ProjectConfig;
  assets: readonly Asset[];
  /** A scene's persisted shots, by scene id. */
  shots: ReadonlyMap<string, readonly Shot[] | null>;
  graph: { get(hash: string): AnyTask | undefined };
}

/**
 * The slots a graph draws that nothing has drawn yet, upstream before downstream. Every slot
 * the project implies is enumerated, planned or not, because the planner runs one wave per run
 * and a slot a later wave unlocks would otherwise be priced at nothing.
 */
export function unrenderedBoundSlots(report: GraphsReport, inputs: ProjectSlotInputs): string[] {
  const slots = buildSlotGraph({
    model: inputs.model,
    config: inputs.config,
    assets: inputs.assets,
    shots: inputs.shots,
    graph: inputs.graph,
    angleOf: (sourceTask) => {
      const task = sourceTask === undefined ? undefined : inputs.graph.get(sourceTask);
      return task && 'angle' in task.inputs ? task.inputs.angle : undefined;
    },
  });

  return slots.order.filter((key) => {
    const node = slots.nodes.get(key);
    return report.bound.has(key) && node !== undefined && node.candidates.length === 0;
  });
}

/** What drawing a set of graph-bound slots is expected to cost. */
export interface GraphSlotCost {
  /** How many of the slots asked about a graph actually draws. */
  slots: number;
  usd: number;
  /** The models no price table covered, sorted, so a total can say what it left out. */
  unpriced: string[];
}

/** Adds up one run of the bound graph for each slot named. A slot no graph draws is skipped. */
export function priceSlots(report: GraphsReport, slots: Iterable<string>): GraphSlotCost {
  const unpriced = new Set<string>();
  let counted = 0;
  let usd = 0;

  for (const slot of slots) {
    const bound = report.bound.get(slot);
    if (bound === undefined) {
      continue;
    }
    counted += 1;
    usd += bound.estimate.usd;
    for (const line of bound.estimate.unpriced) {
      unpriced.add(line.model);
    }
  }

  return { slots: counted, usd, unpriced: [...unpriced].sort() };
}
