/**
 * Gemini's image models as two nodes. Both call the vendor over the host's recorded
 * transport with a key the host resolved, which is the whole of what a plugin needs to add
 * a model this application was not built with.
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

import { drawWithGemini, readImage } from './draw.js';
import { EDIT_TYPE, GENERATE_TYPE, editSpec, generateSpec } from './nodes.js';
import { geminiPrices } from './prices.js';

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

/** What both nodes read off their own props before drawing. */
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
 * Writes the picture where every node below can read it. The model id and the prompt ride
 * along in the run's record, so a host stamping provenance knows what drew the picture and
 * what it was asked for.
 */
async function store(
  services: GenServices,
  picture: { bytes: Uint8Array; ext: string },
  model: string,
  prompt: string,
): Promise<GenOutputs> {
  const ref = await services.blobs.write(picture.bytes, picture.ext);
  return { image: { store: 'blob', hash: ref.hash, ext: ref.ext }, modelId: model, prompt };
}

async function generate(
  inputs: GenInputs,
  props: GenProps,
  services: GenServices,
): Promise<GenOutputs> {
  const prompt = joinPrompt(text(inputs['prompt']), text(inputs['refine']));
  const draw = settings(props);
  const picture = await drawWithGemini(services, {
    ...draw,
    prompt,
    images: await readRefs(services, inputs['refs']),
  });
  return store(services, picture, draw.model, prompt);
}

async function edit(
  inputs: GenInputs,
  props: GenProps,
  services: GenServices,
): Promise<GenOutputs> {
  const base = imageOf(inputs['base']);
  if (base === undefined) {
    throw new Error("this Gemini edit node has no picture on its 'base' input");
  }

  const prompt = text(inputs['prompt']);
  const draw = settings(props);
  const picture = await drawWithGemini(services, {
    ...draw,
    prompt,
    images: [await readImage(services, base), ...(await readRefs(services, inputs['refs']))],
  });
  return store(services, picture, draw.model, prompt);
}

export default function activate(api: GenPluginApi): void {
  api.registerNode(generateSpec(api));
  api.registerNode(editSpec(api));
  api.registerRuntime(GENERATE_TYPE, generate);
  api.registerRuntime(EDIT_TYPE, edit);
  api.registerPriceAgent(geminiPrices);
}
