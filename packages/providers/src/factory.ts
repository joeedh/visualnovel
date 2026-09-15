import {
  chatVendorFor,
  imageVendorOf,
  type EffortChoice,
  type ImageModelEntry,
  type Providers,
} from '@vn/types';
import { missingKeyError, type KeyVendor, type ProjectConfig, type ResolvedKeys } from '@vn/config';
import { ProviderError } from '@vn/util';
import type { ChatBackend, ImageBackend, RefLoader } from './backend.js';
import { createAnthropicChat } from './backends/anthropic.js';
import { createGeminiChat, createGeminiImage } from './backends/gemini.js';
import { createOpenRouterImage } from './backends/openrouter.js';
import { ChatTextLLM } from './text.js';
import { ChatVisionReviewer } from './review.js';
import { BackendImageProvider } from './image.js';

// Re-exported from where the rules now live, so the callers that reach them through this package
// are unchanged.
export { chatVendorFor, imageVendorOf } from '@vn/types';

/**
 * Pick the vendor for a model id and a stable reviewer label. Exported because a plain chat call
 * is not always a `Providers` bundle — `describeAsset` asks one vision model one question, and
 * building the reviewers and the image provider to reach it is unnecessary.
 *
 * `record: false` keeps the calls out of the request ring. Only one caller wants it — the
 * difficult-agent analyst, which reads that ring and would otherwise evict the bodies it was
 * opened to read, and find its own prompts there as though they were the author's.
 *
 * `effort` is per-call rather than per-project: the desktop app binds it to the conversation and
 * a difficult-agent report borrows a different one for a single analysis. Gemini has no such knob
 * and ignores it.
 */
export function chatBackendFor(
  modelId: string,
  keys: ResolvedKeys,
  effort?: EffortChoice,
  opts: { record?: boolean } = {},
): { backend: ChatBackend; label: string } {
  const { record } = opts;
  return chatVendorFor(modelId) === 'anthropic'
    ? { backend: createAnthropicChat(keys.anthropic, modelId, { effort, record }), label: 'claude' }
    : { backend: createGeminiChat(keys.gemini, modelId, undefined, { record }), label: 'gemini' };
}

/**
 * The keys a pipeline run needs before it starts: the image model's vendor, and the vendor of
 * every vision and text model. Passed as `resolveKeys`'s `require`, so a project that draws
 * through OpenRouter and reviews with Claude is refused before it pays for a picture it cannot
 * review, and is not asked for a Gemini key it never uses.
 */
export function requiredVendors(config: ProjectConfig): KeyVendor[] {
  const vendors = new Set<KeyVendor>([imageVendorOf(config.models.image)]);
  for (const modelId of [...config.models.vision, config.models.text]) {
    vendors.add(chatVendorFor(modelId));
  }
  return [...vendors];
}

/** Builds the per-vendor backend the router keeps for one model. Injectable for the router's tests. */
export type ImageBackendBuilder = (
  vendor: KeyVendor,
  apiKey: string,
  modelId: string,
) => ImageBackend;

export interface ImageBackendOptions {
  build?: ImageBackendBuilder;
  /**
   * The cached OpenRouter listing, so a model it says takes no seed refuses one by name rather
   * than sending it. A model the listing lacks is built as if it took one.
   */
  catalog?: readonly Pick<ImageModelEntry, 'id' | 'seed'>[];
}

function imageBackendBuilder(
  catalog: readonly Pick<ImageModelEntry, 'id' | 'seed'>[],
): ImageBackendBuilder {
  return (vendor, apiKey, modelId) => {
    if (vendor !== 'openrouter') return createGeminiImage(apiKey, modelId);
    const listed = catalog.find((entry) => entry.id === modelId);
    return createOpenRouterImage(
      apiKey,
      modelId,
      listed === undefined ? {} : { seed: listed.seed },
    );
  };
}

/**
 * The byte-level image seam. Its `modelId` is the project's `models.image`, and each call is
 * routed by the `modelId` on its params, so a graph node naming another model draws with that
 * model rather than the project's. A backend is built once per model and kept for the life of the
 * router. A vendor whose key is missing is refused with the `ConfigError` `resolveKeys` would have
 * raised, so a host's key-setup handling sees the fault it already knows.
 *
 * Exported because a generation graph attaches references it read out of its own blob store,
 * which have no `AssetRef` to resolve, so it calls the backend rather than the `ImageProvider`
 * above it.
 */
export function createImageBackend(
  config: ProjectConfig,
  keys: ResolvedKeys,
  opts: ImageBackendOptions = {},
): ImageBackend {
  const build = opts.build ?? imageBackendBuilder(opts.catalog ?? []);
  const built = new Map<string, ImageBackend>();

  const backendFor = (modelId: string): ImageBackend => {
    // Nothing above the seam may send an empty id: the graph runtime resolves an inherit node
    // to the project's model, and the task runners copy `models.image` into every task
    if (modelId.trim() === '') {
      throw new ProviderError(
        'an image call named no model; the project’s models.image is resolved before this seam',
      );
    }
    const found = built.get(modelId);
    if (found !== undefined) return found;

    const vendor = imageVendorOf(modelId);
    const apiKey = keys[vendor];
    if (!apiKey) throw missingKeyError(config, vendor);
    const backend = build(vendor, apiKey, modelId);
    built.set(modelId, backend);
    return backend;
  };

  // Async so a refusal here surfaces as a rejected promise, the same way a backend's own does.
  return {
    modelId : config.models.image,
    generate: async (prompt, refs, params) =>
      backendFor(params.modelId).generate(prompt, refs, params),
    edit: async (base, prompt, refs, params) =>
      backendFor(params.modelId).edit(base, prompt, refs, params),
  };
}

/**
 * Build the concrete provider bundle from project config + resolved keys (report §8).
 * Providers are swapped purely by changing model ids in `project.yaml`; nothing else in
 * the pipeline needs to know which vendor is behind an interface.
 */
export function createProviders(opts: {
  config: ProjectConfig;
  keys: ResolvedKeys;
  loadRef: RefLoader;
  /** Passed to the image router; see {@link ImageBackendOptions}. */
  catalog?: ImageBackendOptions['catalog'];
}): Providers {
  const { config, keys, loadRef, catalog } = opts;

  const image = new BackendImageProvider(
    createImageBackend(config, keys, catalog === undefined ? {} : { catalog }),
    loadRef,
  );

  const reviewers = config.models.vision.map((modelId) => {
    const { backend, label } = chatBackendFor(modelId, keys);
    return new ChatVisionReviewer(label, backend, loadRef);
  });

  const text = new ChatTextLLM(chatBackendFor(config.models.text, keys).backend);

  return { image, reviewers, text };
}
