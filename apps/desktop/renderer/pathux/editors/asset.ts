import type { Container } from 'pathux';
import { UNRESOLVED, type Verdict } from '@vn/commands';
import { exec, onInvalidate, say } from '../bridge.js';
import {
  approveAction,
  badgesOf,
  driftNote,
  promoteAction,
  promptEditable,
  promptShown,
  replaceAction,
} from '../../rules/assetview.js';
import {
  chunkAddress,
  chunkDropTarget,
  chunkTag,
  chunkTexture,
  chunkVoice,
  condenseAction,
  coverageMark,
  heldNote,
  modeStrip,
  originAction,
  refStrip,
  type OriginAction,
  type RefChip,
} from '../../rules/promptview.js';
import { promptReorder, type PromptDragState } from '../../../src/shared/interactions.js';
import { TOP_CHUNK } from '../../../src/shared/promptops.js';
import { VnEditor, registerEditor } from '../editor.js';
import ASSET_CSS from '../../styles/asset.css?inline';
import type { AssetInfo, ArtRungInfo, PropValue } from '../../../src/shared/ipc.js';
import type { PromptChunkInfo, PromptView } from '../../../src/shared/prompt.js';

/** A reorder in flight: every insertion point's verdict, judged once on the grab. */
interface ChunkDrag {
  chunk: string;
  verdicts: Map<string, Verdict>;
  /** The insertion point under the pointer — `TOP_CHUNK`, or the chunk it would sit after. */
  target: string;
}

/**
 * One generated asset: the bytes, the prompt that made them, and the art notes that would make
 * them differently. Its subject is `ui.assetHash`, which the documents tree publishes — the same
 * arrangement the inspector has with `ui.taskHash`, and for the same reason: the pane follows the
 * selection without the tree knowing it is open.
 *
 * The prompt is **read-only** for every kind but one. A derived prompt is folded into the task's
 * content hash and rewritten on every planning pass, so an editable one would freeze the asset
 * against every later improvement to the builders; the boxes underneath are its editable half —
 * art notes are authored input, appended to the derivation, and setting one re-keys the task, so
 * regenerating is `pipeline.run` and nothing more. A **concept** has no builder: its prompt is the
 * sentence it was asked for, so the box holds it and `art.redraw` draws it again.
 */
export class AssetEditor extends VnEditor {
  private bar!: Container;
  private surface!: HTMLDivElement;

  private info: AssetInfo | undefined;
  private failure = '';
  /** The hash the shown info is for, which trails `ui.assetHash` by one async read. */
  private shown = '';
  /** Rising with every load, so a slow read for an asset the author already left is dropped. */
  private token = 0;
  /** Rungs typed into and not yet committed — a refetch under them would eat the edit. */
  private dirty = new Set<string>();
  /** The variant id typed into the promote strip; kept here so a rebuild does not drop it. */
  private variant = '';
  /** The concept's prompt and name as the boxes hold them — prefilled, then whatever was typed. */
  private draft = '';
  private titleDraft = '';
  /** True once the prompt box was typed into, so a background refetch stops overwriting it. */
  private promptDirty = false;
  /** Chunk boxes open for editing: the clause key → which op the box commits. */
  private editing = new Map<string, 'replace' | 'append'>();
  /** The custom box as typed; `undefined` until it is, so a refetch refills it from the project. */
  private customDraft: string | undefined;
  /** The reorder in flight, and the card to put focus back on after the list is redrawn. */
  private drag: ChunkDrag | undefined;
  private refocus = '';
  private dragNote: HTMLElement | undefined;
  private unwatch: (() => void) | undefined;

  static override define() {
    return {
      tagname: 'vn-asset-editor-x',
      areaname: 'asset',
      uiname: 'Asset',
      icon: -1,
    };
  }

  override init() {
    super.init();

    this.bar = (this.header as Container).row();

    this.adoptStyle(ASSET_CSS);
    this.surface = document.createElement('div');
    this.surface.className = 'as-surface';
    this.appendSurface(this.surface);

    // Anything that wrote could have been the art-notes edit this pane just ran, or an undo of
    // one — either way the derived prompt and the drift flag are re-derived on read, so the
    // honest move is to ask again rather than patch what is drawn.
    this.unwatch = onInvalidate(() => {
      if (this.shown !== '' && this.dirty.size === 0 && !this.promptDirty)
        void this.load(this.shown);
    });

    this.rebuild();
    void this.load(this.ui.assetHash);
  }

  override on_remove() {
    this.unwatch?.();
    this.unwatch = undefined;
    super.on_remove();
  }

  override update() {
    super.update();

    if (this.ui.assetHash !== this.shown) void this.load(this.ui.assetHash);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private async load(hash: string): Promise<void> {
    const mine = ++this.token;
    // A refetch of the same asset keeps what is half-typed; moving to another one does not.
    if (hash !== this.shown) {
      this.variant = '';
      this.promptDirty = false;
      this.editing.clear();
      this.customDraft = undefined;
      this.refocus = '';
    }
    this.shown = hash;
    this.dirty.clear();

    if (hash === '') {
      this.info = undefined;
      this.failure = '';
      this.rebuild();
      return;
    }

    const outcome = await exec('asset.info', { hash });
    if (mine !== this.token) return;

    if (outcome.ok) {
      this.info = outcome.data as AssetInfo;
      this.failure = '';
      if (!this.promptDirty) {
        const editable = promptEditable(this.info);
        this.draft = editable.ok ? editable.prompt : '';
        this.titleDraft = editable.ok ? editable.title : '';
      }
    } else {
      this.info = undefined;
      this.failure = outcome.error;
    }
    this.rebuild();
  }

  // -------------------------------------------------------------------------
  // Acting
  // -------------------------------------------------------------------------

  private async approve(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const action = approveAction(info);
    if (!action.ok) return void say(action.reason, true);

    const outcome = await exec(action.id, action.props);
    if (outcome.ok) say(outcome.record.message);
  }

  /**
   * Requeue the task behind these bytes and run it. `asset.regenerate` is `confirm: true` and
   * takes the run itself, so this is one act with one provenance record rather than two.
   */
  private async regenerate(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const outcome = await exec('asset.regenerate', { hash: info.hash, run: true });
    if (outcome.ok) say(outcome.record.message);
  }

  /**
   * Draw the concept again from whatever the box holds. `art.redraw` is `confirm: true`, so the
   * author is asked before the image call is spent; the result is a new sketch beside this one,
   * and the command's own `view.open` effect brings this pane to it.
   */
  private async redraw(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const action = promptEditable(info);
    if (!action.ok) return void say(action.reason, true);

    const prompt = this.draft.trim();
    if (prompt === '') return void say('A redraw needs a prompt — the box is empty.', true);

    const outcome = await exec('art.redraw', {
      hash: info.hash,
      prompt,
      title: this.titleDraft.trim(),
    });
    if (!outcome.ok) return;
    say(outcome.record.message);
    this.promptDirty = false;
  }

  /**
   * Make this concept the plate for a variant. The one act that moves an asset between kinds, so
   * the pane re-reads afterwards rather than editing what it drew: the badges, the rungs and the
   * prompt all change underneath it.
   */
  private async promote(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const action = promoteAction(info);
    if (!action.ok) return void say(action.reason, true);
    const variant = this.variant.trim();
    if (variant === '') return void say('Name the variant this becomes the plate for.', true);

    const outcome = await exec('art.promote', { hash: info.hash, variant });
    if (!outcome.ok) return;
    say(outcome.record.message);
    void this.load(this.shown);
  }

  /**
   * Put a file of the author's own in this picture's place. The slot is never typed: it is the
   * asset on screen, so `asset.replace` takes the hash and reads the slot off it.
   *
   * The bytes that come back have a different identity, so the pane moves to them rather than
   * re-reading the hash it was on — which after this is a superseded picture, not the slot's.
   */
  private async replace(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const action = replaceAction(info);
    if (!action.ok) return void say(action.reason, true);

    const outcome = await exec('asset.replace', { hash: info.hash });
    if (!outcome.ok) return;
    say(outcome.record.message);
    const next = (outcome.data as { hash?: string } | undefined)?.hash;
    if (next === undefined || next === this.shown) return void this.load(this.shown);
    this.ui.assetHash = next;
    this.announce();
  }

  /** Hand the task off to the inspector, which is the pane that reads attempts. */
  private showTask(): void {
    const task = this.info?.sourceTask ?? '';
    if (task === '') return void say('The manifest records no task for this asset.', true);
    this.ui.taskHash = task;
    this.announce();
    void exec('view.open', { editor: 'inspector', where: 'elsewhere' });
  }

  /**
   * Commit one rung. An empty box clears the note, which is what the command means by empty —
   * so a box the author blanked is a real edit, not a no-op.
   */
  private async commitRung(rung: ArtRungInfo, text: string, box: HTMLElement): Promise<void> {
    const next = text.trim();
    if (next === (rung.notes ?? '')) {
      this.dirty.delete(rung.target);
      box.classList.remove('dirty');
      return;
    }

    const outcome = await exec('art.setNotes', { target: rung.target, notes: next });
    this.dirty.delete(rung.target);
    if (!outcome.ok) return;

    say(outcome.record.message);
    box.classList.remove('dirty');
    // The edit changed the derivation, so everything on the pane below the image is now wrong.
    void this.load(this.shown);
  }

  /** Every prompt edit is one command, and the pane re-reads: a chunk edit moves the whole prompt. */
  private async runPrompt(id: string, props: Record<string, PropValue>): Promise<void> {
    const outcome = await exec(id, props);
    if (!outcome.ok) return;
    say(outcome.record.message);
    void this.load(this.shown);
  }

  /** Which clauses the prompt in force no longer appears to say. Reads; writes nothing. */
  private async runCheck(): Promise<void> {
    const outcome = await exec('prompt.check', { hash: this.shown });
    if (outcome.ok) {
      say(outcome.record.message);
      void this.load(this.shown);
    }
  }

  private async setChunk(chunk: string, op: string, text: string): Promise<void> {
    this.editing.delete(chunk);
    this.dirty.delete(`chunk:${chunk}`);
    this.refocus = chunk;
    await this.runPrompt('prompt.setChunk', { hash: this.shown, chunk, op, text });
  }

  /** Commit one clause box. An empty box is a refusal from the command, so it never reaches it. */
  private async commitChunk(
    chunk: string,
    how: 'replace' | 'append',
    text: string,
    card: HTMLElement,
  ): Promise<void> {
    const next = text.trim();
    this.dirty.delete(`chunk:${chunk}`);
    card.classList.remove('dirty');
    if (next === '') {
      this.editing.delete(chunk);
      this.rebuildBody();
      return void say('Nothing typed — use Reset to go back to the derived words.', true);
    }
    await this.setChunk(chunk, how, next);
  }

  private async commitCustom(text: string, box: HTMLElement): Promise<void> {
    this.dirty.delete('custom');
    box.classList.remove('dirty');
    this.customDraft = undefined;
    await this.runPrompt('prompt.setCustom', { hash: this.shown, text: text.trim() });
  }

  /** Put the caret in the box that was just opened, after the rebuild that drew it. */
  private focusBox(chunk: string): void {
    queueMicrotask(() => {
      const card = this.surface.querySelector(`.as-chunk[data-chunk="${chunk}"] .as-chunk-box`);
      if (card instanceof HTMLTextAreaElement) {
        card.focus();
        card.setSelectionRange(card.value.length, card.value.length);
      }
    });
  }

  /**
   * Follow a chunk to the words behind it. A publish must land **before** the open: the new pane
   * reads the selection on its first `update()`, so publishing after it shows the previous one.
   */
  private async openOrigin(action: OriginAction & { ok: true }): Promise<void> {
    if (action.kind === 'scroll') {
      const at = this.surface.querySelector(
        action.to === 'request' ? '[data-anchor="request"]' : `[data-rung="${action.to}"]`,
      );
      if (!at) return void say(`Nothing on this pane holds ${action.to}.`, true);
      at.scrollIntoView({ block: 'center' });
      const box = at.querySelector('textarea');
      if (box instanceof HTMLTextAreaElement) box.focus();
      return;
    }

    const ui = this.ui as unknown as Record<string, string>;
    for (const [field, value] of Object.entries(action.publish)) ui[field] = value;
    this.announce();
    await exec('view.open', {
      editor: action.editor,
      where: 'elsewhere',
      ...(action.subject ? { subject: action.subject } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Reordering
  // -------------------------------------------------------------------------

  /**
   * The grab: every insertion point judged **once**, from the same pure rule the command runs, so
   * a mid-gesture verdict is the verdict that would happen. Nothing moves until pointerup.
   */
  private grabChunk(view: PromptView, chunk: string, rail: HTMLElement, event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const state: PromptDragState = { hash: view.hash, chunks: view.chunks, mode: view.mode };
    const verdicts = promptReorder.targets(state, chunk);
    const refusal = verdicts.find((v) => v.target === UNRESOLVED);
    if (refusal && !refusal.accept) return void say(refusal.reason, true);

    this.drag = {
      chunk,
      verdicts: new Map(verdicts.map((v) => [v.target, v])),
      target: chunk,
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
    return [...this.surface.querySelectorAll('.as-chunk')].map((node) => {
      const box = node.getBoundingClientRect();
      return {
        key: (node as HTMLElement).dataset['chunk'] ?? '',
        top: box.top,
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
    const cards = [...this.surface.querySelectorAll('.as-chunk')] as HTMLElement[];
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
    if (!verdict.accept) return void say(verdict.reason, true);
    this.refocus = drag.chunk;
    await this.runPrompt(verdict.invoke.id, verdict.invoke.props);
  }

  /** `Alt+↑`/`Alt+↓`: the same command, through the same lookup, without the pointer. */
  private async nudge(view: PromptView, chunk: string, delta: number): Promise<void> {
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
    if (!verdict.accept) return void say(verdict.reason, true);
    this.refocus = chunk;
    await this.runPrompt(verdict.invoke.id, verdict.invoke.props);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private rebuild(): void {
    this.rebuildBar();
    this.rebuildBody();
  }

  private rebuildBar(): void {
    const info = this.info;
    const action = info ? approveAction(info) : undefined;

    this.bar.clear();
    this.bar.label('ASSET').style['padding'] = '0px 8px';

    // A concept is approved by nothing and planned by nothing, so neither button can ever act on
    // one; a greyed pair beside a working Redraw reads as breakage. The bar carries the act this
    // asset actually has, and the body carries the rest — the prompt box, its hint, and Promote.
    if (info?.kind === 'concept') {
      this.bar.button('Redraw', () => void this.redraw()).description =
        'Draw this sketch again from the prompt below, as a new one beside it';
    } else if (info?.kind === 'reference') {
      // An upload has neither act, for the opposite reason to a concept: nothing generated it, so
      // there is no work to bless and no task to requeue. It counts by being pointed at.
      this.bar.label('uploaded').style['padding'] = '0px 8px';
    } else {
      const approve = this.bar.button(
        action?.ok ? action.label : 'Approve',
        () => void this.approve(),
      );
      approve.disabled = !action?.ok;
      // A disabled button with no reason reads as a bug; `approveAction` wrote the sentence.
      approve.description = action?.ok
        ? 'Accept these bytes for use downstream'
        : (action?.reason ?? 'Nothing to approve');

      const regen = this.bar.button('Regenerate', () => void this.regenerate());
      regen.disabled = !info;
      regen.description = 'Requeue the task behind these bytes and run the pipeline';
    }

    const task = this.bar.button('Task', () => this.showTask());
    task.disabled = !info?.sourceTask;
    task.description = 'Show the task that produced this asset in the inspector';

    this.bar.button('⟳', () => void this.load(this.shown)).description =
      'Re-read this asset from the manifest';
    this.bar.flushUpdate();
  }

  private rebuildBody(): void {
    this.surface.textContent = '';

    if (this.failure) {
      this.surface.appendChild(el('div', 'as-empty', this.failure));
      return;
    }

    const info = this.info;
    if (!info) {
      this.surface.appendChild(
        el(
          'div',
          'as-empty',
          'No asset selected. Click one under Assets in the documents tree, or run view.open(editor=asset subject=<hash>).',
        ),
      );
      return;
    }

    this.surface.appendChild(this.head(info));
    this.surface.appendChild(this.frame(info));

    const promotable = promoteAction(info);
    if (promotable.ok) this.surface.appendChild(this.promoteStrip(promotable.locationId));

    // Mutually exclusive with the one above by construction: a concept fills no slot, and nothing
    // that fills one is a concept.
    const replaceable = replaceAction(info);
    if (replaceable.ok) this.surface.appendChild(this.replaceStrip(replaceable.slot));

    const drift = driftNote(info);
    if (drift) this.surface.appendChild(el('div', 'as-drift', drift));

    const editable = promptEditable(info);
    if (editable.ok) {
      this.surface.appendChild(el('div', 'as-section', 'PROMPT · AS AUTHORED'));
      this.surface.appendChild(this.promptStrip());
    }
    this.rebuildPrompt(info, editable.ok);

    this.surface.appendChild(el('div', 'as-section', 'ART NOTES'));
    if (info.rungs.length === 0) {
      this.surface.appendChild(
        el('div', 'as-hint', 'Nothing this asset was generated from is still in the project.'),
      );
      return;
    }
    for (const rung of info.rungs) this.surface.appendChild(this.rungBox(rung));
    this.surface.appendChild(
      el(
        'div',
        'as-hint',
        'Notes are appended to the prompt, widest rung first. Ctrl+S or leaving the box saves — and re-renders what that rung reaches on the next run.',
      ),
    );
  }

  /**
   * The prompt half: what would be sent, and the clauses it is made of. Every kind gets the cards —
   * the composition is the same object whether the author is editing it or reading it — but a
   * frozen one gets no controls, because there is no derivation underneath to do anything to.
   */
  private rebuildPrompt(info: AssetInfo, authored: boolean): void {
    const view = info.promptView;
    this.dragNote = undefined;

    if (!view) {
      const prompt = promptShown(info);
      this.surface.appendChild(
        el(
          'div',
          'as-section',
          prompt.derived ? 'PROMPT · AS DERIVED TODAY' : 'PROMPT · AS RECORDED',
        ),
      );
      this.surface.appendChild(
        el('div', 'as-prompt', prompt.text || 'The project no longer describes this asset.'),
      );
      return;
    }

    if (view.frozen) {
      // A concept's prompt is the box above; anything else frozen has only what the bytes recorded.
      if (!authored) {
        this.surface.appendChild(el('div', 'as-section', 'PROMPT · AS RECORDED'));
        this.surface.appendChild(el('div', 'as-prompt', view.text || 'No prompt was recorded.'));
      }
      this.surface.appendChild(el('div', 'as-hint', view.frozen));
      if (view.chunks.length > 0) this.surface.appendChild(this.chunkList(view));
      return;
    }

    this.surface.appendChild(el('div', 'as-section', 'PROMPT'));
    this.surface.appendChild(this.modeRow(view));
    this.surface.appendChild(el('div', 'as-prompt', view.text || 'This prompt says nothing.'));
    if (view.held) this.surface.appendChild(this.heldBanner(view));
    if (view.mode === 'custom') this.surface.appendChild(this.customBox(view));
    this.surface.appendChild(this.chunkList(view));

    // The footer the drag speaks through: the verdict for the insertion point under the pointer.
    this.dragNote = el('div', 'as-note');
    this.surface.appendChild(this.dragNote);
    this.surface.appendChild(
      el(
        'div',
        'as-hint',
        view.mode === 'chunks'
          ? 'Drag a rail to reorder a clause, or Alt+↑/↓ on a card. Every edit here re-renders what this rung reaches.'
          : 'The prompt above is what gets sent; the clauses below are what it was written from, and ✗ marks one it no longer appears to say.',
      ),
    );
  }

  /** `Chunks` / `Custom` / `Agent`, plus the two acts. Nothing here sets a mode field. */
  private modeRow(view: PromptView): HTMLElement {
    const row = el('div', 'as-modes');
    for (const seg of modeStrip(view)) {
      const b = button(`as-mode${seg.active ? ' on' : ''}`, seg.label);
      if (seg.action.ok) {
        const { id, props } = seg.action;
        b.title = `Run ${id}`;
        b.addEventListener('click', () => void this.runPrompt(id, props));
      } else {
        b.disabled = true;
        b.title = seg.action.reason;
      }
      row.appendChild(b);
    }

    const condense = condenseAction(view);
    const act = button('as-mode act', condense.ok ? condense.label : 'Condense…');
    if (condense.ok) {
      act.title = condense.note;
      act.addEventListener('click', () => void this.runPrompt(condense.id, condense.props));
    } else {
      act.disabled = true;
      act.title = condense.reason;
    }
    row.appendChild(act);

    const check = button('as-mode', 'Check');
    check.title = 'Which clauses the prompt above no longer appears to say';
    check.addEventListener('click', () => void this.runCheck());
    row.appendChild(check);
    return row;
  }

  /** The condensation and the chunks have parted company, and the condensation is still what runs. */
  private heldBanner(view: PromptView): HTMLElement {
    const banner = el('div', 'as-held', heldNote(view));
    const action = condenseAction(view);
    if (action.ok) {
      const b = button('as-mode', action.label);
      b.title = action.note;
      b.addEventListener('click', () => void this.runPrompt(action.id, action.props));
      banner.appendChild(b);
    }
    return banner;
  }

  private chunkList(view: PromptView): HTMLElement {
    const list = el('div', `as-chunks${view.mode === 'chunks' ? '' : ' aside'}`);
    for (const chunk of view.chunks) list.appendChild(this.chunkCard(view, chunk));
    return list;
  }

  private chunkCard(view: PromptView, chunk: PromptChunkInfo): HTMLElement {
    const classes = ['as-chunk', chunkVoice(chunk), `tex-${chunkTexture(chunk)}`];
    if (chunk.muted) classes.push('muted');
    if (chunk.edit) classes.push('edited');

    const card = el('div', classes.join(' '));
    card.dataset['chunk'] = chunk.key;
    card.tabIndex = 0;

    const rail = el('div', 'as-chunk-rail');
    if (!view.frozen) {
      rail.title = 'Drag to say this clause somewhere else in the prompt';
      rail.addEventListener('pointerdown', (event) =>
        this.grabChunk(view, chunk.key, rail, event as PointerEvent),
      );
      card.addEventListener('keydown', (event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        event.stopPropagation();
        void this.nudge(view, chunk.key, event.key === 'ArrowUp' ? -1 : 1);
      });
    }
    card.appendChild(rail);

    const main = el('div', 'as-chunk-main');
    main.appendChild(this.chunkTags(view, chunk));

    if (chunk.edit === 'append') {
      main.appendChild(el('div', 'as-chunk-text', chunk.derived));
      main.appendChild(el('div', 'as-chunk-text', `+ ${chunk.authored ?? ''}`));
    } else {
      main.appendChild(el('div', 'as-chunk-text', chunk.text));
      if (chunk.edit === 'replace') main.appendChild(el('div', 'as-chunk-was', chunk.derived));
    }

    const strip = refStrip(chunk);
    if (strip.length) main.appendChild(this.refStripEl(view, chunk, strip));

    if (!view.frozen) {
      main.appendChild(this.chunkActs(chunk, card));
      const how = this.editing.get(chunk.key);
      if (how) main.appendChild(this.chunkBox(chunk, how, card));
    }

    card.appendChild(main);
    if (this.refocus === chunk.key) {
      this.refocus = '';
      queueMicrotask(() => card.focus());
    }
    return card;
  }

  /**
   * The reference images attached to one clause. A click opens the picture in another pane — the
   * same route the document tree takes — and `×` detaches it. Detaching re-keys the task, so it is
   * a command like every other edit here and the pane re-reads.
   */
  private refStripEl(view: PromptView, chunk: PromptChunkInfo, chips: RefChip[]): HTMLElement {
    const strip = el('div', 'as-chunk-refs');
    for (const chip of chips) {
      const classes = ['as-ref', chip.muted ? 'muted' : '', chip.drift ? 'drift' : ''];
      const item = el('div', classes.filter(Boolean).join(' '));
      item.title = chip.title;

      const thumb = document.createElement('img');
      thumb.src = `vnasset://${chip.pin}.${chip.ext}`;
      thumb.alt = chip.label;
      thumb.draggable = false;
      // Elsewhere, always: this pane is showing the picture the reference is *for*.
      thumb.addEventListener(
        'click',
        () => void exec('view.open', { editor: 'asset', where: 'elsewhere', subject: chip.pin }),
      );
      item.appendChild(thumb);
      item.appendChild(el('span', 'as-ref-name', chip.label));

      if (!view.frozen) {
        const drop = button('as-ref-drop', '×');
        drop.title = `Stop sending ${chip.label} with this clause`;
        drop.addEventListener(
          'click',
          () =>
            void this.runPrompt('prompt.dropRef', {
              hash: view.hash,
              chunk: chunk.key,
              ref: chip.pin,
            }),
        );
        item.appendChild(drop);
      }
      strip.appendChild(item);
    }
    return strip;
  }

  private chunkTags(view: PromptView, chunk: PromptChunkInfo): HTMLElement {
    const tags = el('div', 'as-chunk-tags');
    tags.appendChild(el('span', 'as-chunk-tag', chunkTag(chunk)));
    tags.appendChild(el('span', 'as-chunk-addr', chunkAddress(chunk.origin)));

    const origin = originAction(chunk.origin);
    if (origin.ok) {
      const open = button('as-chunk-open', '⇱');
      open.title = origin.label;
      open.addEventListener('click', () => void this.openOrigin(origin));
      tags.appendChild(open);
    }

    const mark = coverageMark(view, chunk);
    if (mark) {
      const span = el('span', `as-chunk-mark${mark.found ? '' : ' bad'}`, mark.mark);
      span.title = mark.title;
      tags.appendChild(span);
    }

    if (chunk.editStale) {
      const stale = el('span', 'as-chunk-stale', '· written against older words');
      stale.title = 'The clause underneath has changed since this edit was made.';
      tags.appendChild(stale);
    }
    return tags;
  }

  /**
   * The four acts on one clause. `Reset` is also how a mute comes off — `prompt.setChunk(op=clear)`
   * discards everything done to the chunk, which is one act to explain rather than two.
   */
  private chunkActs(chunk: PromptChunkInfo, card: HTMLElement): HTMLElement {
    const acts = el('div', 'as-chunk-acts');

    const mute = button('as-chunk-act', 'Mute');
    mute.disabled = chunk.muted;
    mute.title = chunk.muted ? 'Already muted.' : 'Leave this clause out of the prompt';
    mute.addEventListener('click', () => void this.setChunk(chunk.key, 'mute', ''));
    acts.appendChild(mute);

    for (const how of ['replace', 'append'] as const) {
      const open = button('as-chunk-act', how === 'replace' ? 'Replace…' : 'Append…');
      open.title =
        how === 'replace'
          ? 'Say this clause in your own words'
          : 'Add to what the builders derived, keeping it';
      open.addEventListener('click', () => {
        this.editing.set(chunk.key, how);
        this.rebuildBody();
        this.focusBox(chunk.key);
      });
      acts.appendChild(open);
    }

    const reset = button('as-chunk-act', 'Reset');
    reset.disabled = !chunk.muted && !chunk.edit;
    reset.title = reset.disabled
      ? 'Nothing has been done to this clause.'
      : 'Go back to the words the builders derived';
    reset.addEventListener('click', () => void this.setChunk(chunk.key, 'clear', ''));
    acts.appendChild(reset);

    // The card carries the dirty mark, so the box below can be built and rebuilt without it.
    card.classList.toggle('dirty', this.dirty.has(`chunk:${chunk.key}`));
    return acts;
  }

  /** The inline box for one clause. Commits on Ctrl+S or blur, exactly like `rungBox`. */
  private chunkBox(
    chunk: PromptChunkInfo,
    how: 'replace' | 'append',
    card: HTMLElement,
  ): HTMLElement {
    const key = `chunk:${chunk.key}`;
    const text = document.createElement('textarea');
    text.className = 'as-chunk-box';
    text.spellcheck = false;
    text.setAttribute('aria-label', `${how} the ${chunk.key} clause`);
    text.placeholder =
      how === 'replace' ? 'the words to send instead' : 'the words to add after it';
    // Replacing starts from what is being replaced, so an edit to one phrase keeps the rest.
    text.value = chunk.edit === how ? (chunk.authored ?? '') : how === 'replace' ? chunk.text : '';
    text.addEventListener('input', () => {
      this.dirty.add(key);
      card.classList.add('dirty');
    });
    // The screen keymap is a bubble-phase window listener, so the box stops its own keys.
    text.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.commitChunk(chunk.key, how, text.value, card);
      }
      if (event.key === 'Escape') {
        this.dirty.delete(key);
        this.editing.delete(chunk.key);
        this.rebuildBody();
      }
    });
    text.addEventListener('blur', () => {
      if (this.dirty.has(key)) void this.commitChunk(chunk.key, how, text.value, card);
    });
    return text;
  }

  /** The whole prompt, written by hand. Same commit gesture as every other box on the pane. */
  private customBox(view: PromptView): HTMLElement {
    const box = el('div', 'as-custom');
    const text = document.createElement('textarea');
    text.spellcheck = false;
    text.setAttribute('aria-label', 'The prompt this asset is generated from');
    text.value = this.customDraft ?? view.custom ?? view.text;
    text.addEventListener('input', () => {
      this.customDraft = text.value;
      this.dirty.add('custom');
      box.classList.add('dirty');
    });
    text.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.commitCustom(text.value, box);
      }
    });
    text.addEventListener('blur', () => {
      if (this.dirty.has('custom')) void this.commitCustom(text.value, box);
    });
    box.appendChild(text);

    const row = el('div', 'as-custom-row');
    const save = button('as-mode', 'Save');
    save.title = 'Send this prompt instead of the clauses below';
    save.addEventListener('click', () => void this.commitCustom(text.value, box));
    row.appendChild(save);
    row.appendChild(
      el('div', 'as-hint', 'Ctrl+S or leaving the box saves. Chunks goes back to the derivation.'),
    );
    box.appendChild(row);
    return box;
  }

  private head(info: AssetInfo): HTMLElement {
    const head = el('div', 'as-head');
    head.appendChild(el('div', 'as-label', info.label));

    const badges = el('div', 'as-badges');
    for (const badge of badgesOf(info)) {
      badges.appendChild(el('span', `as-badge ${badge}`, badge));
    }
    head.appendChild(badges);

    // The full hash, not the short one: this is the pane you copy an identity out of.
    head.appendChild(el('div', 'as-hash', `${info.hash}.${info.ext}`));
    return head;
  }

  private frame(info: AssetInfo): HTMLElement {
    const frame = el('div', 'as-frame');
    const img = document.createElement('img');
    img.src = `vnasset://${info.hash}.${info.ext}`;
    img.alt = info.label;
    img.draggable = false;
    frame.appendChild(img);
    return frame;
  }

  /**
   * The concept's one offer: name a variant and this becomes that plate. Kept beside the image
   * rather than in the header bar because it needs a field, and because it is the only thing on
   * the pane that changes what the asset *is*.
   */
  private promoteStrip(locationId: string): HTMLElement {
    const strip = el('div', 'as-promote');
    strip.appendChild(el('span', 'as-promote-what', `Promote to a plate for ${locationId}:`));

    const input = document.createElement('input');
    input.className = 'as-promote-id';
    input.setAttribute('aria-label', 'The variant id this becomes the plate for');
    input.placeholder = 'variant id, e.g. dawn';
    input.value = this.variant;
    input.addEventListener('input', () => (this.variant = input.value));
    // The screen keymap is a bubble-phase window listener, so the field stops its own keys.
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') void this.promote();
    });
    strip.appendChild(input);

    const go = el('button', 'as-promote-go', 'Promote');
    go.addEventListener('click', () => void this.promote());
    strip.appendChild(go);

    strip.appendChild(
      el(
        'div',
        'as-hint',
        'The variant joins the location sheet if it is new, and the next run adopts this picture instead of rendering its own.',
      ),
    );
    return strip;
  }

  /**
   * The offer every planned picture has: hand in a file and let it be this one. An author who paid
   * for a cleanup has bytes better than anything a run will produce, and the strip says what that
   * costs — the render it stands in for stays in the store, and the next run adopts rather than
   * draws. The slot is shown rather than asked for: it is the picture on screen.
   */
  private replaceStrip(slot: string): HTMLElement {
    const strip = el('div', 'as-replace');
    const go = el('button', 'as-replace-go', 'Replace with a file…');
    go.addEventListener('click', () => void this.replace());
    strip.appendChild(go);
    strip.appendChild(el('span', 'as-replace-what', slot));
    strip.appendChild(
      el(
        'div',
        'as-hint',
        'A chooser opens first. What you choose supersedes this picture — its bytes stay in the store — and the next run adopts yours instead of rendering one.',
      ),
    );
    return strip;
  }

  /**
   * The one editable prompt in the app. Prefilled whole rather than blank: the generator wrapped
   * the author's sentence in a style preamble and a framing line, and an author editing "at dawn"
   * to "at dusk" should keep both without knowing they are there.
   */
  private promptStrip(): HTMLElement {
    const strip = el('div', 'as-redraw');
    // What a `request` chunk's `⇱` scrolls to: the box those words came out of.
    strip.dataset['anchor'] = 'request';

    const text = document.createElement('textarea');
    text.className = 'as-redraw-prompt';
    text.value = this.draft;
    text.spellcheck = false;
    text.setAttribute('aria-label', 'The prompt this concept is drawn from');
    text.addEventListener('input', () => {
      this.draft = text.value;
      this.promptDirty = true;
      strip.classList.add('dirty');
    });
    // The screen keymap is a bubble-phase window listener, so the box stops its own keys.
    text.addEventListener('keydown', (event) => event.stopPropagation());
    strip.appendChild(text);

    const row = el('div', 'as-redraw-row');
    const name = document.createElement('input');
    name.className = 'as-redraw-title';
    name.value = this.titleDraft;
    name.placeholder = 'name for this sketch';
    name.setAttribute('aria-label', 'What to call this sketch');
    name.addEventListener('input', () => (this.titleDraft = name.value));
    name.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') void this.redraw();
    });
    row.appendChild(name);

    const go = el('button', 'as-redraw-go', 'Redraw');
    go.addEventListener('click', () => void this.redraw());
    row.appendChild(go);
    strip.appendChild(row);

    strip.appendChild(
      el(
        'div',
        'as-hint',
        'Nothing derives a concept, so this prompt is yours to edit. Redraw spends one image call and files the result as a new sketch — this one stays where it is.',
      ),
    );
    return strip;
  }

  private rungBox(rung: ArtRungInfo): HTMLElement {
    const box = el('div', 'as-rung');
    // What an `art-notes` chunk's `⇱` scrolls to: the box those words came out of.
    box.dataset['rung'] = rung.target;

    const head = el('div', 'as-rung-head');
    head.appendChild(el('span', 'as-rung-label', rung.label));
    head.appendChild(el('span', 'as-rung-target', rung.target));
    box.appendChild(head);

    const text = document.createElement('textarea');
    text.value = rung.notes ?? '';
    text.spellcheck = false;
    text.placeholder = 'e.g. sodium streetlight raking across the formwork';
    text.addEventListener('input', () => {
      this.dirty.add(rung.target);
      box.classList.add('dirty');
    });
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys opens the palette on the first `/` of a sentence.
    text.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.commitRung(rung, text.value, box);
      }
    });
    text.addEventListener('blur', () => {
      if (this.dirty.has(rung.target)) void this.commitRung(rung, text.value, box);
    });
    box.appendChild(text);
    return box;
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A real `<button>`, because half of these are disabled and carry their refusal as the tooltip. */
function button(className: string, text: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.className = className;
  node.textContent = text;
  return node;
}

registerEditor(AssetEditor, 'vn.AssetEditor');
