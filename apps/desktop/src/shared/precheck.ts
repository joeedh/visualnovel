/**
 * Which invocation to ask `stack.check` about for a control a tour is pointing at, or for a
 * command the agent's `ux_check` asks about.
 *
 * A control's props are partial by design: a widget names what it supplies and a form holds the
 * rest, and the agent leaves out what it does not know. `stack.check` coerces before it reaches a
 * command's precondition, so asking with those props absent answers about the blank rather than
 * about the world — `missing required property "hash"` where the useful sentence is `aiko has no
 * portrait yet`. Passing the blank as an empty value reaches the precondition, which is written
 * for that case: see `gate.approve` in `src/main/commands/gate.ts`, whose refusal names the
 * unanswered field.
 *
 * Nothing is invented here. A required prop with no empty value — a number, an enum — leaves the
 * invocation unaskable, and a secret is never filled in even with a blank. Shared between the
 * renderer's tour and main's `ux_check` so the two ask the same question.
 */
import type { CatalogProp, PropKind, PropValue } from '@vn/commands';
import { isEffectId } from './effects.js';

/** What a control or a step knows: the id it runs and the props it carries. */
export interface Asked {
  id?: string;
  props: Record<string, PropValue>;
}

/** The invocation to check, with every required prop present. */
export interface Invocation {
  id: string;
  props: Record<string, PropValue>;
}

/** The unanswered value for each kind that has one. A kind absent here cannot be blanked. */
const BLANK: Partial<Record<PropKind, PropValue>> = {
  string    : '',
  directory : '',
  'string[]': [],
};

/** Whether the kind has a blank value. A secret has none, even though it holds a string. */
export function canBlank(prop: Pick<CatalogProp, 'kind'>): boolean {
  return BLANK[prop.kind] !== undefined;
}

/**
 * The invocation to check, or nothing where a required prop cannot be blanked honestly.
 *
 * `props` is the command's catalog entry. A control that names no command (a row publishing a
 * subject, a button performing an effect) has no precondition in the stack, so nothing is asked.
 */
export function checkFor(asked: Asked, props: readonly CatalogProp[]): Invocation | undefined {
  if (asked.id === undefined || isEffectId(asked.id)) return undefined;
  const filled: Record<string, PropValue> = { ...asked.props };
  for (const prop of props) {
    if (!prop.required || prop.name in filled) continue;
    const blank = BLANK[prop.kind];
    if (blank === undefined) return undefined;
    filled[prop.name] = Array.isArray(blank) ? [] : blank;
  }
  return { id: asked.id, props: filled };
}

/** How a checked invocation is remembered, so a redraw that did not change it is not re-asked. */
export const askedAs = (action: Invocation): string =>
  `${action.id}(${JSON.stringify(action.props, Object.keys(action.props).sort())})`;
