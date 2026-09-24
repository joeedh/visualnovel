/**
 * What a `docs` push from main does in this window, dispatched on its `action`. `bridge.ts`
 * calls it for every such push. It is a module of its own so the dispatch can be tested without
 * path.ux, which `bridge.ts` imports.
 */
import type { UiEffect } from '../../../src/shared/ipc.js';
import { saveAllDrafts, type SaveAllResult } from '../doctree/docbuffer.js';

export type DocsEffect = Extract<UiEffect, { type: 'docs' }>;

type Revealer = (paths: readonly string[]) => void;

const revealers = new Set<Revealer>();

/** Calls `listener` with the paths of every `reveal` push, until the returned function is called. */
export function onReveal(listener: Revealer): () => void {
  revealers.add(listener);
  return () => revealers.delete(listener);
}

/** What the dispatch reaches outside itself. `save` defaults to Save All over the real drafts. */
export interface DocsDeps {
  say(text: string, bad?: boolean): void;
  save?: () => Promise<SaveAllResult>;
}

/** Runs one `docs` push: Save All for `saveAll`, and the documents panes' reveal for `reveal`. */
export async function docsEffect(effect: DocsEffect, deps: DocsDeps): Promise<void> {
  switch (effect.action) {
    case 'saveAll': {
      const result = await (deps.save ?? saveAllDrafts)();
      const saved = result.saved.length;
      const refused = result.refused.map((r) => `${r.path}: ${r.reason}`).join('; ');
      if (saved === 0 && refused === '') deps.say('Nothing to save.');
      else if (refused === '') deps.say(`Saved ${saved} document(s).`);
      else deps.say(`Saved ${saved} document(s); refused — ${refused}`, true);
      return;
    }
    case 'reveal':
      for (const listener of revealers) listener(effect.paths);
      return;
    // Open documents do not follow a move yet, and a move saves nothing
    case 'moved':
      return;
  }
}
