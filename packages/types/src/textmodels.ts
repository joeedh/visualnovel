/**
 * Which text models the authoring surfaces offer, and what reasoning each of them will accept.
 * This lives here rather than in `@vn/providers` because both the `vnauthor` REPL and the desktop
 * renderer need the same answers, and only one of the two can import a package that loads a
 * vendor SDK.
 */

import type { TextModelEntry } from './imagemodels.js';

/** The vendors a chat model can belong to, and therefore the keys one can need. */
export type ChatVendor = 'gemini' | 'anthropic';

/**
 * Which key a chat model id needs. The one place that rule is written down.
 *
 * It lives beside the model list rather than in `@vn/providers` for the reason at the top of this
 * file: the renderer asks the same question and cannot import a package that loads a vendor SDK.
 */
export function chatVendorFor(modelId: string): ChatVendor {
  const id = modelId.toLowerCase();
  return id.startsWith('claude') || id.startsWith('anthropic') ? 'anthropic' : 'gemini';
}

/** The vendors an image model can belong to, and therefore the keys one can need. */
export type ImageVendor = 'gemini' | 'openrouter';

/**
 * Which key an image model id needs. OpenRouter names every model `<vendor>/<model>`, so an id
 * with a slash is routed there; the one exception is the `@google/genai` long form `models/<id>`,
 * which is still Gemini. Anything else is Gemini.
 */
export function imageVendorOf(modelId: string): ImageVendor {
  const id = modelId.trim();
  if (id.startsWith('models/')) return 'gemini';
  return id.includes('/') ? 'openrouter' : 'gemini';
}

/** The key and endpoint a call goes out through. */
export type Transport = 'anthropic' | 'gemini' | 'openrouter';

/**
 * What a call actually does with a model id. The native vendor is what every table above the
 * provider seam is keyed by; the transport is which key carries the request.
 */
export interface Route {
  /** The id as the author spelled it; what every table above the seam is keyed by. */
  modelId: string;
  /** The vendor the id names, or `undefined` for an OpenRouter id under a prefix this file does not know. */
  native: ChatVendor | ImageVendor | undefined;
  /** The key and endpoint that carry the call. */
  transport: Transport;
  /** The id sent on the wire: the native id, or its OpenRouter spelling. */
  wireId: string;
}

/** Which keys resolve. Booleans only, so the renderer can compute it from `keyStatus`. */
export type KeysPresent = Readonly<Record<Transport, boolean>>;

// The `-<major>-<minor>` tail of an Anthropic id. The minor is at most two digits so a dated id
// (`claude-opus-4-8-20260101`) is left alone
const ANTHROPIC_TAIL = /-(\d+)-(\d{1,2})$/;
const OPENROUTER_TAIL = /-(\d+)\.(\d{1,2})$/;

/**
 * The OpenRouter spelling of a native id, or `undefined` for an id this rule cannot spell. An
 * id with a slash is already an OpenRouter id and is returned as is; the `@google/genai` long
 * form `models/<id>` has its prefix stripped first.
 */
export function openRouterIdFor(modelId: string): string | undefined {
  let id = modelId.trim();
  if (id.startsWith('models/')) id = id.slice('models/'.length);
  if (id.includes('/')) return id;
  const lower = id.toLowerCase();
  if (lower.startsWith('claude')) return `anthropic/${id.replace(ANTHROPIC_TAIL, '-$1.$2')}`;
  if (lower.startsWith('gemini')) return `google/${id}`;
  return undefined;
}

/**
 * The native spelling of an OpenRouter id, and the inverse of {@link openRouterIdFor}. An id
 * under a prefix the rule does not know is returned unchanged, so the model tables answer as they
 * do for any unknown id.
 */
export function nativeIdFor(wireId: string): string {
  const id = wireId.trim();
  if (id.startsWith('anthropic/')) {
    return id.slice('anthropic/'.length).replace(OPENROUTER_TAIL, '-$1-$2');
  }
  if (id.startsWith('google/')) return id.slice('google/'.length);
  return id;
}

/** The vendor an OpenRouter prefix names, or `undefined` for one this file does not know. */
function nativeOfPrefix(wireId: string): ChatVendor | undefined {
  if (wireId.startsWith('anthropic/')) return 'anthropic';
  if (wireId.startsWith('google/')) return 'gemini';
  return undefined;
}

/**
 * Routes an id the author spelled as `<vendor>/<model>`. The author chose OpenRouter by spelling
 * it, so there is no preference for the native key; without an OpenRouter key there is no route.
 */
function spelledRoute(modelId: string, present: KeysPresent): Route | undefined {
  if (!present.openrouter) return undefined;
  const wireId = modelId.trim();
  return { modelId, native: nativeOfPrefix(wireId), transport: 'openrouter', wireId };
}

/** Routes a native id: its own key when that resolves, otherwise OpenRouter, otherwise nothing. */
function nativeRoute(
  modelId: string,
  native: ChatVendor | ImageVendor,
  present: KeysPresent,
): Route | undefined {
  if (present[native]) return { modelId, native, transport: native, wireId: modelId };
  const wireId = openRouterIdFor(modelId);
  if (present.openrouter && wireId !== undefined) {
    return { modelId, native, transport: 'openrouter', wireId };
  }
  return undefined;
}

/**
 * The route a chat call takes for a model id, or `undefined` when no resolved key can carry it.
 * The native vendor's key wins when it resolves; OpenRouter carries the model when only its key
 * does and {@link openRouterIdFor} can spell the id.
 */
export function chatRouteFor(modelId: string, present: KeysPresent): Route | undefined {
  if (modelId.includes('/')) return spelledRoute(modelId, present);
  return nativeRoute(modelId, chatVendorFor(modelId), present);
}

/** The route an image call takes, by the same rule as {@link chatRouteFor}. */
export function imageRouteFor(modelId: string, present: KeysPresent): Route | undefined {
  if (imageVendorOf(modelId) === 'openrouter') return spelledRoute(modelId, present);
  return nativeRoute(modelId, 'gemini', present);
}

/** The effort levels a surface may offer, in order. A tuple, so a command prop can name it. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Reasoning-effort level (Anthropic `output_config.effort`). Higher levels think more and
 * spend more tokens. Not every model takes every level — ask {@link effortChoicesFor}.
 */
export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * What a surface may bind, weakest first. `none` is thinking switched off — a state, not an
 * `output_config.effort` value, and the request that carries it sends `thinking: disabled`
 * instead of an effort.
 */
export const EFFORT_CHOICES = ['none', ...EFFORT_LEVELS] as const;

export type EffortChoice = (typeof EFFORT_CHOICES)[number];

/**
 * The choice a text call runs at when nothing sets one: every pipeline call — decomposition,
 * reviews, refine critiques, gate triage — and the provider's own fallback. Deliberately a level
 * rather than the absence of one: on Opus 4.7/4.8 and Sonnet 4.6 a request with no `thinking`
 * field runs with no thinking at all, so omitting the field is the least capable setting rather
 * than a neutral one.
 */
export const DEFAULT_EFFORT: EffortChoice = 'low';

/**
 * The choice the authoring agent's hosts start a conversation at. Higher than `DEFAULT_EFFORT`
 * because the agent reads a prompt of some 20,000 characters and is expected to apply a rule
 * placed at the end of it; at `low` the one thread that had such a rule in place did not. The
 * author binds another level per conversation; the pipeline's calls are not affected.
 */
export const DEFAULT_AGENT_EFFORT: EffortChoice = 'medium';

/** Curated text models offered by the `/model` menu and the convo pane; any id also works. */
export const TEXT_MODELS: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

/** One row of a text-model picker: the id it writes, the text it shows, and its tooltip. */
export interface TextModelChoice {
  id: string;
  label: string;
  tooltip: string;
}

/** How a curated or listed id reads on hover. */
function textModelTooltip(id: string, listed: TextModelEntry | undefined): string {
  if (listed?.vendor === 'openrouter') {
    return `${listed.name || id}: routed by OpenRouter; needs an OpenRouter key.`;
  }
  const vendor = listed?.vendor ?? chatVendorFor(id);
  const name = listed?.name ? `${listed.name}: ` : '';
  return `${name}answers through ${vendor === 'anthropic' ? 'Anthropic' : 'Gemini'}, or through OpenRouter when only that key is set.`;
}

/**
 * The rows a text-model picker draws: the curated ids, every id the cached listing holds, and
 * `current` where it is none of them, so a model that dropped off the listing is still shown
 * rather than silently reset. Sorted by id, with the same id listed once.
 */
export function textModelChoices(
  listed: readonly TextModelEntry[] | undefined,
  current: string,
): TextModelChoice[] {
  const byId = new Map<string, TextModelEntry | undefined>();
  for (const id of TEXT_MODELS) byId.set(id, undefined);
  for (const entry of listed ?? []) byId.set(entry.id, entry);
  if (current !== '' && !byId.has(current)) byId.set(current, undefined);
  return [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, entry]) => ({ id, label: id, tooltip: textModelTooltip(id, entry) }));
}

// `xhigh` arrived on Opus 4.7; the models before it step from `high` straight to `max`.
const NO_XHIGH: readonly EffortChoice[] = ['none', 'low', 'medium', 'high', 'max'];

/**
 * What a model's effort menu offers, weakest first. Empty means no knob at all: `output_config
 * .effort` 400s on Haiku 4.5, Sonnet 4.5 and earlier, and the Gemini backend passes none.
 *
 * `none` is absent where an explicit `thinking: disabled` is refused — Fable/Mythos 5 think
 * unconditionally and 400 on it.
 */
export function effortChoicesFor(modelId: string): readonly EffortChoice[] {
  const id = modelId.toLowerCase();
  if (/(fable|mythos)-5/.test(id)) return EFFORT_LEVELS;
  if (/(opus|sonnet)-5/.test(id) || /opus-4-[7-9]/.test(id)) return EFFORT_CHOICES;
  if (/opus-4-[5-6]/.test(id) || id.includes('sonnet-4-6')) return NO_XHIGH;
  return [];
}

/**
 * The choice a model will actually honour. Returns the requested choice when the model offers it,
 * otherwise the nearest weaker choice it does offer, falling back to its weakest choice when
 * nothing weaker exists, and `undefined` when it offers no choices at all.
 *
 * A stored choice outlives the model that offered it: picking `xhigh` on Opus 4.8 and switching to
 * Sonnet 4.6 leaves a level the new model will not take. The setting is deliberately kept across a
 * switch, so it is stepped down here rather than refused.
 */
export function resolveEffort(modelId: string, choice: EffortChoice): EffortChoice | undefined {
  const offered = effortChoicesFor(modelId);
  if (offered.length === 0) return undefined;
  if (offered.includes(choice)) return choice;
  const wanted = EFFORT_CHOICES.indexOf(choice);
  const weaker = offered.filter((c) => EFFORT_CHOICES.indexOf(c) <= wanted);
  return weaker[weaker.length - 1] ?? offered[0];
}

/** How a choice reads in a menu. `none` reads as `no thinking`, a state rather than a level. */
export function effortLabel(choice: EffortChoice): string {
  return choice === 'none' ? 'no thinking' : choice;
}

/** Whether a model honours a reasoning setting at all — what a surface greys out on. */
export function supportsEffort(modelId: string): boolean {
  return effortChoicesFor(modelId).length > 0;
}

/**
 * Whether a model accepts a `{"role": "system"}` message inside `messages[]`. Such a message files
 * turn-scoped truth (the plan/execute mode, a section of the system prompt that has since been
 * rewritten) without recomposing the cached prefix.
 *
 * The predicate is model-level rather than backend-level because all four curated Claude entries go
 * through the same `createAnthropicChat`. An unsupported model answers `role 'system' is not
 * supported on this model`, and the caller down-renders to a `user` turn instead. That matters most
 * on a mid-session model switch, which keeps the transcript.
 */
export function supportsSystemRole(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /(fable|mythos)-5/.test(id) || /opus-5/.test(id) || /opus-4-8/.test(id);
}
