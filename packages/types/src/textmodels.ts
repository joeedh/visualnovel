/**
 * Which text models the authoring surfaces offer, and which of them honour a reasoning-effort
 * setting. Here rather than in `@vn/providers` because both the `vnauthor` REPL and the desktop
 * renderer need the same three answers, and only one of them can import a package that loads a
 * vendor SDK.
 */

/** The effort levels a surface may offer, in order. A tuple, so a command prop can name it. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Reasoning-effort level (Anthropic `output_config.effort`). Higher levels think more and
 * spend more tokens. Only meaningful for models {@link supportsEffort} answers for.
 */
export type Effort = (typeof EFFORT_LEVELS)[number];

/** Curated text models offered by the `/model` menu and the convo pane; any id also works. */
export const TEXT_MODELS: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

/**
 * Whether a Claude model accepts `output_config.effort`. Supported on Opus 4.5+, Sonnet 4.6,
 * and Fable/Mythos 5; it 400s on Sonnet 4.5 / Haiku 4.5 and earlier, so we omit it there.
 */
export function supportsEffort(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /opus-4-[5-9]/.test(id) || id.includes('sonnet-4-6') || /(fable|mythos)-5/.test(id);
}
