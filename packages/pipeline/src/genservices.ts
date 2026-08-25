/**
 * The host's side of a generation graph: the services a node runtime reaches the outside
 * world through, built from the same providers, asset store and keys the task runners use.
 * Every request a node makes goes through the provider ring, so an API fault can be read
 * against the body that caused it.
 */
import type { AssetRef, AssetStore, ImageParams, ImageResult, ProjectModel } from '@vn/types';
import type { Providers } from '@vn/types';
import type { ResolvedKeys } from '@vn/config';
import { captureRequest, type ImageBackend } from '@vn/providers';
import { parseSlot, resolveBinding } from '@vn/artgen';
import type {
  GenAssetService,
  GenBlobService,
  GenFetchInit,
  GenFetchResult,
  GenImageInput,
  GenServices,
  GenTextService,
} from '@vn/gengraph';

export interface GenServicesDeps {
  model: ProjectModel;
  store: AssetStore;
  providers: Providers;
  /** The byte-level image seam, from `createImageBackend` or a mock backend. */
  imageBackend: ImageBackend;
  /** Where a node's intermediate pictures land, from `@vn/gengraph/state`. */
  blobs: GenBlobService;
  /** Resolved keys, so a plugin node can ask for the one its vendor needs. */
  keys?: Partial<ResolvedKeys>;
}

/**
 * Answers what a slot currently holds by the same rule the planner resolves a reference
 * with, so a slot-ref node and a task's `refs` never disagree about which picture is Aiko's
 * portrait.
 */
function assetService(model: ProjectModel, store: AssetStore): GenAssetService {
  return {
    read: async (ref: AssetRef) => {
      try {
        return await store.read(ref);
      } catch {
        return undefined;
      }
    },
    slot: (key: string) => {
      const binding = parseSlot(key);
      if (binding === undefined) {
        return Promise.resolve(undefined);
      }

      const assets = store.manifest();
      const hash = resolveBinding(binding, { model, assets });
      if (hash === undefined) {
        return Promise.resolve(undefined);
      }

      const asset = assets.find((a) => a.hash === hash);
      return Promise.resolve(asset === undefined ? undefined : { hash, ext: asset.ext });
    },
  };
}

/**
 * The configured text model, whatever model id a node names. A node's own model id becomes
 * real in Stage 12, where providers are ported to plugins and a backend can be built per
 * call; until then the project's one text provider answers.
 */
function textService(providers: Providers): GenTextService {
  return {
    complete: (_modelId: string, prompt: string, system?: string) =>
      providers.text.complete(prompt, system),
    structured: <T>(_modelId: string, prompt: string, parse: (raw: string) => T, system?: string) =>
      providers.text.structured(prompt, parse, system),
  };
}

function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
}

/**
 * A request through the ring, so the body a 400 indexes into is still readable afterwards.
 * The request's headers are deliberately not recorded: a plugin authenticates with one, and
 * a key value must never be written down anywhere.
 */
async function ringFetch(url: string, init: GenFetchInit = {}): Promise<GenFetchResult> {
  const method = init.method ?? 'GET';
  const capture = await captureRequest('gengraph', {
    url,
    method,
    ...(typeof init.body === 'string' ? { body: init.body } : {}),
  });

  try {
    const response = await fetch(url, {
      method,
      ...(init.headers === undefined ? {} : { headers: init.headers }),
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return {
      status: response.status,
      headers: headersOf(response),
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  } catch (err) {
    await capture.failed(err);
    throw err;
  }
}

/** Everything a node runtime may reach, wired to this project's providers and stores. */
export function createGenServices(deps: GenServicesDeps): GenServices {
  const { imageBackend } = deps;

  return {
    image: {
      generate: (
        prompt: string,
        refs: GenImageInput[],
        params: ImageParams,
      ): Promise<ImageResult> => imageBackend.generate(prompt, refs, params),
      edit: (
        base: GenImageInput,
        prompt: string,
        refs: GenImageInput[],
        params: ImageParams,
      ): Promise<ImageResult> => imageBackend.edit(base, prompt, refs, params),
    },
    text: textService(deps.providers),
    blobs: deps.blobs,
    assets: assetService(deps.model, deps.store),
    fetch: ringFetch,
    key: (name: string) => Promise.resolve(deps.keys?.[name as keyof ResolvedKeys]),
  };
}
