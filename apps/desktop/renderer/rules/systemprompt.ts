/**
 * What the system-prompt viewer reports about the prompt, kept out of the editor so the arithmetic
 * is testable without a pane.
 *
 * The sections travel separately because that is how they are cached and superseded, but what the
 * agent receives is the join — so anything counted here counts the join, never the sum of the
 * parts, which would be short by one separator per section.
 */
import type { SystemSectionView } from '../../src/shared/ipc';

/** The one place the section separator is written down on this side of the wire. */
const SEPARATOR = '\n\n';

/**
 * The whole prompt as one string — `joinSections`'s answer, reproduced here rather than imported:
 * this module is in the browser bundle and `@vn/authoring` is node-side. The separator is asserted
 * against the real one by the viewer's test.
 */
export function joined(sections: readonly SystemSectionView[]): string {
  return sections.map((section) => section.text).join(SEPARATOR);
}

/** A rough token count, meant as a sense of scale. {@link scaleOf} marks it with a tilde. */
export function roughTokens(text: string): number {
  return Math.round(text.length / 4);
}

/** The sentence under the header, giving the size of the prompt the next turn carries. */
export function scaleOf(sections: readonly SystemSectionView[], modelId: string): string {
  const text = joined(sections);
  const chars = text.length;
  const parts = `${sections.length} section${sections.length === 1 ? '' : 's'}`;
  const lines = text === '' ? 0 : text.split('\n').length;
  return `${parts} · ${lines} lines · ${chars} chars · ~${roughTokens(text)} tokens${
    modelId ? ` · ${modelId}` : ''
  }`;
}
