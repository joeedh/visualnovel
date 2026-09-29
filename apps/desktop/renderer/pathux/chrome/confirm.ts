/**
 * The popup for a command's confirmation: the sentence main sent, Cancel, and a button named after
 * the command. Closing it any way (Escape, a click outside, Cancel) answers no.
 *
 * Enter is not bound to the confirm button. Most commands that ask here delete or re-key
 * something, and an Enter meant for the pane underneath would run them.
 */
import { UIBase, type Container } from 'pathux';
import { api } from '../../api.js';
import { ConfirmQueue, confirmLines, type ConfirmAsk } from '../../rules/confirm.js';
import { shell } from '../app/bridge.js';
import { paragraph } from '../widgets/paragraph.js';
import { INSET, onPopupClosed, popupLeft, stylePopup } from './popup.js';

/** What `Screen.popup` hands back: a container that also knows how to dismiss itself. */
type Popup = Container & { end(): void };

const WIDTH = 440;
const PROSE = WIDTH - INSET;

const queue = new ConfirmQueue();

/** Answer the question on screen, then show the next one if another command is waiting. */
function answer(allowed: boolean): void {
  const answered = queue.answer(allowed);
  if (!answered) return;
  void api.invoke('command:confirm', answered);
  const next = queue.current();
  if (next) draw(next);
}

/** Draws one question. With no screen it answers no, so the command waiting in main can end. */
function draw(ask: ConfirmAsk): void {
  const screen = shell().screen;
  if (!screen) {
    answer(false);
    return;
  }

  const x = popupLeft(screen, WIDTH);
  const y = Math.max(56, Math.round(screen.size[1] * 0.22));
  const popup = screen.popup(screen as unknown as UIBase, x, y, false) as Popup;
  stylePopup(popup, screen, WIDTH, y);

  let decided: boolean | undefined;
  onPopupClosed(popup, () => answer(decided ?? false));
  const close = (allowed: boolean): void => {
    decided = allowed;
    popup.end();
  };

  const body = popup.col();
  for (const line of confirmLines(ask.sentence)) {
    const text = paragraph(body, line, PROSE);
    text.description = `What ${ask.title} asks before it runs`;
  }

  const row = body.row();
  const cancel = row.button('Cancel', () => close(false));
  cancel.description = `Do not run ${ask.title}; nothing is changed`;
  const go = row.button(ask.title, () => close(true));
  go.description = `Run ${ask.title} now`;

  popup.flushUpdate();
}

/** Show a question main asked, now or once the one in front of it is answered. */
export function askToConfirm(ask: ConfirmAsk): void {
  if (queue.receive(ask)) draw(ask);
}
