/**
 * Which text models the authoring surfaces offer, and what reasoning each of them will accept.
 * Here rather than in `@vn/providers` because both the `vnauthor` REPL and the desktop renderer
 * need the same answers, and only one of them can import a package that loads a vendor SDK.
 */

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
 * Where every surface starts. Deliberately a level and not the absence of one: on Opus 4.7/4.8
 * and Sonnet 4.6 a request with no `thinking` field runs with no thinking at all, so "leave the
 * knob off" was the least capable setting available rather than a neutral one.
 */
export const DEFAULT_EFFORT: EffortChoice = 'low';

/** Curated text models offered by the `/model` menu and the convo pane; any id also works. */
export const TEXT_MODELS: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

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
 * The choice a model will actually honour: what was asked for, or the nearest thing it offers.
 * `undefined` when it offers nothing.
 *
 * A stored choice outlives the model that offered it — picking `xhigh` on Opus 4.8 and switching
 * to Sonnet 4.6 leaves a level the new model will not take — and the setting is deliberately kept
 * across a switch, so something has to step it down rather than refuse it.
 */
export function resolveEffort(modelId: string, choice: EffortChoice): EffortChoice | undefined {
  const offered = effortChoicesFor(modelId);
  if (offered.length === 0) return undefined;
  if (offered.includes(choice)) return choice;
  const wanted = EFFORT_CHOICES.indexOf(choice);
  const weaker = offered.filter((c) => EFFORT_CHOICES.indexOf(c) <= wanted);
  return weaker[weaker.length - 1] ?? offered[0];
}

/** How a choice reads in a menu — `none` is a state, not a level, and says so. */
export function effortLabel(choice: EffortChoice): string {
  return choice === 'none' ? 'no thinking' : choice;
}

/** Whether a model honours a reasoning setting at all — what a surface greys out on. */
export function supportsEffort(modelId: string): boolean {
  return effortChoicesFor(modelId).length > 0;
}

/**
 * Whether a model accepts a `{"role": "system"}` message inside `messages[]`. It is how
 * turn-scoped truth — the plan/execute mode, a section of the system prompt that has since been
 * rewritten — is filed without recomposing the cached prefix.
 *
 * A model-level predicate rather than a backend-level one, because all four curated Claude
 * entries go through the same `createAnthropicChat`: an unsupported model answers
 * `role 'system' is not supported on this model`, and the caller down-renders to a `user` turn
 * instead. That matters most on a mid-session model switch, which keeps the transcript.
 */
export function supportsSystemRole(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /(fable|mythos)-5/.test(id) || /opus-5/.test(id) || /opus-4-8/.test(id);
}
