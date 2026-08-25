import { registerNodeType } from 'pathux-graph';
import type { NodeTypeConstructor } from 'pathux-graph';

import type { GenServices } from './services.js';

/** Values carried on sockets between node runs. */
export type GenInputs = Readonly<Record<string, unknown>>;
export type GenProps = Readonly<Record<string, unknown>>;
export type GenOutputs = Record<string, unknown>;

/** One node type's work. Registered only in a host that can supply services. */
export type GenNodeRun = (
  inputs: GenInputs,
  props: GenProps,
  services: GenServices,
) => Promise<GenOutputs>;

/** What a priced call is counted in. A `mtok-` count is measured in millions of tokens. */
export type GenCostUnit = 'image' | 'mtok-in' | 'mtok-out';

/** One call a node is expected to make, before a price table turns it into dollars. */
export interface GenCostLine {
  /** The `GenServices` capability the call goes through, such as `image` or `text`. */
  service: string;
  model: string;
  unit: GenCostUnit;
  count: number;
}

/** What a node knows about its inputs before anything has run. */
export interface GenEstimateContext {
  /** Input socket keys wired to something upstream. */
  connected: ReadonlySet<string>;
}

/** Answers what one run of a node is expected to spend. */
export type GenNodeEstimate = (props: GenProps, ctx: GenEstimateContext) => GenCostLine[];

/** What the generator needs to know about a node type beyond its sockets and props. */
export interface GenNodeSpec {
  /** The path.ux node class declaring this type's sockets and props. */
  cls: NodeTypeConstructor;
  /** True when running this node calls a paid model. */
  spends?: boolean;
  /** Names the prop holding the slot key this node fills. Only an output node has one. */
  slotProp?: string;
  /** What one run costs. A type with no estimate is taken to spend nothing. */
  estimate?: GenNodeEstimate;
  /** Names the input socket a refine pass re-enters this node's chain at. */
  refineInput?: string;
  /** True for the node a refine pass re-enters at while no refine input is wired. */
  refineFallback?: boolean;
}

const specs = new Map<string, GenNodeSpec>();
const classes = new Map<string, NodeTypeConstructor>();
const runtimes = new Map<string, GenNodeRun>();

/**
 * Registers a node type with path.ux and records its generator spec. A declared
 * slotProp is checked against a constructed instance, so a typo fails here rather
 * than silently leaving an output node unable to name the slot it fills.
 */
export function registerGenNode(spec: GenNodeSpec): void {
  registerNodeType(spec.cls);

  const typeName = spec.cls.graphDef().typeName;

  if (spec.slotProp !== undefined) {
    const probe = new spec.cls();
    if (probe.props[spec.slotProp] === undefined) {
      throw new Error(`${typeName}: slotProp '${spec.slotProp}' names no prop on this node type`);
    }
  }

  specs.set(typeName, spec);
  classes.set(typeName, spec.cls);
}

export function genNodeSpec(typeName: string): GenNodeSpec | undefined {
  return specs.get(typeName);
}

export function genNodeSpecs(): ReadonlyMap<string, GenNodeSpec> {
  return specs;
}

/** The registered classes keyed by type name, in the shape buildGraphFromDSL wants. */
export function genNodeTypes(): ReadonlyMap<string, NodeTypeConstructor> {
  return classes;
}

/** Binds a node type's work to its spec. Refuses a type name nothing registered. */
export function registerGenRuntime(typeName: string, run: GenNodeRun): void {
  if (!specs.has(typeName)) {
    throw new Error(`no gen node type '${typeName}' is registered, so it can have no runtime`);
  }
  runtimes.set(typeName, run);
}

export function genNodeRuntime(typeName: string): GenNodeRun | undefined {
  return runtimes.get(typeName);
}
