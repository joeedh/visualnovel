import type { Graph, GraphId, Node } from 'pathux-graph';

import { authoredHashes, graphHashes } from './hash.js';
import { journalRecord } from './journal.js';
import type { GenUsage, GraphJournal, GraphJournalRecord } from './journal.js';
import { genNodeRuntime, genNodeSpec } from './registry.js';
import type { GenInputs, GenOutputs, GenProps } from './registry.js';
import type { GenServices } from './services.js';

/** What one run reaches outside the graph itself. */
export interface GenRunContext {
  services: GenServices;
  /** The journal as it stood before this run, which is what resume is decided against. */
  journal: GraphJournal;
  /** Appends one record. The host persists it and the executor keeps its own view current. */
  record(record: GraphJournalRecord): Promise<void>;
  /** Supplies the timestamp on every record, so a test can hold the clock still. */
  now?(): Date;
  /**
   * Answers what the node's run just consumed, read once its runtime resolves. The
   * services report no usage of their own, so the host's provider adapter answers this.
   */
  usage?(node: Node): GenUsage | undefined;
}

export interface GenExecuteOptions {
  /** The nodes to evaluate. Everything upstream of one is evaluated with it. */
  targets: readonly GraphId[];
  /**
   * Values the host supplies on input sockets, keyed by node type name and then by socket
   * name. A seeded socket the author wired something into keeps what the author wired.
   */
  seeds?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Re-runs every paid ancestor of a target rather than resuming it from the journal. */
  force?: boolean;
}

export interface GenNodeFailure {
  nodeId: GraphId;
  error: string;
}

export interface GenRunResult {
  /** Nodes whose runtime ran this time. */
  ran: GraphId[];
  /** Nodes resumed from a journal record matching their current hash. */
  skipped: GraphId[];
  /** Nodes left unevaluated because something upstream of them failed. */
  blocked: GraphId[];
  failures: GenNodeFailure[];
  /** Each evaluated node's outputs, whether it ran or resumed. */
  outputs: Map<GraphId, GenOutputs>;
}

/**
 * Evaluates the targets and their ancestors in topological order, resuming every node
 * whose last record already matches its hash. A node on a branch no target descends from
 * never runs, which is what keeps a scratch branch from spending money. A failure is
 * recorded and stops that node's downstream; branches beside it still run.
 */
export async function executeGenGraph(
  graph: Graph,
  ctx: GenRunContext,
  options: GenExecuteOptions,
): Promise<GenRunResult> {
  seedInputs(graph, options.seeds);

  const hashes = graphHashes(graph);
  const authored = authoredHashes(graph);
  const wanted = ancestorsOf(graph, options.targets);
  const order = graph.sort().order.filter((node) => wanted.has(node.id));

  if (order.length !== wanted.size) {
    throw new Error('the run targets a node inside a cycle, which has no order to run in');
  }

  const stamp = (): string => (ctx.now?.() ?? new Date()).toISOString();
  const latest = new Map(ctx.journal.latest);

  const write = async (record: GraphJournalRecord): Promise<void> => {
    latest.set(record.nodeId, record);
    await ctx.record(record);
  };

  const hashOf = (node: Node): { nodeHash: string; authoredHash: string } => {
    const nodeHash = hashes.get(node.id);
    const authoredHash = authored.get(node.id);
    if (nodeHash === undefined || authoredHash === undefined) {
      throw new Error(`node ${String(node.id)} has no hash, so it cannot be run`);
    }
    return { nodeHash, authoredHash };
  };

  if (options.force === true) {
    await invalidateGenGraph(
      graph,
      { record: write, ...(ctx.now === undefined ? {} : { now: ctx.now }) },
      options.targets,
    );
  }

  const result: GenRunResult = {
    ran: [],
    skipped: [],
    blocked: [],
    failures: [],
    outputs: new Map(),
  };
  const blocked = new Set<GraphId>();
  // A node's hash covers what feeds it rather than what that produced, so an upstream node
  // that ran again may have answered differently at the same hash. Everything below it runs.
  const reran = new Set<GraphId>();

  for (const node of order) {
    if (feedsFrom(node, blocked)) {
      blocked.add(node.id);
      result.blocked.push(node.id);
      continue;
    }

    const hash = hashOf(node);
    const prior = latest.get(node.id);
    const stale = feedsFrom(node, reran);

    if (
      !stale &&
      prior?.status === 'done' &&
      prior.nodeHash === hash.nodeHash &&
      prior.output !== undefined
    ) {
      applyOutputs(node, prior.output);
      result.outputs.set(node.id, prior.output);
      result.skipped.push(node.id);
      continue;
    }

    const runtime = genNodeRuntime(node.def.typeName);
    if (runtime === undefined) {
      await fail(node, hash, `node type '${node.def.typeName}' has no runtime registered here`);
      continue;
    }

    await write(journalRecord({ nodeId: node.id, ...hash, status: 'running', at: stamp() }));

    let outputs: GenOutputs;
    try {
      outputs = await runtime(readInputs(node), readProps(node), ctx.services);
    } catch (err) {
      await fail(node, hash, err instanceof Error ? err.message : String(err));
      continue;
    }

    applyOutputs(node, outputs);
    result.outputs.set(node.id, outputs);
    result.ran.push(node.id);
    reran.add(node.id);

    const usage = ctx.usage?.(node);
    await write(
      journalRecord({
        nodeId: node.id,
        ...hash,
        status: 'done',
        output: outputs,
        at: stamp(),
        ...(usage === undefined ? {} : { usage }),
      }),
    );
  }

  return result;

  async function fail(
    node: Node,
    hash: { nodeHash: string; authoredHash: string },
    error: string,
  ): Promise<void> {
    await write(journalRecord({ nodeId: node.id, ...hash, status: 'failed', error, at: stamp() }));
    blocked.add(node.id);
    result.failures.push({ nodeId: node.id, error });
  }
}

/**
 * Records that every paid ancestor of the targets has to run again, which is what a
 * deliberate re-render asks for. Without it a bound slot whose nodes are all clean would
 * resume straight to the cached picture. Deterministic prep still resumes, because only a
 * node its type marks `spends` is invalidated. Returns the nodes it invalidated.
 */
export async function invalidateGenGraph(
  graph: Graph,
  ctx: Pick<GenRunContext, 'record' | 'now'>,
  targets: readonly GraphId[],
): Promise<GraphId[]> {
  const hashes = graphHashes(graph);
  const authored = authoredHashes(graph);
  const wanted = ancestorsOf(graph, targets);
  const at = (ctx.now?.() ?? new Date()).toISOString();
  const invalidated: GraphId[] = [];

  for (const node of graph.nodes) {
    const nodeHash = hashes.get(node.id);
    const authoredHash = authored.get(node.id);
    if (!wanted.has(node.id) || nodeHash === undefined || authoredHash === undefined) {
      continue;
    }
    if (genNodeSpec(node.def.typeName)?.spends !== true) {
      continue;
    }

    await ctx.record(
      journalRecord({ nodeId: node.id, nodeHash, authoredHash, status: 'invalidated', at }),
    );
    invalidated.push(node.id);
  }

  return invalidated;
}

/**
 * Writes the host's values onto the default of each seeded input socket. `graphHashes`
 * already reads an unconnected input through its default, so a seeded prompt reaches the
 * hash with no special case and nothing about it is persisted as authored state. The socket
 * must be the one the type's spec declares, because `authoredHashes` reads that declaration
 * to tell a task's own values apart from the graph an author wrote.
 */
function seedInputs(graph: Graph, seeds: GenExecuteOptions['seeds']): void {
  if (seeds === undefined) {
    return;
  }

  for (const node of graph.nodes) {
    const seeded = seeds[node.def.typeName];
    if (seeded === undefined) {
      continue;
    }

    for (const [key, value] of Object.entries(seeded)) {
      const prop = node.inputs[key]?.defaultProp;
      if (prop === undefined) {
        throw new Error(`node type '${node.def.typeName}' takes no seeded input '${key}'`);
      }
      if (genNodeSpec(node.def.typeName)?.seededInput !== key) {
        throw new Error(
          `node type '${node.def.typeName}' does not declare '${key}' as its seeded input, so a value put there would be read as authored graph state`,
        );
      }
      prop.setValue(value);
    }
  }
}

/** The targets together with every node reachable by walking their inputs upstream. */
function ancestorsOf(graph: Graph, targets: readonly GraphId[]): Set<GraphId> {
  const wanted = new Set<GraphId>();
  const stack: Node[] = [];

  for (const id of targets) {
    const node = graph.nodeIdMap.get(id);
    if (node === undefined) {
      throw new Error(`the run targets node ${String(id)}, which this graph does not hold`);
    }
    if (!wanted.has(id)) {
      wanted.add(id);
      stack.push(node);
    }
  }

  while (stack.length > 0) {
    const node = stack.pop()!;

    for (const id of sourceIds(node)) {
      const source = graph.nodeIdMap.get(id);
      if (source !== undefined && !wanted.has(id)) {
        wanted.add(id);
        stack.push(source);
      }
    }
  }

  return wanted;
}

/** The ids of the nodes feeding this one's inputs, with group proxies already resolved. */
function sourceIds(node: Node): GraphId[] {
  const ids: GraphId[] = [];

  for (const sock of Object.values(node.inputs)) {
    for (const src of sock.resolvedEdges()) {
      const owner = src.owningNode;
      if (owner !== undefined) {
        ids.push(owner.id);
      }
    }
  }

  return ids;
}

function feedsFrom(node: Node, ids: ReadonlySet<GraphId>): boolean {
  return sourceIds(node).some((id) => ids.has(id));
}

function readInputs(node: Node): GenInputs {
  const inputs: Record<string, unknown> = {};
  for (const [key, sock] of Object.entries(node.inputs)) {
    inputs[key] = sock.getValue();
  }
  return inputs;
}

function readProps(node: Node): GenProps {
  const props: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(node.props)) {
    props[key] = prop.getValue();
  }
  return props;
}

/**
 * Puts a run's answers on the sockets below it. A returned key naming no output socket is
 * carried in the journal record and nowhere else, which is how an output node reports the
 * picture it terminates on.
 */
function applyOutputs(node: Node, outputs: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(outputs)) {
    node.outputs[key]?.setValue(value);
  }
}
