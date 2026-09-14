/**
 * OpenRouter's image models as one node. It calls OpenRouter over the host's recorded transport
 * with a key the host resolved, so any image model OpenRouter lists can draw a slot without
 * this application having a backend for it.
 */
import type {
  GenImageInput,
  GenImageRef,
  GenInputs,
  GenOutputs,
  GenPluginApi,
  GenProps,
  GenServices,
} from '@vn/gengraph/plugin';

import { drawWithOpenRouter, readImage } from './draw.js';
import { GENERATE_TYPE, generateSpec } from './nodes.js';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
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

async function readRefs(services: GenServices, value: unknown): Promise<GenImageInput[]> {
  const refs = Array.isArray(value)
    ? value.map(imageOf).filter((r): r is GenImageRef => r !== undefined)
    : [];

  const out: GenImageInput[] = [];
  for (const ref of refs) {
    out.push(await readImage(services, ref));
  }
  return out;
}

/** Joins the derived prompt and a refine pass's critique, dropping whichever is empty. */
function joinPrompt(...parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join('\n\n');
}

/** Refuses an unreadable seed rather than dropping it, because zero is a valid seed. */
function seedOf(value: unknown): number | undefined {
  const said = text(value).trim();
  if (said.length === 0) {
    return undefined;
  }

  const seed = Number(said);
  if (!Number.isFinite(seed)) {
    throw new Error(`the seed '${said}' is not a number`);
  }
  return seed;
}

/** What the node reads off its own props before drawing. */
function settings(props: GenProps): { model: string; aspect?: string; seed?: number } {
  const aspect = text(props['aspect']).trim();
  const seed = seedOf(props['seed']);
  return {
    model: text(props['model']),
    ...(aspect.length === 0 ? {} : { aspect }),
    ...(seed === undefined ? {} : { seed }),
  };
}

/**
 * Draws the picture and writes it where every node below can read it. The model id, the
 * prompt and what OpenRouter said the call cost ride along in the run's record, so a host
 * stamping provenance knows what drew the picture, what it was asked for, and what it spent.
 */
async function generate(
  inputs: GenInputs,
  props: GenProps,
  services: GenServices,
): Promise<GenOutputs> {
  const prompt = joinPrompt(text(inputs['prompt']), text(inputs['refine']));
  const draw = settings(props);
  const picture = await drawWithOpenRouter(services, {
    ...draw,
    prompt,
    images: await readRefs(services, inputs['refs']),
  });
  const ref = await services.blobs.write(picture.bytes, picture.ext);
  return {
    image  : { store: 'blob', hash: ref.hash, ext: ref.ext },
    modelId: draw.model,
    prompt,
    ...(picture.cost === undefined ? {} : { cost: picture.cost }),
  };
}

export default function activate(api: GenPluginApi): void {
  api.registerNode(generateSpec(api));
  api.registerRuntime(GENERATE_TYPE, generate);
}
