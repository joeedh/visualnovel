/**
 * The handful of raw-DOM primitives a surface editor builds from — the vocabulary the React
 * shell wrote as class names in `styles/*.css`, restated in TypeScript because a surface is not
 * a widget and has no theme sheet behind it.
 *
 * Everything here is a plain element with inline style from {@link TOKENS} and no behaviour.
 * Anything that needs a control — a button in a header, a menu, a slider — is a path.ux widget
 * instead, and does not belong in this file.
 */
import { TOKENS } from '../app/tokens.js';

/** The one colour the whole shell reads a task status by. */
export const STATUS_COLOUR: Record<string, string> = {
  done       : TOKENS.jade,
  running    : TOKENS.signal,
  failed     : TOKENS.vermilion,
  needs_human: TOKENS.sodium,
};

export const statusColour = (status: string): string => STATUS_COLOUR[status] ?? TOKENS.mistDim;

/** The index card every task, ghost and gate is drawn on. */
export function card(): HTMLDivElement {
  const box = document.createElement('div');
  Object.assign(box.style, {
    boxSizing     : 'border-box',
    display       : 'flex',
    flexDirection : 'column',
    justifyContent: 'center',
    gap           : '3px',
    padding       : '6px 9px',
    overflow      : 'hidden',
    border        : `1px solid ${TOKENS.inkLine}`,
    borderRadius  : `${TOKENS.radiusChrome}px`,
    background    : TOKENS.inkRaised,
  });
  return box;
}

/** Monospaced text for the machine side of a card: hashes, kinds and counts. */
export function mono(text: string, color: string, size = 10): HTMLElement {
  const span = document.createElement('span');
  span.textContent = text;
  Object.assign(span.style, { color, fontFamily: TOKENS.mono, fontSize: `${size}px` });
  return span;
}

/** A letterspaced display-face label — `⟂ GATE`, `ATTEMPTS`, `INSPECTOR`. */
export function stamp(text: string, color: string, size = 10): HTMLElement {
  const span = document.createElement('span');
  span.textContent = text;
  Object.assign(span.style, {
    color,
    fontFamily   : TOKENS.disp,
    fontWeight   : '800',
    letterSpacing: '0.2em',
    fontSize     : `${size}px`,
  });
  return span;
}

/** One horizontal line of a card. */
export function row(): HTMLDivElement {
  const line = document.createElement('div');
  Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '7px' });
  return line;
}

/** What a task is about, in one line that truncates rather than wraps. */
export function subject(text: string, color: string): HTMLElement {
  const div = document.createElement('div');
  div.textContent = text;
  Object.assign(div.style, {
    fontFamily: TOKENS.mono,
    fontSize  : '11.5px',
    color,
    whiteSpace  : 'nowrap',
    overflow    : 'hidden',
    textOverflow: 'ellipsis',
  });
  return div;
}

/** The status dot, which carries the colour and nothing else. */
export function dot(colour: string, size = 7): HTMLElement {
  const span = document.createElement('span');
  Object.assign(span.style, {
    width       : `${size}px`,
    height      : `${size}px`,
    borderRadius: '50%',
    flex        : 'none',
    background  : colour,
  });
  return span;
}

/** One line of explanation where a surface's content would be. */
export function centered(text: string): HTMLElement {
  const div = document.createElement('div');
  div.textContent = text;
  Object.assign(div.style, {
    position      : 'absolute',
    inset         : '0',
    display       : 'flex',
    alignItems    : 'center',
    justifyContent: 'center',
    padding       : '0px 24px',
    textAlign     : 'center',
    color         : TOKENS.mist,
    fontFamily    : TOKENS.mono,
    fontSize      : '13px',
  });
  return div;
}

/** One line of explanation in the flow rather than filling the surface. */
export function note(text: string, color: string = TOKENS.mistDim): HTMLElement {
  const div = document.createElement('div');
  div.textContent = text;
  Object.assign(div.style, {
    padding: '10px 12px',
    color,
    fontFamily: TOKENS.mono,
    fontSize  : '12px',
    lineHeight: '1.5',
  });
  return div;
}
