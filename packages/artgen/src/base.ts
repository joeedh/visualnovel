import type { BaseAssets } from '@vn/types';

/**
 * Why a base root cannot be written to, or `undefined` when it can. `unavailable` means the
 * directory is there but its manifest is not — which is exactly what a checkout without the base
 * repo looks like, and regenerating into it would bury an approved library under fresh art.
 *
 * Lives here rather than in the planner because two very different acts must refuse in the same
 * sentence: planning a run, and generating one concept on demand.
 */
export function baseRefusal(base?: BaseAssets): string | undefined {
  if (base?.state !== 'unavailable') return undefined;
  return `base assets at ${base.root} are unavailable: the directory exists but has no readable manifest.json (a checkout without the base repo looks exactly like this). Nothing was written — restore it rather than generating over it.`;
}
