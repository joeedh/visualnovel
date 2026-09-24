/**
 * What a `docs` push from main does in this window, dispatched on its `action`. `bridge.ts`
 * calls it for every such push. It is a module of its own so the dispatch can be tested without
 * path.ux, which `bridge.ts` imports.
 */
import type { UiEffect } from '../../../src/shared/ipc.js';
import type { FileMove } from '../../../src/shared/fileops.js';
import { followMoves, saveAllDrafts, type SaveAllResult } from '../doctree/docbuffer.js';

export type DocsEffect = Extract<UiEffect, { type: 'docs' }>;

type Revealer = (paths: readonly string[]) => void;

const revealers = new Set<Revealer>();

/** Calls `listener` with the paths of every `reveal` push, until the returned function is called. */
export function onReveal(listener: Revealer): () => void {
  revealers.add(listener);
  return () => revealers.delete(listener);
}

type Mover = (moves: readonly FileMove[]) => void;

const movers = new Set<Mover>();

/** Calls `listener` with the moves of every `moved` push, until the returned function is called. */
export function onMoved(listener: Mover): () => void {
  movers.add(listener);
  return () => movers.delete(listener);
}

/**
 * What the dispatch reaches outside itself. `save` defaults to Save All over the real drafts, and
 * `follow` to moving the window's clean document buffers.
 */
export interface DocsDeps {
  say(text: string, bad?: boolean): void;
  save?: () => Promise<SaveAllResult>;
  follow?: Mover;
}

/**
 * Runs one `docs` push: Save All for `saveAll`, the documents panes' reveal for `reveal`, and for
 * `moved` the open documents, then every listener. A `moved` push saves nothing.
 */
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
    // Buffers before listeners: once a listener remaps `ui.docPath`, the Wiki pane compares it
    // with its buffer's path, which must already be the new one or the file is opened twice
    case 'moved':
      (deps.follow ?? followMoves)(effect.moves);
      for (const listener of movers) listener(effect.moves);
      return;
  }
}
