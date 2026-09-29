import { ConfirmQueue, confirmLines } from '../confirm.js';

describe('ConfirmQueue', () => {
  it('shows the first question and answers it with its own id', () => {
    const queue = new ConfirmQueue();
    expect(queue.receive({ id: 3, sentence: 'Run Upload files?', title: 'Upload files' })).toBe(
      true,
    );
    expect(queue.current()?.id).toBe(3);
    expect(queue.answer(true)).toEqual({ id: 3, allowed: true });
    expect(queue.current()).toBeUndefined();
  });

  it('holds a second question until the first is answered', () => {
    const queue = new ConfirmQueue();
    queue.receive({ id: 1, sentence: 'first', title: 'A' });
    expect(queue.receive({ id: 2, sentence: 'second', title: 'B' })).toBe(false);
    expect(queue.current()?.id).toBe(1);
    expect(queue.answer(false)).toEqual({ id: 1, allowed: false });
    expect(queue.current()?.id).toBe(2);
  });

  it('answers nothing when nothing is being asked', () => {
    expect(new ConfirmQueue().answer(true)).toBeUndefined();
  });
});

describe('confirmLines', () => {
  it('splits a long sentence into its lines and drops blank ones', () => {
    expect(confirmLines('Deletes 3 files.\n\n  \nRewrites 2 scenes.')).toEqual([
      'Deletes 3 files.',
      'Rewrites 2 scenes.',
    ]);
  });
});
