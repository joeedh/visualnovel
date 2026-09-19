import {
  chatRouteFor,
  chatVendorFor,
  imageRouteFor,
  imageVendorOf,
  type EffortChoice,
  type ImageModelEntry,
  type ImageResult,
  type Providers,
  type Route,
} from '@vn/types';
import {
  keysPresent,
  missingRouteError,
  type KeyVendor,
  type ProjectConfig,
  type ResolvedKeys,
} from '@vn/config';
import { ProviderError, type ConfigError } from '@vn/util';
import type { ChatBackend, ImageBackend, RefLoader } from './backend.js';
import { createAnthropicChat } from './backends/anthropic.js';
import { createGeminiChat, createGeminiImage } from './backends/gemini.js';
import { createOpenRouterImage } from './backends/openrouter.js';
import { createOpenRouterChat } from './backends/openrouter-chat.js';
import { ChatTextLLM } from './text.js';
import { ChatVisionReviewer } from './review.js';
import { BackendImageProvider } from './image.js';

// Re-exported from where the rules now live, so the callers that reach them through this package
// are unchanged.
export { chatVendorFor, imageVendorOf } from '@vn/types';

/**
 * The reviewer label for a chat model: the native vendor's, because labels are compared in the
 * manifest and a picture reviewed by Claude through OpenRouter was still reviewed by Claude. An
 * id under a prefix the route rule does not know is labelled by that prefix.
 */
function labelOf(modelId: string): string {
  if (modelId.includes('/')) {
    const prefix = modelId.split('/')[0]!;
    if (prefix === 'google') return 'gemini';
    return prefix === 'anthropic' ? 'claude' : prefix;
  }
  return chatVendorFor(modelId) === 'anthropic' ? 'claude' : 'gemini';
}

/**
 * Build the chat backend a route names, with a stable reviewer label. Exported because a plain
 * chat call is not always a `Providers` bundle — `describeAsset` asks one vision model one
 * question, and building the reviewers and the image provider to reach it is unnecessary.
 *
 * A caller has a `Route` because it just called {@link resolveRoutes} or {@link chatRoute}, so
 * there is no path that builds a backend on an empty key.
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
  route: Route,
  keys: ResolvedKeys,
  effort?: EffortChoice,
  opts: { record?: boolean } = {},
): { backend: ChatBackend; label: string } {
  const { record } = opts;
  const label = labelOf(route.modelId);
  switch (route.transport) {
    case 'anthropic':
      return {
        backend: createAnthropicChat(keys.anthropic, route.wireId, { effort, record }),
        label,
      };
    case 'gemini':
      return {
        backend: createGeminiChat(keys.gemini, route.wireId, undefined, { record }),
        label,
      };
    case 'openrouter':
      return { backend: createOpenRouterChat(keys.openrouter, route, { effort, record }), label };
  }
}

/** The ids a caller is about to use, by the seam each goes through. */
export interface RouteRequest {
  chat?: readonly string[];
  image?: readonly string[];
}

/** Every model `project.yaml` configures, as a {@link RouteRequest}. */
export function projectModels(config: ProjectConfig): RouteRequest {
  return {
    chat : [...config.models.vision, config.models.text],
    image: [config.models.image],
  };
}

/** The key a native id would need, and so the one a refusal names, by seam. */
function nativeKeyFor(kind: keyof RouteRequest, modelId: string): KeyVendor {
  if (kind === 'image') return imageVendorOf(modelId);
  return modelId.includes('/') ? 'openrouter' : chatVendorFor(modelId);
}

/**
 * Routes every id in `ids`, or throws the `ConfigError` for the first that no resolved key can
 * carry. A pre-run check calls this over the ids a run is about to use, so a project that draws
 * through OpenRouter and reviews with Claude is refused before it pays for a picture it cannot
 * review, and is not asked for a key it never uses. The map is keyed by the id as spelled.
 */
export function resolveRoutes(
  config: ProjectConfig,
  keys: ResolvedKeys,
  ids: RouteRequest,
): Map<string, Route> {
  const present = keysPresent(keys);
  const routes = new Map<string, Route>();
  const kinds = [
    ['chat', ids.chat ?? [], chatRouteFor],
    ['image', ids.image ?? [], imageRouteFor],
  ] as const;
  for (const [kind, list, routeFor] of kinds) {
    for (const modelId of list) {
      if (routes.has(modelId)) continue;
      const route = routeFor(modelId, present);
      if (route === undefined)
        throw missingRouteError(config, modelId, nativeKeyFor(kind, modelId));
      routes.set(modelId, route);
    }
  }
  return routes;
}

/** The route one chat id takes, or the `ConfigError` {@link resolveRoutes} would throw for it. */
export function chatRoute(config: ProjectConfig, keys: ResolvedKeys, modelId: string): Route {
  return resolveRoutes(config, keys, { chat: [modelId] }).get(modelId)!;
}

/**
 * A chat backend that refuses every call with the `ConfigError` a pre-run check would have
 * raised. {@link createProviders} builds one for a model no key carries, so a bundle can be built
 * for a run that never calls that model, and a run that does is refused at the first call in the
 * same words.
 */
function refusingChat(modelId: string, refusal: ConfigError): ChatBackend {
  const refuse = () => Promise.reject(refusal);
  return {
    modelId,
    message         : refuse,
    messageWithUsage: refuse,
    chatWithTools   : refuse,
    chatConversation: refuse,
  };
}

/** Builds the backend the router keeps for one route. Injectable for the router's tests. */
export type ImageBackendBuilder = (route: Route, apiKey: string) => ImageBackend;

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
  return (route, apiKey) => {
    if (route.transport !== 'openrouter') return createGeminiImage(apiKey, route.wireId);
    // The listing names models by their OpenRouter spelling, which is what the wire id is
    const listed = catalog.find((entry) => entry.id === route.wireId);
    return createOpenRouterImage(
      apiKey,
      route.wireId,
      listed === undefined ? {} : { seed: listed.seed },
    );
  };
}

/**
 * The byte-level image seam. Its `modelId` is the project's `models.image`, and each call is
 * routed by the `modelId` on its params, so a graph node naming another model draws with that
 * model rather than the project's. A backend is built once per model and kept for the life of the
 * router. A model no resolved key can carry is refused with the `ConfigError` a pre-run check
 * would have raised, so a host's key-setup handling sees the fault it already knows.
 *
 * A result comes back under the id the caller sent, whatever spelling the wire carried: the
 * manifest holds the author's spelling, and the dedupe key already does. The route's transport
 * is written beside it.
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
  const present = keysPresent(keys);
  const built = new Map<string, { backend: ImageBackend; route: Route }>();

  const backendFor = (modelId: string): { backend: ImageBackend; route: Route } => {
    // Nothing above the seam may send an empty id: the graph runtime resolves an inherit node
    // to the project's model, and the task runners copy `models.image` into every task
    if (modelId.trim() === '') {
      throw new ProviderError(
        'an image call named no model; the project’s models.image is resolved before this seam',
      );
    }
    const found = built.get(modelId);
    if (found !== undefined) return found;

    const route = imageRouteFor(modelId, present);
    if (route === undefined) throw missingRouteError(config, modelId, imageVendorOf(modelId));
    const entry = { backend: build(route, keys[route.transport]), route };
    built.set(modelId, entry);
    return entry;
  };

  const stamped = (result: ImageResult, route: Route): ImageResult => ({
    ...result,
    modelId  : route.modelId,
    transport: route.transport,
  });

  // Async so a refusal here surfaces as a rejected promise, the same way a backend's own does.
  return {
    modelId : config.models.image,
    generate: async (prompt, refs, params) => {
      const { backend, route } = backendFor(params.modelId);
      return stamped(await backend.generate(prompt, refs, params), route);
    },
    edit: async (base, prompt, refs, params) => {
      const { backend, route } = backendFor(params.modelId);
      return stamped(await backend.edit(base, prompt, refs, params), route);
    },
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

  // The bundle is built without refusing: `vngen decompose` builds one to reach the text model
  // and never reviews, so a reviewer nothing carries must not stop it. The host's pre-run check
  // (`resolveRoutes`) is where a run that will call every model is refused ahead of paying
  const present = keysPresent(keys);
  const chat = (modelId: string): { backend: ChatBackend; label: string } => {
    const route = chatRouteFor(modelId, present);
    if (route !== undefined) return chatBackendFor(route, keys);
    const refusal = missingRouteError(config, modelId, nativeKeyFor('chat', modelId));
    return { backend: refusingChat(modelId, refusal), label: labelOf(modelId) };
  };

  const reviewers = config.models.vision.map((modelId) => {
    const { backend, label } = chat(modelId);
    return new ChatVisionReviewer(label, backend, loadRef);
  });

  const text = new ChatTextLLM(chat(config.models.text).backend);

  return { image, reviewers, text };
}
