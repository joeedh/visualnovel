import { resolveKeys, secretDirsFor, type ResolvedKeys } from '@vn/config';
import { activeOutputs, type Graph as GenGraph, type GraphId } from '@vn/gengraph';
import { readModelCatalog } from '@vn/gengraph/state';
import {
  createImageBackend,
  createMockProviders,
  createProviders,
  projectModels,
  resolveRoutes,
  StubImageBackend,
  type ImageBackend,
} from '@vn/providers';
import type { Providers } from '@vn/types';
import type { LoadedProject } from '../load/project.js';

/** The output node a run targets when none is named, which is the first one still active. */
export function activeOutputOf(graph: GenGraph): GraphId | undefined {
  return activeOutputs(graph)[0]?.id;
}

/** What a run reaches the outside world through, whether it runs tasks or a generation graph. */
export interface GenDeps {
  providers: Providers;
  /** The byte-level seam a graph's image nodes call, beneath the provider the runners use. */
  imageBackend: ImageBackend;
  /** Absent under `mock`, where nothing is resolved and no vendor is reached. */
  keys?: ResolvedKeys;
}

export async function buildGenDeps(project: LoadedProject, mock: boolean): Promise<GenDeps> {
  const loadRef = async (ref: { hash: string; ext: string }) => ({
    bytes: await project.store.read(ref),
    ext  : ref.ext,
  });
  if (mock) {
    const imageBackend = new StubImageBackend();
    return { providers: createMockProviders({ refLoader: loadRef, imageBackend }), imageBackend };
  }
  // Every configured model is routed up front, so a run is refused here rather than failing
  // at its first review call after it has paid for a picture
  const keys = await resolveKeys(project.config, { secretsDirs: await secretDirsFor(project.dir) });
  resolveRoutes(project.config, keys, projectModels(project.config));
  // The cached listing says which OpenRouter models take a seed, so the router refuses one by
  // name rather than sending it
  const catalog = (await readModelCatalog())?.openrouter ?? [];
  return {
    providers   : createProviders({ config: project.config, keys, loadRef, catalog }),
    imageBackend: createImageBackend(project.config, keys, { catalog }),
    keys,
  };
}

export async function buildProviders(project: LoadedProject, mock: boolean): Promise<Providers> {
  return (await buildGenDeps(project, mock)).providers;
}
