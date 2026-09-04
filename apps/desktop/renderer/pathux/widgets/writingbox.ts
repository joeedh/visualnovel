/**
 * A plain `<textarea>` in a path.ux row's shadow root, for free text of more than a line. Every
 * writing surface in this app draws one this way.
 *
 * Deliberately not path.ux's `textarea()`, which is a `contentEditable` rich-text editor with a
 * bold/italic toolbar and `innerHTML` for a value. That is more widget than a note needs, and it
 * stores markup where a command expects a string. Two surfaces draw one (a `multiline` prop in a
 * command form, the report preview), so the styling and the keydown rule live here rather than in
 * either surface.  UPDATE: path.ux now has a plain text area
 */
import type { Container } from 'pathux';
import { TOKENS } from '../app/tokens.js';

export interface WritingBoxOptions {
  value: string;
  /** What it does, on hover. Every writing surface in this app has one. */
  title: string;
  /** What it is, for a screen reader. */
  label: string;
  rows?: number;
  minHeight?: string;
  onInput: (text: string) => void;
}

export function writingBox(row: Container, opts: WritingBoxOptions): HTMLTextAreaElement {
  const box = document.createElement('textarea');
  box.value = opts.value;
  box.spellcheck = true;
  box.rows = opts.rows ?? 4;
  box.title = opts.title;
  box.setAttribute('aria-label', opts.label);
  Object.assign(box.style, {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: opts.minHeight ?? '72px',
    resize: 'vertical',
    padding: '6px 8px',
    border: `1px solid ${TOKENS.inkLine}`,
    borderRadius: `${TOKENS.radiusChrome}px`,
    background: TOKENS.inkSunken,
    color: TOKENS.paper,
    font: `13px ${TOKENS.sans}`,
  });
  box.addEventListener('input', () => opts.onInput(box.value));
  // The screen keymap is a bubble-phase window listener, so the box stops its own keys.
  box.addEventListener('keydown', (event) => event.stopPropagation());
  row.shadow.appendChild(box);
  return box;
}
