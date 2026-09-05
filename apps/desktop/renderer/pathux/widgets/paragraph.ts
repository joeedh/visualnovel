/**
 * Prose in a path.ux container.
 *
 * A `Label` is a `<div>` that sizes itself to its text and is never told how wide it may be, so a
 * sentence longer than the popup hosting it paints straight through the edge and off the window —
 * the popup's own `width` does not clip it. Everything the shell draws as a sentence rather than
 * as a name goes through here: a command's description, and the verdict its precondition answered.
 */
import type { Container, Label } from 'pathux';

/** One paragraph, wrapped inside `width` pixels instead of running past it. */
export function paragraph(col: Container, text: string, width: number): Label {
  const label = col.label(text);
  Object.assign(label.dom.style, {
    whiteSpace  : 'normal',
    overflowWrap: 'break-word',
    maxWidth    : `${width}px`,
  });
  return label;
}
