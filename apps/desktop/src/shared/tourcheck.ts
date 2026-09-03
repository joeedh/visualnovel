/**
 * Reading a tour the agent wrote, and saying what is wrong with it before the author is shown it.
 *
 * A tour is machine-written text, so it is checked at the boundary the way `coerceProps` checks a
 * loose CDP value: a step naming a command the app does not have, or a prop it does not take, is a
 * hallucination and is refused here rather than sending the author to a form that cannot run.
 * Both entrances ask: `show_me`, where the agent writes one, and `tour.start`, where CDP or the
 * palette's `custom` field pastes one in.
 *
 * What is *not* checked here is whether a step would be accepted right now. `stack.check` answers
 * that at the step, over the props the author has by then — a tour's later steps are routinely
 * refused until its earlier ones are done, so refusing the whole tour on that would refuse every
 * correct multi-step tour. The refusal is shown beside the ring instead.
 */
import type { CoerceResult, PropSpecMap, PropValue } from '@vn/commands';
import type { Step, Tour } from './tours.js';

/** What the app has, as much of it as checking a tour needs. */
export interface Known {
  /** A command's prop specs, or undefined where there is no such command. */
  command(id: string): PropSpecMap | undefined;
  /** Whether the app declares this gesture. */
  interaction(id: string): boolean;
  /** `coerceProps`, so the one validation authority is the one that answers here too. */
  coerce(specs: PropSpecMap, props: Record<string, PropValue>): CoerceResult;
}

/** Read a tour from JSON. Only the shape is decided here; {@link checkTour} judges the contents. */
export function readTour(text: string): { ok: true; tour: Tour } | { ok: false; reason: string } {
  let read: unknown;
  try {
    read = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `that is not JSON: ${err instanceof Error ? err.message : err}` };
  }
  const tour = read as Partial<Tour>;
  if (!tour || typeof tour !== 'object') return { ok: false, reason: 'a tour is a JSON object' };
  if (typeof tour.id !== 'string' || tour.id === '') return { ok: false, reason: 'it needs an id' };
  if (typeof tour.title !== 'string' || tour.title === '') {
    return { ok: false, reason: 'it needs a title' };
  }
  if (typeof tour.what !== 'string' || tour.what === '') {
    return {
      ok: false,
      reason: 'it needs a `what`: one sentence on what the author will have done',
    };
  }
  if (!Array.isArray(tour.steps) || tour.steps.length === 0) {
    return { ok: false, reason: 'it needs at least one step' };
  }
  return { ok: true, tour: tour as Tour };
}

/** Everything wrong with a tour, one sentence each. An empty list is a tour the app can walk. */
export function checkTour(tour: Tour, known: Known): string[] {
  const problems: string[] = [];
  tour.steps.forEach((step, at) => {
    const where = `step ${at + 1}`;
    if (typeof step.say !== 'string' || step.say === '') {
      problems.push(`${where} says nothing to the author`);
      return;
    }
    for (const problem of checkStep(step, known)) problems.push(`${where}: ${problem}`);
  });
  return problems;
}

function checkStep(step: Step, known: Known): string[] {
  if (step.kind === 'select') {
    return step.itemKind && step.key ? [] : ['a select step names a kind and a key'];
  }
  if (step.kind === 'gesture') {
    if (!known.interaction(step.id)) return [`there is no gesture called "${step.id}"`];
    return step.carried ? [] : ['a gesture step names what the author picks up'];
  }

  const specs = known.command(step.id);
  if (!specs) return [`there is no command called "${step.id}"`];

  const problems: string[] = [];
  if (step.props) {
    // Only the props the step carries. A step leaves the rest to the author on purpose, and
    // `coerceProps` would report those as missing — which is the state the step is walking towards.
    const named = Object.fromEntries(
      Object.entries(specs).filter(([name]) => name in (step.props ?? {})),
    );
    for (const name of Object.keys(step.props)) {
      if (!(name in specs)) problems.push(`"${step.id}" takes no prop called "${name}"`);
    }
    const coerced = known.coerce(named, step.props);
    if (!coerced.ok) problems.push(coerced.errors.join('; '));
  }
  if (step.kind === 'input' && !(step.supplies in specs)) {
    problems.push(`"${step.id}" takes no prop called "${step.supplies}" for the author to type`);
  }
  return problems;
}
