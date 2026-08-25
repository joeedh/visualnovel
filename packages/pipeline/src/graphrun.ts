/**
 * Running one task through the generation graph its slot is bound to. The task's derived
 * prompt and reference assets are seeded onto the graph's host-seeded inputs, the graph is
 * executed against the slot's active output node, and the picture it terminates on is
 * written to the asset store through the same call the legacy runners use. A slot nothing
 * is bound to never reaches this file.
 */
import type { AnyTask, AssetMeta, AssetRef, ProjectModel, RefBinding } from '@vn/types';
import { slotKey } from '@vn/artgen';
import { bindSlots, executeGenGraph, genNodeSpec, registerGenRuntimes } from '@vn/gengraph';
import type {
  GenImageRef,
  GenOutputs,
  GenRunContext,
  GenServices,
  Graph,
  GraphId,
  GraphJournal,
  GraphJournalRecord,
} from '@vn/gengraph';
import type { RunDeps } from './pipeline.js';

/** The type names of the three nodes a host seeds, which are also the seed's keys. */
const DERIVED_PROMPT = 'GenDerivedPrompt';
const TASK_REFS = 'GenTaskRefs';
const REFINE_PROMPT = 'GenRefinePrompt';

/** One graph as a host holds it, with the journal and services it runs against. */
export interface LoadedGraph {
  graph: Graph;
  /** The journal as it stands on disk. A run's own records are tracked from here. */
  journal: GraphJournal;
  /** What this graph's nodes reach, carrying the blob store kept under its own slug. */
  services: GenServices;
  /** Appends one record; the host persists it. */
  record(record: GraphJournalRecord): Promise<void>;
}

/** One slot's graph, together with the output node a run targets. */
export interface GraphBinding extends LoadedGraph {
  target: GraphId;
}

/**
 * What the host offers a runner about the graphs it has loaded. This is the slot→graph
 * index built by scanning every graph's output bindings, and it answers undefined for every
 * slot while no graph names one.
 */
export interface GraphRuntime {
  bound(slot: string): GraphBinding | undefined;
}

/** The slot→graph index, and the slots left out of it. */
export interface GraphIndex {
  runtime: GraphRuntime;
  /** Slots more than one active output claims, which stay bound to no graph. */
  conflicts: string[];
}

/**
 * Indexes the loaded graphs by the slot each active output binds to, through the same
 * `bindSlots` rule the document tree and the CLI's report read. A slot two active outputs
 * claim is left unbound and reported.
 */
export function indexGraphs(loaded: readonly LoadedGraph[]): GraphIndex {
  const { bound, conflicts } = bindSlots(loaded);
  const index = new Map<string, GraphBinding>();
  for (const [slot, { entry, target }] of bound) {
    index.set(slot, { ...entry, target });
  }
  return { runtime: { bound: (slot) => index.get(slot) }, conflicts };
}

/** The slot a task fills, which is the address a graph binds itself to. */
export function slotOfTask(task: AnyTask, model: ProjectModel): string | undefined {
  const said = task.inputs as {
    characterId?: string;
    outfit?: string;
    angle?: string;
    locationId?: string;
    variant?: string;
    shotId?: string;
  };
  const binding = bindingOf(task.kind, said, model);
  return binding === undefined ? undefined : slotKey(binding);
}

function bindingOf(
  kind: AnyTask['kind'],
  said: {
    characterId?: string;
    outfit?: string;
    angle?: string;
    locationId?: string;
    variant?: string;
    shotId?: string;
  },
  model: ProjectModel,
): RefBinding | undefined {
  switch (kind) {
    case 'portrait':
      return said.characterId ? { kind: 'portrait', characterId: said.characterId } : undefined;
    case 'location_ref':
      return said.locationId && said.variant
        ? { kind: 'plate', locationId: said.locationId, variant: said.variant }
        : undefined;
    case 'model_sheet':
    case 'outfit_sheet':
      return said.characterId && said.outfit && said.angle
        ? {
            kind: 'sheet',
            characterId: said.characterId,
            outfit: said.outfit,
            angle: said.angle,
          }
        : undefined;
    case 'shot_image': {
      const sceneId = said.shotId === undefined ? undefined : sceneOfShot(model, said.shotId);
      return sceneId && said.shotId ? { kind: 'shot', sceneId, shotId: said.shotId } : undefined;
    }
    default:
      return undefined;
  }
}

function sceneOfShot(model: ProjectModel, shotId: string): string | undefined {
  for (const scene of model.scenes.values()) {
    if (scene.shots.some((shot) => shot.id === shotId)) {
      return scene.id;
    }
  }
  return undefined;
}

let registered = false;

/** The graph bound to this task's slot, with the built-in runtimes registered by then. */
export function boundGraph(task: AnyTask, deps: RunDeps): GraphBinding | undefined {
  const runtime = deps.graphs;
  if (runtime === undefined) {
    return undefined;
  }

  const slot = slotOfTask(task, deps.model);
  if (slot === undefined) {
    return undefined;
  }

  if (!registered) {
    registerGenRuntimes();
    registered = true;
  }
  return runtime.bound(slot);
}

/**
 * Whether a refine pass re-enters this graph through a wired refine node. The declared
 * `refineInput` socket names where a critique goes back in, so a graph with nothing wired
 * to one takes its critique on the derived prompt instead.
 */
export function refinesThroughNode(graph: Graph): boolean {
  let wired = false;
  let seeded = false;

  for (const node of graph.nodes) {
    if (node.def.typeName === REFINE_PROMPT) {
      seeded = true;
    }
    const key = genNodeSpec(node.def.typeName)?.refineInput;
    if (key !== undefined && (node.inputs[key]?.edges.length ?? 0) > 0) {
      wired = true;
    }
  }

  return wired && seeded;
}

/** What one pass through a bound graph drew. */
export interface GraphDraw {
  image: GenImageRef;
  /** The prompt the terminal picture was drawn from, for the asset's provenance. */
  prompt: string;
  modelId: string;
}

export interface GraphRunOptions {
  /** The task's derived prompt, seeded onto the graph's derived-prompt node. */
  prompt: string;
  /** The task's reference assets, seeded as the JSON an `AssetRef[]` writes to. */
  refs: readonly AssetRef[];
  /** A refine pass's critique, seeded onto the refine node when the graph holds one. */
  critique?: string;
  /** Re-runs every paid ancestor rather than resuming it. */
  force?: boolean;
}

/**
 * Executes the bound graph once and reports the picture its output node terminates on.
 * A failed node throws with the sentence the journal recorded, so the task's own failure
 * record names what went wrong inside the graph. The binding's journal is advanced to what
 * this run left behind, which is what lets a refine attempt resume the nodes the attempt
 * before it already ran.
 */
export async function runBoundGraph(
  deps: RunDeps,
  binding: GraphBinding,
  options: GraphRunOptions,
): Promise<GraphDraw> {
  const latest = new Map(binding.journal.latest);
  const lastDone = new Map(binding.journal.lastDone);
  const ctx: GenRunContext = {
    services: binding.services,
    journal: { latest, lastDone, skipped: binding.journal.skipped },
    record: async (record) => {
      latest.set(record.nodeId, record);
      if (record.status === 'done') {
        lastDone.set(record.nodeId, record);
      }
      await binding.record(record);
    },
    ...(deps.now === undefined ? {} : { now: (): Date => new Date(deps.now!()) }),
  };

  const result = await executeGenGraph(binding.graph, ctx, {
    targets: [binding.target],
    seeds: {
      [DERIVED_PROMPT]: { prompt: options.prompt },
      [TASK_REFS]: { assets: JSON.stringify(options.refs) },
      [REFINE_PROMPT]: { text: options.critique ?? '' },
    },
    ...(options.force === true ? { force: true } : {}),
  });
  binding.journal = { latest, lastDone, skipped: binding.journal.skipped };

  const failure = result.failures[0];
  if (failure !== undefined) {
    throw new Error(failure.error);
  }

  const image = imageOf(result.outputs.get(binding.target)?.image);
  if (image === undefined) {
    throw new Error('the bound graph ran, but its output node terminated on no picture');
  }

  return { image, ...provenanceOf(result.outputs, image) };
}

/**
 * What drew the terminal picture, taken from the record of the node that wrote it. The
 * image nodes report their model and prompt beside the picture, and an output node only
 * passes the picture along, so the provenance is read back by hash.
 */
function provenanceOf(
  outputs: ReadonlyMap<GraphId, GenOutputs>,
  image: GenImageRef,
): { prompt: string; modelId: string } {
  for (const answered of outputs.values()) {
    const drawn = imageOf(answered.image);
    if (drawn?.hash !== image.hash) {
      continue;
    }
    if (typeof answered.modelId === 'string' && typeof answered.prompt === 'string') {
      return { prompt: answered.prompt, modelId: answered.modelId };
    }
  }
  // A picture the graph read rather than drew — an image-file node, or a slot reference the
  // switch selected — was generated by an earlier run whose provenance the manifest holds.
  return { prompt: '', modelId: '' };
}

function imageOf(value: unknown): GenImageRef | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const ref = value as Partial<GenImageRef>;
  return typeof ref.hash === 'string' && typeof ref.ext === 'string' && ref.store !== undefined
    ? (ref as GenImageRef)
    : undefined;
}

/**
 * Writes a graph's terminal picture into the asset store with the metadata the legacy
 * runners write, so nothing downstream can tell which path drew it. `refs` names the task's
 * own reference assets rather than the pictures the graph attached, because a graph
 * reference may be a blob and the manifest addresses assets.
 */
export async function storeGraphImage(
  deps: RunDeps,
  binding: GraphBinding,
  draw: GraphDraw,
  fallback: { prompt: string; refs: readonly AssetRef[] },
  meta: Omit<AssetMeta, 'prompt' | 'refs' | 'modelId'>,
): Promise<AssetRef> {
  const bytes = await readDrawn(binding.services, draw.image);
  return deps.store.write(bytes, draw.image.ext, {
    ...meta,
    prompt: draw.prompt.length > 0 ? draw.prompt : fallback.prompt,
    refs: fallback.refs.map((r) => r.hash),
    modelId: draw.modelId,
  });
}

async function readDrawn(services: GenServices, ref: GenImageRef): Promise<Uint8Array> {
  const bytes =
    ref.store === 'asset'
      ? await services.assets.read({ hash: ref.hash, ext: ref.ext })
      : await services.blobs.read(ref.hash);

  if (bytes === undefined) {
    throw new Error(`the ${ref.store} store holds no bytes for '${ref.hash}'`);
  }
  return bytes;
}
