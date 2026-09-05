/**
 * Which API serves a model id, and how the client reaches it.
 *
 * A model id is `<route>/<model>`, split on the first slash only: OpenRouter's own ids contain
 * slashes, so `openrouter/anthropic/claude-opus-4.6` names the model `anthropic/claude-opus-4.6`.
 */

export type Route = 'anthropic' | 'openrouter';

export interface ModelRef {
  route: Route;
  /** What goes in the request's `model` field. */
  model: string;
}

const ROUTES: readonly Route[] = ['anthropic', 'openrouter'];

/**
 * OpenRouter's Anthropic-shaped endpoint, which the SDK appends `/v1/messages` to. Confirmed
 * against a live call on 2026-09-05; `OPENROUTER_BASE_URL` overrides it without a code change.
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api';

export function parseModelRef(id: string): ModelRef {
  const slash = id.indexOf('/');
  const route = slash < 0 ? '' : id.slice(0, slash);
  if (!ROUTES.includes(route as Route)) {
    throw new Error(`model id must start with ${ROUTES.join('/ or ')}/ — got "${id}"`);
  }
  const model = id.slice(slash + 1);
  if (!model) throw new Error(`model id "${id}" names a route and no model`);
  return { route: route as Route, model };
}

/** The `baseURL` a client needs for this route, or undefined for the first-party default. */
export function baseUrlFor(route: Route): string | undefined {
  if (route !== 'openrouter') return undefined;
  return process.env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE;
}
