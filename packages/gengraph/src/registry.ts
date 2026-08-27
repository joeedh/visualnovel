import { registerNodeType } from 'pathux-graph';
import type { Node, NodeTypeConstructor } from 'pathux-graph';

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

/**
 * One rename a node type has been through, which `migrateGraphJSON` replays over a file written
 * before it. Every map runs from the old key to the new one; a key the maps do not mention is
 * left where it is, so a step names only what moved.
 */
export interface NodeMigration {
  /** The `typeVersion` this step lands on. A node stamped below it is migrated. */
  to: number;
  inputs?: Readonly<Record<string, string>>;
  outputs?: Readonly<Record<string, string>>;
  props?: Readonly<Record<string, string>>;
  /**
   * Props whose text embeds `{input}` tokens naming this type's input sockets, such as a
   * template. Their tokens follow `inputs`, so authored text keeps pointing at the same wire.
   */
  placeholders?: readonly string[];
}

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
  /**
   * Names the input socket a host fills before a run. Its value belongs to the task rather
   * than to the graph, so `authoredHashes` reads it as though nothing had been seeded.
   */
  seededInput?: string;
  /** Names the input socket a refine pass re-enters this node's chain at. */
  refineInput?: string;
  /** True for the node a refine pass re-enters at while no refine input is wired. */
  refineFallback?: boolean;
  /** Every rename this type has been through, in any order; the last one lands on `typeVersion`. */
  migrations?: readonly NodeMigration[];
}

const specs = new Map<string, GenNodeSpec>();
const classes = new Map<string, NodeTypeConstructor>();
const runtimes = new Map<string, GenNodeRun>();

/**
 * Registers a node type with path.ux and records its generator spec. A declared
 * slotProp or seededInput is checked against a constructed instance, so a typo fails here
 * rather than silently leaving an output node unable to name the slot it fills, or a
 * seeded value counted as authored graph state.
 */
export function registerGenNode(spec: GenNodeSpec): void {
  registerNodeType(spec.cls);

  const typeName = spec.cls.graphDef().typeName;

  if (spec.slotProp !== undefined || spec.seededInput !== undefined || spec.migrations) {
    const probe = new spec.cls();
    if (spec.slotProp !== undefined && probe.props[spec.slotProp] === undefined) {
      throw new Error(`${typeName}: slotProp '${spec.slotProp}' names no prop on this node type`);
    }
    if (spec.seededInput !== undefined && probe.inputs[spec.seededInput] === undefined) {
      throw new Error(
        `${typeName}: seededInput '${spec.seededInput}' names no input on this node type`,
      );
    }
    if (spec.migrations) checkMigrations(typeName, spec, probe);
  }

  specs.set(typeName, spec);
  classes.set(typeName, spec.cls);
}

/**
 * Checks a type's renames against the class they were written for. A migration is replayed over
 * files nobody will look at again, so a target that names nothing, or a last step that stops
 * short of the declared `typeVersion`, has to fail here rather than at the next author's load.
 */
function checkMigrations(typeName: string, spec: GenNodeSpec, probe: Node): void {
  const steps = [...(spec.migrations ?? [])].sort((a, b) => a.to - b.to);
  const version = spec.cls.graphDef().typeVersion ?? 1;
  const last = steps[steps.length - 1];

  if (last === undefined || last.to !== version) {
    throw new Error(
      `${typeName}: its migrations land on v${last?.to ?? version}, but the type declares v${version}`,
    );
  }

  const named = (where: string, keys: Record<string, unknown>, renames?: Renames): void => {
    for (const to of Object.values(renames ?? {})) {
      if (keys[to] === undefined) {
        throw new Error(`${typeName}: a migration renames to '${to}', which is no ${where}`);
      }
    }
  };

  for (const step of steps) {
    named('input', probe.inputs, step.inputs);
    named('output', probe.outputs, step.outputs);
    named('prop', probe.props, step.props);
    for (const key of step.placeholders ?? []) {
      if (probe.props[step.props?.[key] ?? key] === undefined) {
        throw new Error(
          `${typeName}: a migration reads placeholders from '${key}', which is no prop`,
        );
      }
    }
  }
}

type Renames = Readonly<Record<string, string>>;

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
