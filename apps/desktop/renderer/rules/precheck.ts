/**
 * Which invocation to ask `stack.check` about for an anchor a tour is pointing at.
 *
 * An anchor's props are partial by design: a widget names what it supplies and a form holds the
 * rest. `stack.check` coerces before it reaches a command's precondition, so asking with those
 * props absent answers about the blank rather than about the world — `missing required property
 * "hash"` where the useful sentence is `aiko has no portrait yet`. Passing the blank as an empty
 * value reaches the precondition, which is written for that case: see `gate.approve` in
 * `src/main/commands/gate.ts`, whose refusal names the unanswered field.
 *
 * Nothing is invented here. A required prop with no empty value — a number, an enum — leaves the
 * anchor unaskable, and a secret is never filled in even with a blank.
 */
import type { PropKind } from '@vn/commands';
import type { CatalogProp, PropValue } from '../../src/shared/ipc.js';
import { isEffectId } from '../../src/shared/effects.js';
import type { Action, Anchor } from './anchors.js';

/** The unanswered value for each kind that has one. A kind absent here cannot be blanked. */
const BLANK: Partial<Record<PropKind, PropValue>> = {
  string    : '',
  directory : '',
  'string[]': [],
};

/**
 * The invocation to check, or nothing where a required prop cannot be blanked honestly.
 *
 * `props` is the command's catalog entry. An anchor that names no command (a row publishing a
 * subject, a button performing an effect) has no precondition in the stack, so nothing is asked.
 */
export function checkFor(anchor: Anchor, props: readonly CatalogProp[]): Action | undefined {
  if (anchor.id === undefined || isEffectId(anchor.id)) return undefined;
  const filled: Record<string, PropValue> = { ...anchor.props };
  for (const prop of props) {
    if (!prop.required || prop.name in filled) continue;
    const blank = BLANK[prop.kind];
    if (blank === undefined) return undefined;
    filled[prop.name] = Array.isArray(blank) ? [] : blank;
  }
  return { id: anchor.id, props: filled };
}

/** How a checked invocation is remembered, so a redraw that did not change it is not re-asked. */
export const askedAs = (action: Action): string =>
  `${action.id}(${JSON.stringify(action.props, Object.keys(action.props).sort())})`;
