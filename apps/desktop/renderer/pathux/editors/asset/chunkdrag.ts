import { UNRESOLVED, type Verdict } from '@vn/commands';
import { chunkDropTarget } from '../../../rules/promptview.js';
import { promptReorder, type PromptDragState } from '../../../../src/shared/interactions.js';
import { TOP_CHUNK } from '../../../../src/shared/promptops.js';
import type { PromptView } from '../../../../src/shared/prompt.js';
import type { AssetEditor } from './index.js';

/** A reorder in flight: every insertion point's verdict, judged once on the grab. */
export interface ChunkDrag {
  chunk: string;
  verdicts: Map<string, Verdict>;
  /** The insertion point under the pointer — `TOP_CHUNK`, or the chunk it would sit after. */
  target: string;
}

/**
 * Drag-to-reorder for prompt clauses. Judges every insertion point once on the grab, from the
 * same pure rule the command runs, so a mid-gesture verdict matches the verdict that would apply
 * on commit. Nothing moves until pointerup.
 */
export class ChunkDragController {
  private drag: ChunkDrag | undefined;
  /** The card to put focus back on after the list is redrawn. */
  refocus = '';
  /** The footer a drag writes into, holding the verdict for the insertion point under the pointer. */
  dragNote: HTMLElement | undefined;

  constructor(private readonly editor: AssetEditor) {}

  grabChunk(view: PromptView, chunk: string, rail: HTMLElement, event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const state: PromptDragState = { hash: view.hash, chunks: view.chunks, mode: view.mode };
    const verdicts = promptReorder.targets(state, chunk);
    const refusal = verdicts.find((v) => v.target === UNRESOLVED);
    if (refusal && !refusal.accept) return this.editor.complain(refusal.reason);

    this.drag = {
      chunk,
      verdicts: new Map(verdicts.map((v) => [v.target, v])),
      target  : chunk,
    };
    rail.setPointerCapture(event.pointerId);

    const move = (e: PointerEvent) => this.aimDrag(e.clientY);
    const up = (e: PointerEvent) => {
      rail.removeEventListener('pointermove', move);
      rail.removeEventListener('pointerup', up);
      rail.releasePointerCapture(e.pointerId);
      void this.dropChunk();
    };
    rail.addEventListener('pointermove', move);
    rail.addEventListener('pointerup', up);
    this.aimDrag(event.clientY);
  }

  private chunkRows(): { key: string; top: number; bottom: number }[] {
    return [...this.editor.surface.querySelectorAll('.as-chunk')].map((node) => {
      const box = node.getBoundingClientRect();
      return {
        key   : (node as HTMLElement).dataset['chunk'] ?? '',
        top   : box.top,
        bottom: box.bottom,
      };
    });
  }

  private aimDrag(y: number): void {
    if (!this.drag) return;
    this.drag.target = chunkDropTarget(this.chunkRows(), y);
    this.paintDrag();
  }

  /** The insertion rule and the sentence under it. Layout changes on commit, never during. */
  private paintDrag(): void {
    const cards = [...this.editor.surface.querySelectorAll('.as-chunk')] as HTMLElement[];
    for (const card of cards) card.classList.remove('dragging', 'drop-before', 'drop-after');
    if (this.dragNote) this.dragNote.textContent = '';

    const drag = this.drag;
    if (!drag) return;
    for (const card of cards) {
      if (card.dataset['chunk'] === drag.chunk) card.classList.add('dragging');
    }

    const verdict = drag.verdicts.get(drag.target);
    if (this.dragNote) {
      this.dragNote.textContent = verdict
        ? verdict.accept
          ? verdict.note
          : verdict.reason
        : 'Leave it where it is.';
      this.dragNote.classList.toggle('bad', verdict ? !verdict.accept : false);
    }
    if (!verdict?.accept) return;

    if (drag.target === TOP_CHUNK) cards[0]?.classList.add('drop-before');
    else {
      for (const card of cards) {
        if (card.dataset['chunk'] === drag.target) card.classList.add('drop-after');
      }
    }
  }

  private async dropChunk(): Promise<void> {
    const drag = this.drag;
    this.drag = undefined;
    this.paintDrag();
    if (!drag) return;

    const verdict = drag.verdicts.get(drag.target);
    if (!verdict) return;
    if (!verdict.accept) return this.editor.complain(verdict.reason);
    this.refocus = drag.chunk;
    await this.editor.runPrompt(verdict.invoke.id, verdict.invoke.props);
  }

  /** `Alt+↑`/`Alt+↓`: the same command, through the same lookup, without the pointer. */
  async nudge(view: PromptView, chunk: string, delta: number): Promise<void> {
    const keys = view.chunks.map((c) => c.key);
    const from = keys.indexOf(chunk);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= keys.length) return;
    // Moving up past the neighbour means sitting after what that neighbour sat after.
    const target = delta > 0 ? keys[to]! : to === 0 ? TOP_CHUNK : keys[to - 1]!;

    const verdicts = promptReorder.targets(
      { hash: view.hash, chunks: view.chunks, mode: view.mode },
      chunk,
    );
    const verdict = verdicts.find((v) => v.target === target);
    if (!verdict) return;
    if (!verdict.accept) return this.editor.complain(verdict.reason);
    this.refocus = chunk;
    await this.editor.runPrompt(verdict.invoke.id, verdict.invoke.props);
  }
}
