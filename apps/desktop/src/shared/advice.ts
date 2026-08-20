/**
 * Which model to hand a conversation that went wrong, and how hard it should think about it.
 *
 * Deliberately not beside `effortChoicesFor` in `@vn/types`: that table records what a model will
 * accept, which is a fact about the API that every surface reads. This module records a
 * recommendation for one task, reading a broken transcript.
 *
 * Every verdict here is advice, never a refusal. `agent.setEffort` accepts every choice, not only
 * the ones the current model offers.
 */
import {
  EFFORT_CHOICES,
  effortLabel,
  resolveEffort,
  supportsEffort,
  type EffortChoice,
} from '@vn/types';

export interface Advice {
  /** `ok` has nothing to say and its `text` is empty. */
  level: 'ok' | 'note' | 'warn';
  text: string;
}

const fine: Advice = { level: 'ok', text: '' };

/** The stronger of two choices, by the order every effort menu is drawn in. */
export function stronger(a: EffortChoice, b: EffortChoice): EffortChoice {
  return EFFORT_CHOICES.indexOf(a) >= EFFORT_CHOICES.indexOf(b) ? a : b;
}

/**
 * The effort this dialog opens on: what the author has bound, raised to at least medium and then
 * clamped to what the model takes. `DEFAULT_EFFORT` is `low`, so without the raise nearly every
 * author would meet the `low` note the first time they opened the dialog.
 */
export function analysisEffort(modelId: string, bound: EffortChoice): EffortChoice | undefined {
  return resolveEffort(modelId, stronger(bound, 'medium'));
}

/** True when the dialog raised the bound choice, so the accept note can say it did. */
export function raisedEffort(modelId: string, bound: EffortChoice): boolean {
  const raised = analysisEffort(modelId, bound);
  return raised !== undefined && raised !== resolveEffort(modelId, bound);
}

/** The short name a warning calls a model by — `claude-haiku-4-5` reads badly mid-sentence. */
function familyName(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes('gemini')) {
    if (id.includes('flash')) return 'Gemini Flash';
    if (id.includes('pro')) return 'Gemini Pro';
    return 'Gemini';
  }
  for (const name of ['haiku', 'fable', 'mythos', 'sonnet', 'opus']) {
    if (id.includes(name)) return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return modelId;
}

const SMALL = /haiku|flash/;
const FICTION = /fable|mythos/;
const NO_KNOB = /gemini/;

/**
 * What to say about the model that will read the transcript. An id outside the curated list is
 * allowed and gets no advice — `agent.setModel` takes a string, not an enum, and so does this.
 *
 * `withSource` sharpens the small-model warning rather than adding a second one: reading the
 * source is a long tool loop over a large codebase, which is where a small model fails outright
 * instead of merely underperforming.
 */
export function adviseModel(modelId: string, withSource: boolean): Advice {
  const id = modelId.toLowerCase();
  const name = familyName(modelId);

  if (FICTION.test(id)) {
    return {
      level: 'warn',
      text:
        `${name} cannot be used with zero data retention — what you send it is kept for 30 days, ` +
        `which is the one thing this report is trying to avoid. It also costs more than Opus and ` +
        `is tuned for writing fiction, not for diagnosing a tool loop.`,
    };
  }

  if (SMALL.test(id)) {
    const loop = withSource
      ? ` Reading the source is a long tool loop over a large codebase, and a small model with a ` +
        `short context is where that fails rather than merely underperforms.`
      : '';
    return {
      level: 'warn',
      text: `${name} is a fast model for short work. Sonnet or Opus will read this conversation far better.${loop}`,
    };
  }

  if (NO_KNOB.test(id)) {
    return {
      level: 'note',
      text: `${name} will do this, though it has no reasoning setting to turn up for it.`,
    };
  }

  return fine;
}

/**
 * What to say about how hard the model thinks. Only asked of a model with a reasoning setting;
 * for a model without one, `adviseModel` carries the advice and the row is not drawn.
 */
export function adviseEffort(modelId: string, effort: EffortChoice): Advice {
  if (!supportsEffort(modelId)) return fine;
  switch (effort) {
    case 'none':
      return {
        level: 'warn',
        text: 'Thinking off. The report will be a summary of the conversation rather than a diagnosis of it.',
      };
    case 'low':
      return {
        level: 'note',
        text: 'A diagnosis wants some thinking — medium is the sweet spot for this.',
      };
    case 'xhigh':
    case 'max':
      return {
        level: 'note',
        text: 'More thinking than this needs — the evidence is one transcript, and the answer is a diagnosis, not a search.',
      };
    default:
      return fine;
  }
}

const RANK: Record<Advice['level'], number> = { warn: 2, note: 1, ok: 0 };

/**
 * The one sentence the dialog's accept strip shows, worst level first. The tick says the run will
 * happen; this sentence says what it will cost.
 */
export function adviseRun(
  modelId: string,
  effort: EffortChoice,
  withSource: boolean,
  bound?: EffortChoice,
): string {
  const said = [adviseModel(modelId, withSource), adviseEffort(modelId, effort)]
    .filter((advice) => advice.level !== 'ok')
    .sort((a, b) => RANK[b.level] - RANK[a.level])
    .map((advice) => advice.text);

  // A raised default is announced rather than applied silently
  if (
    bound !== undefined &&
    raisedEffort(modelId, bound) &&
    effort === analysisEffort(modelId, bound)
  ) {
    said.push(
      `Raised to ${effortLabel(effort)} for this analysis; your conversation setting is unchanged.`,
    );
  }

  return said.join(' ');
}
