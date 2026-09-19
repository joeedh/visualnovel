/**
 * What the Setup pane says beneath each vendor about the project's models: which of them would go
 * through OpenRouter right now, and which have no route at all. Pure over the config and the key
 * booleans, so the sentences are testable without a project on disk.
 */
import type { KeyVendor } from '@vn/config';
import {
  chatRouteFor,
  chatVendorFor,
  imageRouteFor,
  imageVendorOf,
  type KeysPresent,
  type ProjectConfig,
  type Route,
} from '@vn/types';

/** The key each vendor's row asks for, with its article. */
const A_KEY: Record<KeyVendor, string> = {
  anthropic : 'an Anthropic key',
  gemini    : 'a Gemini key',
  openrouter: 'an OpenRouter key',
};

export interface RoutingNotes {
  /** One sentence per vendor, or an empty string where there is nothing to say. */
  notes: Record<KeyVendor, string>;
  /** Configured model ids no resolved key can carry, in `project.yaml` order. */
  unrouted: string[];
}

/** One configured model, the key it would natively need, and where it routes now. */
interface Routed {
  modelId: string;
  native: KeyVendor;
  route: Route | undefined;
}

/** Every configured model routed, chat first, image last, with duplicates dropped. */
function routed(config: ProjectConfig, present: KeysPresent): Routed[] {
  const out: Routed[] = [];
  const seen = new Set<string>();
  const add = (modelId: string, native: KeyVendor, route: Route | undefined) => {
    if (seen.has(modelId)) return;
    seen.add(modelId);
    out.push({ modelId, native, route });
  };
  for (const id of [...config.models.vision, config.models.text]) {
    const native = id.includes('/') ? 'openrouter' : chatVendorFor(id);
    add(id, native, chatRouteFor(id, present));
  }
  const image = config.models.image;
  add(image, imageVendorOf(image), imageRouteFor(image, present));
  return out;
}

/** `a`, `a and b`, `a, b and c`. */
function list(ids: string[]): string {
  if (ids.length <= 1) return ids.join('');
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

export function routingNotes(config: ProjectConfig, present: KeysPresent): RoutingNotes {
  const all = routed(config, present);
  const unrouted = all.filter((m) => m.route === undefined).map((m) => m.modelId);
  const notes: Record<KeyVendor, string> = { anthropic: '', gemini: '', openrouter: '' };

  for (const vendor of ['anthropic', 'gemini'] as const) {
    if (present[vendor]) continue;
    const mine = all.filter((m) => m.native === vendor);
    const carried = mine.filter((m) => m.route?.transport === 'openrouter').map((m) => m.modelId);
    const stuck = mine.filter((m) => m.route === undefined).map((m) => m.modelId);
    const parts: string[] = [];
    if (carried.length > 0) {
      parts.push(`${list(carried)} will run through OpenRouter until ${A_KEY[vendor]} is provided`);
    }
    if (stuck.length > 0) {
      parts.push(`no OpenRouter key either, so ${list(stuck)} cannot run`);
    }
    notes[vendor] = parts.join('; ');
  }

  const carrying = all.filter((m) => m.route?.transport === 'openrouter').map((m) => m.modelId);
  const spelled = all
    .filter((m) => m.native === 'openrouter' && m.route === undefined)
    .map((m) => m.modelId);
  if (carrying.length > 0) {
    notes.openrouter = `carrying ${list(carrying)} right now`;
  } else if (spelled.length > 0) {
    notes.openrouter = `no key, so ${list(spelled)} cannot run`;
  }

  return { notes, unrouted };
}
