import {
  answerAt,
  answersOf,
  answersOnPick,
  blankPages,
  choiceTitle,
  goTo,
  isFirst,
  isLast,
  isPicked,
  pageLabel,
  pick,
  startForm,
  type,
} from '../askform.js';
import type { AskQuestion } from '../../../src/shared/ipc.js';

const ONE: AskQuestion[] = [{ question: 'Which ending?', choices: ['Bitter', 'Sweet'] }];

const FORM: AskQuestion[] = [
  { question: 'Which ending?', choices: ['Bitter', 'Sweet'] },
  { question: 'Who is present?', choices: ['Aiko', 'Haruki', 'Mei'], multi: true },
  { question: 'Anything else?' },
];

describe('paging', () => {
  it('starts on the first page with nothing filled in', () => {
    const form = startForm(FORM);
    expect(form.at).toBe(0);
    expect(isFirst(form)).toBe(true);
    expect(isLast(form)).toBe(false);
    expect(answersOf(form)).toEqual(['', '', '']);
  });

  it('clamps rather than running off either end', () => {
    const form = startForm(FORM);
    expect(goTo(form, -3).at).toBe(0);
    expect(goTo(form, 99).at).toBe(2);
    expect(isLast(goTo(form, 99))).toBe(true);
  });

  it('says where the author is, and says nothing at all for a form of one', () => {
    expect(pageLabel(goTo(startForm(FORM), 1))).toBe('Question 2 of 3');
    expect(pageLabel(startForm(ONE))).toBe('');
  });
});

describe('picking', () => {
  it('replaces a single pick — picking again is changing your mind', () => {
    const form = pick(pick(startForm(FORM), 'Bitter'), 'Sweet');
    expect(answerAt(form, 0)).toBe('Sweet');
    expect(isPicked(form, 'Bitter')).toBe(false);
  });

  it('keeps a single pick picked when it is clicked again', () => {
    const form = pick(startForm(FORM), 'Bitter');
    expect(pick(form, 'Bitter')).toBe(form);
    expect(isPicked(pick(form, 'Bitter'), 'Bitter')).toBe(true);
    const last = pick(goTo(startForm([...FORM.slice(2), FORM[0]!]), 1), 'Sweet');
    expect(answerAt(pick(last, 'Sweet'), 1)).toBe('Sweet');
  });

  it('toggles a multi pick and keeps the order they were clicked in', () => {
    let form = goTo(startForm(FORM), 1);
    form = pick(pick(pick(form, 'Mei'), 'Aiko'), 'Haruki');
    expect(answerAt(form, 1)).toBe('Mei, Aiko, Haruki');
    form = pick(form, 'Aiko');
    expect(answerAt(form, 1)).toBe('Mei, Haruki');
  });

  it('keeps a page’s picks to its own page', () => {
    let form = pick(startForm(FORM), 'Bitter');
    form = pick(goTo(form, 1), 'Aiko');
    expect(answersOf(form)).toEqual(['Bitter', 'Aiko', '']);
  });

  it('sends both the picks and what was typed beside them', () => {
    let form = pick(startForm(FORM), 'Sweet');
    form = type(form, 'but leave it ambiguous');
    expect(answerAt(form, 0)).toBe('Sweet, but leave it ambiguous');
  });

  it('drops typing that is only whitespace', () => {
    expect(answerAt(type(startForm(FORM), '   '), 0)).toBe('');
  });

  // The card sends a lone single-pick question on the click. What is typed beside the list has to
  // be read off the form the click produced, or a qualified choice reaches the agent as the bare
  // choice.
  it('carries what was typed into an answer sent on the pick', () => {
    const form = pick(type(startForm(ONE), 'but keep it quiet'), 'Bitter');
    expect(answersOnPick(form)).toBe(true);
    expect(answersOf(form)).toEqual(['Bitter, but keep it quiet']);
  });
});

describe('choice tooltips', () => {
  it('offers to untick a picked choice only on a multi pick', () => {
    const multi = pick(goTo(startForm(FORM), 1), 'Aiko');
    expect(choiceTitle(multi, 'Aiko')).toBe('Leave “Aiko” out of your answer.');
    expect(choiceTitle(multi, 'Mei')).toBe('Include “Mei” in your answer. Pick as many as apply.');
  });

  it('says a picked single choice stays picked', () => {
    const first = pick(startForm(FORM), 'Bitter');
    expect(choiceTitle(first, 'Bitter')).toBe(
      'Keep “Bitter” as your answer and go on to the next question.',
    );
    expect(choiceTitle(first, 'Sweet')).toBe('Answer “Sweet” and go on to the next question.');
    const last = pick(goTo(startForm([...FORM.slice(2), FORM[0]!]), 1), 'Sweet');
    expect(choiceTitle(last, 'Sweet')).toBe(
      '“Sweet” is your answer to this question. Pick another choice to change it.',
    );
  });

  it('says a lone single pick answers outright', () => {
    expect(choiceTitle(startForm(ONE), 'Bitter')).toBe('Answer “Bitter”.');
  });

  it('never claims a click unticks a single pick', () => {
    const forms = [
      pick(startForm(FORM), 'Bitter'),
      pick(goTo(startForm([...FORM.slice(2), FORM[0]!]), 1), 'Bitter'),
      pick(startForm(ONE), 'Bitter'),
    ];
    for (const form of forms) expect(choiceTitle(form, 'Bitter')).not.toMatch(/out of|untick/i);
  });
});

describe('submitting', () => {
  // Blank is a real answer, so the count only feeds the button's sentence and does not gate
  // submitting
  it('names the pages still blank, one-based', () => {
    let form = pick(startForm(FORM), 'Bitter');
    expect(blankPages(form)).toEqual([2, 3]);
    form = type(goTo(form, 2), 'no');
    expect(blankPages(form)).toEqual([2]);
  });

  it('answers on the click only for one question with one pick', () => {
    expect(answersOnPick(startForm(ONE))).toBe(true);
    expect(answersOnPick(startForm(FORM))).toBe(false);
    expect(answersOnPick(startForm([{ question: 'Who?', choices: ['a', 'b'], multi: true }]))).toBe(
      false,
    );
  });
});
