/**
 * What each built-in node does when it runs. A runtime reaches the outside world only
 * through the {@link GenServices} it is handed, so the same twelve types run against real
 * providers in the app and against mocks in a test.
 */
import type { ImageParams, ImageResult } from '@vn/types';
import type { NodeTypeConstructor } from 'pathux-graph';

import { registerGenRuntime } from '../registry.js';
import type { GenInputs, GenNodeRun, GenProps } from '../registry.js';
import type { GenImageInput, GenServices } from '../services.js';
import {
  GenDerivedPrompt,
  GenEditImage,
  GenImage,
  GenImageFile,
  GenOutput,
  GenRefList,
  GenRefinePrompt,
  GenRewrite,
  GenSlotRef,
  GenSwitch,
  GenTaskRefs,
  GenTemplate,
  registerGenNodes,
} from './types.js';
import type { GenImageRef } from './sockets.js';

/** The placeholders a template node fills in, which are also its input socket names. */
const VARS = ['varA', 'varB', 'varC'] as const;

/** The single-picture inputs a reference list appends, after whatever its list input holds. */
const SLOTS = ['a', 'b', 'c'] as const;

/** The bytes behind a picture, read from whichever of the two stores holds it. */
export async function readImageBytes(
  services: GenServices,
  ref: GenImageRef,
): Promise<GenImageInput> {
  const bytes =
    ref.store === 'asset'
      ? await services.assets.read({ hash: ref.hash, ext: ref.ext })
      : await services.blobs.read(ref.hash);

  if (bytes === undefined) {
    throw new Error(`the ${ref.store} store holds no bytes for '${ref.hash}'`);
  }
  return { bytes, ext: ref.ext };
}

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

function refsOf(value: unknown): GenImageRef[] {
  return Array.isArray(value)
    ? value.map(imageOf).filter((r): r is GenImageRef => r !== undefined)
    : [];
}

async function readRefs(services: GenServices, value: unknown): Promise<GenImageInput[]> {
  const out: GenImageInput[] = [];
  for (const ref of refsOf(value)) {
    out.push(await readImageBytes(services, ref));
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

function imageParamsOf(props: GenProps): ImageParams {
  const params: ImageParams = { modelId: text(props.model) };

  const aspect = text(props.aspect).trim();
  if (aspect.length > 0) {
    params.aspect = aspect;
  }

  const seed = seedOf(props.seed);
  if (seed !== undefined) {
    params.seed = seed;
  }

  return params;
}

/** Reads the host's seeded task refs, which arrive as the JSON an `AssetRef[]` writes to. */
function seededRefs(raw: string): GenImageRef[] {
  const said = raw.trim();
  if (said.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(said);
  } catch {
    throw new Error('the seeded task refs are not JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('the seeded task refs are not a list');
  }

  return parsed.map((entry) => {
    const ref = entry as Partial<GenImageRef>;
    if (typeof ref.hash !== 'string' || typeof ref.ext !== 'string') {
      throw new Error('an entry in the seeded task refs names no hash and ext');
    }
    return { store: 'asset', hash: ref.hash, ext: ref.ext };
  });
}

function bind(cls: NodeTypeConstructor, run: GenNodeRun): void {
  registerGenRuntime(cls.graphDef().typeName, run);
}

/**
 * Turns the model's picture into a blob every node below it can read. The model id and the
 * prompt ride along in the journal record rather than on a socket, because a host stamping
 * the picture's provenance needs to know what drew it and what it was asked for.
 */
async function storeImage(
  services: GenServices,
  result: ImageResult,
  prompt: string,
): Promise<{ image: GenImageRef; modelId: string; prompt: string }> {
  const ref = await services.blobs.write(result.bytes, result.ext);
  return {
    image  : { store: 'blob', hash: ref.hash, ext: ref.ext },
    modelId: result.modelId,
    prompt,
  };
}

function requireImage(inputs: GenInputs, key: string, what: string): GenImageRef {
  const ref = imageOf(inputs[key]);
  if (ref === undefined) {
    throw new Error(`${what} has no picture on its '${key}' input`);
  }
  return ref;
}

/**
 * Registers every built-in type together with its work, registering the types first so a
 * host cannot bind a runtime to a type nothing declared.
 */
export function registerGenRuntimes(): void {
  registerGenNodes();

  bind(GenDerivedPrompt, async (inputs) => ({ prompt: text(inputs.prompt) }));

  bind(GenTaskRefs, async (inputs) => ({ refs: seededRefs(text(inputs.assets)) }));

  bind(GenSlotRef, async (_inputs, props, services) => {
    const key = text(props.slot).trim();
    if (key.length === 0) {
      throw new Error('this slot-ref node names no slot');
    }

    const ref = await services.assets.slot(key);
    if (ref === undefined) {
      throw new Error(`the slot '${key}' holds no asset yet`);
    }
    return { image: { store: 'asset', hash: ref.hash, ext: ref.ext } };
  });

  bind(GenTemplate, async (inputs, props) => {
    let filled = text(props.template);
    for (const name of VARS) {
      filled = filled.split(`{${name}}`).join(text(inputs[name]));
    }
    return { text: filled };
  });

  bind(GenRewrite, async (inputs, props, services) => {
    const instruction = text(props.instruction).trim();
    const body = text(inputs.text);
    const system = text(props.system).trim();

    const reply = await services.text.complete(
      text(props.model),
      instruction.length > 0 ? `${instruction}\n\n${body}` : body,
      system.length > 0 ? system : undefined,
    );
    return { text: reply };
  });

  bind(GenImage, async (inputs, props, services) => {
    const prompt = joinPrompt(text(inputs.prompt), text(inputs.refine));
    const result = await services.image.generate(
      prompt,
      await readRefs(services, inputs.refs),
      imageParamsOf(props),
    );
    return storeImage(services, result, prompt);
  });

  bind(GenEditImage, async (inputs, props, services) => {
    const base = requireImage(inputs, 'base', 'this edit-image node');
    const prompt = text(inputs.prompt);
    const result = await services.image.edit(
      await readImageBytes(services, base),
      prompt,
      await readRefs(services, inputs.refs),
      imageParamsOf(props),
    );
    return storeImage(services, result, prompt);
  });

  bind(GenRefList, async (inputs) => {
    const refs = [...refsOf(inputs.list)];
    for (const key of SLOTS) {
      const one = imageOf(inputs[key]);
      if (one !== undefined) {
        refs.push(one);
      }
    }
    return { refs };
  });

  bind(GenImageFile, async (_inputs, props, services) => {
    const hash = text(props.hash).trim();
    if (hash.length === 0) {
      throw new Error('this image-file node names no asset');
    }

    const ext = text(props.ext).trim() || 'png';
    if ((await services.assets.read({ hash, ext })) === undefined) {
      throw new Error(`no asset '${hash}.${ext}' is in the store`);
    }
    return { image: { store: 'asset', hash, ext } };
  });

  bind(GenRefinePrompt, async (inputs) => ({ text: text(inputs.text) }));

  bind(GenSwitch, async (inputs, props) => {
    const key = props.useB === true ? 'b' : 'a';
    return { image: requireImage(inputs, key, 'this switch node') };
  });

  // The output node declares no output socket, and its record carries the picture so a
  // resumed run answers what the slot holds without walking the graph again.
  bind(GenOutput, async (inputs) => ({
    image: requireImage(inputs, 'image', 'this output node'),
  }));
}
