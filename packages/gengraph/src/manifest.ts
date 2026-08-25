/**
 * What a plugin's `plugin.json` declares, and the sentence an author is asked to confirm
 * before it is installed. Both are here rather than beside the loader because the desktop
 * install dialog reads them and the renderer never touches the filesystem.
 */
import { z } from 'zod';

import { GEN_PLUGIN_API_VERSION } from './plugin.js';

/** The capabilities of {@link GenServices}, which is what a manifest names one by one. */
export const GEN_SERVICE_NAMES = ['image', 'text', 'blobs', 'assets', 'fetch', 'key'] as const;

export type GenServiceName = (typeof GEN_SERVICE_NAMES)[number];

/**
 * A plugin's name is also its directory name under the per-user plugins root, so it is
 * held to a slug rather than trusted as a path fragment.
 */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** A relative path inside the plugin's own directory, which is where its sources live. */
const ENTRY = /^[A-Za-z0-9_][A-Za-z0-9_./-]*\.ts$/;

const priceTable = z.object({
  pricesAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().optional(),
  models: z.record(
    z.object({
      image: z.number().nonnegative().optional(),
      'mtok-in': z.number().nonnegative().optional(),
      'mtok-out': z.number().nonnegative().optional(),
    }),
  ),
});

const manifest = z.object({
  name: z.string().regex(NAME),
  version: z.string().min(1),
  /** The value of {@link GEN_PLUGIN_API_VERSION} the plugin's sources were written against. */
  apiVersion: z.number().int().positive(),
  /** One line, shown beside the name wherever a plugin is listed. */
  description: z.string().min(1),
  /** Every node type the plugin declares. Registering any other one is refused. */
  nodeTypes: z.array(z.string().min(1)).min(1),
  /** The capabilities its runtimes call, which the install confirmation names. */
  services: z.array(z.enum(GEN_SERVICE_NAMES)).default([]),
  /** The key ids it resolves through `resolveKeys`, which the confirmation names too. */
  keys: z.array(z.string().min(1)).default([]),
  /** The module its `activate` function is the default export of. */
  entry: z.string().regex(ENTRY).default('index.ts'),
  /** Prices for the models it calls, in the shape of a price table, consulted last. */
  prices: priceTable.optional(),
});

/** A parsed manifest. Its `prices` fragment has the shape of a {@link GenPriceTable}. */
export type GenPluginManifest = z.infer<typeof manifest>;

export type GenManifestResult =
  | { ok: true; manifest: GenPluginManifest }
  | { ok: false; reason: string };

/**
 * Reads a manifest, refusing by name rather than throwing. An entry that climbs out of the
 * plugin's directory is refused here, because the loader resolves it against that directory
 * and nothing downstream would see the `..` again.
 */
export function parseGenPluginManifest(raw: unknown): GenManifestResult {
  const parsed = manifest.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path.join('.') ?? '';
    return {
      ok: false,
      reason: `plugin.json is not a manifest: ${at} ${issue?.message ?? ''}`.trim(),
    };
  }

  if (parsed.data.entry.split('/').includes('..')) {
    return { ok: false, reason: `entry "${parsed.data.entry}" climbs out of the plugin directory` };
  }

  if (parsed.data.apiVersion !== GEN_PLUGIN_API_VERSION) {
    return {
      ok: false,
      reason:
        `${parsed.data.name} was written against plugin API ${parsed.data.apiVersion}, ` +
        `and this version of the app offers ${GEN_PLUGIN_API_VERSION}`,
    };
  }

  return { ok: true, manifest: parsed.data };
}

/**
 * What an author is told before they install. Installed plugins run trusted, so the
 * declared capabilities and key names are the whole of what the confirmation can offer,
 * and a plugin declaring neither says so rather than leaving the sentence empty.
 */
export function installDescription(m: GenPluginManifest): string {
  const types = `${m.nodeTypes.length} node type${m.nodeTypes.length === 1 ? '' : 's'}`;
  const reaches =
    m.services.length === 0
      ? 'It reaches nothing outside the graph it runs in'
      : `It calls ${list([...m.services].sort())}`;
  const keys =
    m.keys.length === 0
      ? 'needs no API key'
      : `needs the ${list([...m.keys].sort())} key${m.keys.length === 1 ? '' : 's'}`;
  return (
    `${m.name} ${m.version} adds ${types} and runs with this application's own permissions. ` +
    `${reaches}, and ${keys}.`
  );
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
