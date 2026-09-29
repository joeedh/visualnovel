/**
 * The questions main asks before a command runs, in the order they arrived. One is on screen at a
 * time; the next is shown once the author answers the one in front of them. Pure, so the popup
 * that draws it is the only part that needs a screen.
 */

/** One question, as main pushed it in a `confirm` effect. */
export interface ConfirmAsk {
  id: number;
  sentence: string;
  /** The command's title, which labels the button that says yes. */
  title: string;
}

/** What goes back over `command:confirm`. */
export interface ConfirmAnswer {
  id: number;
  allowed: boolean;
}

export class ConfirmQueue {
  private readonly waiting: ConfirmAsk[] = [];

  /** The question on screen, or `undefined` when nothing is being asked. */
  current(): ConfirmAsk | undefined {
    return this.waiting[0];
  }

  /** Queues a question. Returns true when nothing was ahead of it, so the caller draws it now. */
  receive(ask: ConfirmAsk): boolean {
    this.waiting.push(ask);
    return this.waiting.length === 1;
  }

  /** Answers the question on screen and moves on to the next, or answers nothing when none is. */
  answer(allowed: boolean): ConfirmAnswer | undefined {
    const ask = this.waiting.shift();
    return ask ? { id: ask.id, allowed } : undefined;
  }
}

/** The sentence as paragraphs, one per line, since a long one lists what the command changes. */
export function confirmLines(sentence: string): string[] {
  return sentence.split('\n').filter((line) => line.trim().length > 0);
}
