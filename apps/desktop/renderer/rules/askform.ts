/**
 * State of an ask form while the author is filling it in: the paging, the picks, and the text
 * typed beside them. Drawing lives elsewhere.
 *
 * One form covers several questions so a model that needs three things settled asks once instead
 * of parking its turn three times. A single question is a one-page form, so there is one shape
 * here rather than a separate question type.
 *
 * Every function is a pure transition on an immutable value. The pane holds one of these and
 * swaps it, which is what makes the paging testable in a node-only jest project.
 */
import type { AskQuestion } from '../../src/shared/ipc.js';

export interface AskForm {
  readonly questions: readonly AskQuestion[];
  /** The page being answered, zero-based. Always in range. */
  readonly at: number;
  /** What is ticked on each page, in the order it was clicked. */
  readonly picked: readonly (readonly string[])[];
  /** What was typed beside the list on each page. On a page with no list it is the whole answer. */
  readonly typed: readonly string[];
}

/** A fresh form on its first page, with nothing picked and nothing typed. */
export function startForm(questions: readonly AskQuestion[]): AskForm {
  return {
    questions,
    at    : 0,
    picked: questions.map(() => []),
    typed : questions.map(() => ''),
  };
}

/** The page being answered. A form is never empty, so this is never undefined in practice. */
export function pageOf(form: AskForm): AskQuestion | undefined {
  return form.questions[form.at];
}

export function isLast(form: AskForm): boolean {
  return form.at >= form.questions.length - 1;
}

export function isFirst(form: AskForm): boolean {
  return form.at <= 0;
}

/** Move to a page, clamped — a Next on the last page is a no-op rather than an error. */
export function goTo(form: AskForm, at: number): AskForm {
  const clamped = Math.max(0, Math.min(form.questions.length - 1, at));
  return clamped === form.at ? form : { ...form, at: clamped };
}

/**
 * Tick a choice on the current page. A multi-pick toggles the choice. A single-pick replaces
 * whatever was picked before.
 */
export function pick(form: AskForm, choice: string): AskForm {
  const multi = pageOf(form)?.multi === true;
  const here = form.picked[form.at] ?? [];
  const next = multi
    ? here.includes(choice)
      ? here.filter((c) => c !== choice)
      : [...here, choice]
    : [choice];
  return { ...form, picked: form.picked.map((row, i) => (i === form.at ? next : row)) };
}

export function isPicked(form: AskForm, choice: string): boolean {
  return (form.picked[form.at] ?? []).includes(choice);
}

/** Replace what is typed on the current page. */
export function type(form: AskForm, text: string): AskForm {
  return { ...form, typed: form.typed.map((t, i) => (i === form.at ? text : t)) };
}

/**
 * One page's answer: what was picked, then anything typed beside it. Both are included, because a
 * picked list plus a typed qualification is a single answer.
 */
export function answerAt(form: AskForm, at: number): string {
  const typed = (form.typed[at] ?? '').trim();
  return [...(form.picked[at] ?? []), ...(typed ? [typed] : [])].join(', ');
}

/** The whole form, positionally — what goes back over `ask:answer`. */
export function answersOf(form: AskForm): string[] {
  return form.questions.map((_, i) => answerAt(form, i));
}

/**
 * Which pages are still blank, one-based, for the submit button's sentence. A blank page is
 * allowed, so this names the blank pages rather than blocking submission.
 */
export function blankPages(form: AskForm): number[] {
  return form.questions.map((_, i) => i + 1).filter((n) => answerAt(form, n - 1) === '');
}

/**
 * Whether clicking a choice should submit the whole form immediately. True only for a single
 * question with a single pick. A form with a second page gets a Submit button instead, because an
 * answer sent by a stray click cannot be taken back.
 */
export function answersOnPick(form: AskForm): boolean {
  return form.questions.length === 1 && pageOf(form)?.multi !== true;
}

/** The card's page label. Empty when the form has one question. */
export function pageLabel(form: AskForm): string {
  return form.questions.length > 1 ? `Question ${form.at + 1} of ${form.questions.length}` : '';
}
