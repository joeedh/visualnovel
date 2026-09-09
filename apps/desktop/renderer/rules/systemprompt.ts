/**
 * What the system-prompt viewer reports about the prompt, kept out of the editor so the arithmetic
 * is testable without a pane.
 *
 * The sections travel separately because that is how they are cached and superseded, but what the
 * agent receives is the join — so anything counted here counts the join, never the sum of the
 * parts, which would be short by one separator per section.
 */
import type { SystemSectionView } from '../../src/shared/ipc';
import { refuse, type Offer } from './anchors.js';
import { view } from './effects.js';

/** What the viewer reads when it draws its bar: whether a prompt has been read. */
export interface SystemPromptState {
  /** How many sections the prompt has; none until a project is open. */
  sections: number;
}

/**
 * Copy, as `app.copy` with the joined prompt as what the click supplies. Refused while there is no
 * prompt to put on the clipboard.
 */
export function copyAction(sections: number): Offer {
  const control = {
    id      : 'app.copy',
    label   : 'Copy',
    tooltip:
      'Put the whole prompt — every section, joined the way the agent gets it — on the clipboard',
    supplies: ['text'],
  };
  if (sections === 0) return { ...refuse('No prompt — open a project first.'), ...control };
  return { ok: true, props: { what: 'the system prompt' }, ...control };
}

export function reloadAction(): Offer {
  return {
    ok: true,
    ...view('reload'),
    on     : 'reload',
    label  : '⟳',
    tooltip:
      'Re-read the prompt. The project map and AICONTEXT.md are files, and either may have moved',
  };
}

/** Every offer the viewer draws from this module: Copy, then reload. */
export function controls(state: SystemPromptState): readonly Offer[] {
  return [copyAction(state.sections), reloadAction()];
}

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
