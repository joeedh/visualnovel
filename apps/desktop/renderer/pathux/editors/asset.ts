import type { Container } from 'pathux';
import { UNRESOLVED, type Verdict } from '@vn/commands';
import { exec, notify, onInvalidate, report } from '../bridge.js';
import type { VnContext } from '../context.js';
import { menuFor } from '../doctree.js';
import { assetNode } from '../open.js';
import { openCommandDialog } from '../dialog.js';
import { showContextMenu } from '../showmenu.js';
import {
  approveAction,
  badgesOf,
  driftNote,
  failureNote,
  promoteAction,
  promptEditable,
  promptShown,
  regenerateAction,
  replaceAction,
  watchSlot,
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
import type {
  AssetFailure,
  AssetInfo,
  ArtRungInfo,
  Prereq,
  PropValue,
} from '../../../src/shared/ipc.js';
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
 * The prompt is read-only for every kind but one. A derived prompt is folded into the task's
 * content hash and rewritten on every planning pass, so an editable one would freeze the asset
 * against every later improvement to the builders. The boxes underneath are its editable half:
 * art notes are authored input, appended to the derivation, and setting one re-keys the task, so
 * regenerating is `pipeline.run` and nothing more. A concept has no builder — its prompt is the
 * sentence it was asked for, so the box holds it and `art.redraw` draws it again.
 */
export class AssetEditor extends VnEditor {
  private bar!: Container;
  private surface!: HTMLDivElement;

  private info: AssetInfo | undefined;
  /** True while the shown asset is the one filling its slot, so a later render is one to follow. */
  private holding = false;
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
  /** One hop of history, so walking up DRAWN FROM is reversible: where from, and back to what. */
  private back = '';
  private backFor = '';

  static override define() {
    return {
      tagname: 'vn-asset-editor-x',
      areaname: 'asset',
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

    // Any write could have been the art-notes edit this pane just ran, or an undo of one. The
    // derived prompt and the drift flag are re-derived on read in both cases, so the pane asks
    // again rather than patching what it drew.
    const reload = (): void => {
      if (this.shown !== '' && this.dirty.size === 0 && !this.promptDirty)
        void this.load(this.shown);
    };
    this.watch(() => onInvalidate(reload), reload);

    this.rebuild();
    void this.load(this.ui.assetHash);
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
      const was = this.info;
      this.info = outcome.data as AssetInfo;
      const watch = watchSlot(was, this.info, this.holding);
      this.holding = watch.holding;
      // A pinned pane holds what it was pinned to, which is the whole point of the pin.
      if (watch.follow !== '' && !this.pinned) {
        this.ui.assetHash = watch.follow;
        this.announce();
        return;
      }
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

  /**
   * A complaint this pane raised on its own — a refusal from a rule module, or a box left empty.
   * Filed rather than merely shown, because it is an event about an asset like the commands
   * around it. Main pushes the notification back, and that push is what displays it.
   */
  private complain(message: string): void {
    notify({ category: 'asset', level: 'warn', message });
  }

  private async approve(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const action = approveAction(info);
    if (!action.ok) return this.complain(action.reason);

    report(await exec(action.id, action.props));
  }

  /**
   * Requeue the task behind these bytes and run it. `asset.regenerate` is `confirm: true` and
   * takes the run itself, so this is one act with one provenance record rather than two.
   *
   * An asset the project has moved past has no task of its own left to re-run, and the command
   * refuses one. The button offers the run that would draw it instead, as `pipeline.run`'s own
   * dialog, so what the author confirms is the work and its cost rather than a refusal.
   */
  private async regenerate(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const action = regenerateAction(info);
    if (action.act === 'pipeline') {
      openCommandDialog('pipeline.run', { mock: false }, undefined, action.note);
      return;
    }
    report(await exec('asset.regenerate', { hash: info.hash, run: true }));
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
    if (!action.ok) return this.complain(action.reason);

    const prompt = this.draft.trim();
    if (prompt === '') return this.complain('A redraw needs a prompt — the box is empty.');

    const outcome = await exec('art.redraw', {
      hash: info.hash,
      prompt,
      title: this.titleDraft.trim(),
    });
    report(outcome);
    if (!outcome.ok) return;
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
    if (!action.ok) return this.complain(action.reason);
    const variant = this.variant.trim();
    if (variant === '') return this.complain('Name the variant this becomes the plate for.');

    const outcome = await exec('art.promote', { hash: info.hash, variant });
    report(outcome);
    if (!outcome.ok) return;
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
    if (!action.ok) return this.complain(action.reason);

    const outcome = await exec('asset.replace', { hash: info.hash });
    report(outcome);
    if (!outcome.ok) return;
    const next = (outcome.data as { hash?: string } | undefined)?.hash;
    if (next === undefined || next === this.shown) return void this.load(this.shown);
    this.ui.assetHash = next;
    this.announce();
  }

  /** Hand the task off to the inspector, which is the pane that reads attempts. */
  private showTask(hash?: string): void {
    const task = hash ?? this.info?.sourceTask ?? '';
    if (task === '') return this.complain('The manifest records no task for this asset.');
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
    report(outcome);
    if (!outcome.ok) return;

    box.classList.remove('dirty');
    // The edit changed the derivation, so everything on the pane below the image is now wrong.
    void this.load(this.shown);
  }

  /** Every prompt edit is one command, and the pane re-reads, since one clause moves the whole prompt. */
  private async runPrompt(id: string, props: Record<string, PropValue>): Promise<void> {
    const outcome = await exec(id, props);
    report(outcome);
    if (!outcome.ok) return;
    void this.load(this.shown);
  }

  /** Which clauses the prompt in force no longer appears to say. Reads; writes nothing. */
  private async runCheck(): Promise<void> {
    const outcome = await exec('prompt.check', { hash: this.shown });
    report(outcome);
    if (outcome.ok) void this.load(this.shown);
  }

  private async setChunk(chunk: string, op: string, text: string): Promise<void> {
    this.editing.delete(chunk);
    this.dirty.delete(`chunk:${chunk}`);
    this.refocus = chunk;
    await this.runPrompt('prompt.setChunk', { hash: this.shown, chunk, op, text });
  }

  /** Commit one clause box. The command refuses empty text, so an empty box is never sent to it. */
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
      return this.complain('Nothing typed — use Reset to go back to the derived words.');
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
   * Follow a chunk to the words behind it. A publish must land before the open: the new pane
   * reads the selection on its first `update()`, so publishing after it shows the previous one.
   */
  private async openOrigin(action: OriginAction & { ok: true }): Promise<void> {
    if (action.kind === 'scroll') {
      const at = this.surface.querySelector(
        action.to === 'request' ? '[data-anchor="request"]' : `[data-rung="${action.to}"]`,
      );
      if (!at) return this.complain(`Nothing on this pane holds ${action.to}.`);
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
   * Judge every insertion point once on the grab, from the same pure rule the command runs, so a
   * mid-gesture verdict matches the verdict that would apply on commit. Nothing moves until
   * pointerup.
   */
  private grabChunk(view: PromptView, chunk: string, rail: HTMLElement, event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const state: PromptDragState = { hash: view.hash, chunks: view.chunks, mode: view.mode };
    const verdicts = promptReorder.targets(state, chunk);
    const refusal = verdicts.find((v) => v.target === UNRESOLVED);
    if (refusal && !refusal.accept) return this.complain(refusal.reason);

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
    if (!verdict.accept) return this.complain(verdict.reason);
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
    if (!verdict.accept) return this.complain(verdict.reason);
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
    this.pinToggle(this.bar);

    // A concept is approved by nothing and planned by nothing, so neither button can ever act on
    // one; a greyed pair beside a working Redraw reads as breakage. The bar carries the act this
    // asset actually has, and the body carries the rest — the prompt box, its hint, and Promote.
    if (info?.kind === 'concept') {
      this.bar.button('Redraw', () => void this.redraw()).description =
        'Draw this sketch again from the prompt below, as a new one beside it';
    } else if (info?.kind === 'reference') {
      // An upload has neither act, because nothing generated it: there is no output to approve
      // and no task to requeue. It takes part by being pointed at from a prompt clause
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
      // Two different acts under one label, so the tooltip is the only place the author can find
      // out which one this click is before making it.
      regen.description = info
        ? regenerateAction(info).hint
        : 'Requeue the task behind these bytes and run the pipeline';
    }

    const task = this.bar.button('Task', () => this.showTask());
    task.disabled = !info?.sourceTask;
    task.description = 'Show the task that produced this asset in the inspector';

    // The same entries the tree's right-click offers, raised from the pane already showing the
    // asset — which is also the check that `menuFor` is node-shaped rather than tree-shaped. The
    // slot travels with the node, or the entries that need one would be missing here alone.
    const node = { ...assetNode(this.shown), ...(info?.slot ? { slot: info.slot } : {}) };
    const acts = this.bar.button('⋯', () => {
      const box = acts.getBoundingClientRect();
      void showContextMenu(
        this.ctx as VnContext,
        box.left,
        box.bottom,
        info?.hash ?? '',
        menuFor(node),
      );
    });
    acts.disabled = !info;
    acts.description = 'Everything this asset can be told to do';

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
    // Drawn only when there are rows, since an empty strip on every portrait would add nothing,
    // and `unapproved` is only ever set when one of these rows is pending.
    if (info.prereqs.length > 0) this.surface.appendChild(this.drawnFrom(info));

    const promotable = promoteAction(info);
    if (promotable.ok) this.surface.appendChild(this.promoteStrip(promotable.locationId));

    // Mutually exclusive with the promote strip by construction: a concept fills no slot, and
    // nothing that fills a slot is a concept.
    const replaceable = replaceAction(info);
    if (replaceable.ok) this.surface.appendChild(this.replaceStrip(replaceable.slot));

    // Ahead of the drift band: a failure says the picture is not there, which outranks a note
    // saying the picture no longer matches the words.
    if (info.failure) this.surface.appendChild(this.failureBand(info, info.failure));

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
        'Notes are appended to the prompt, widest rung first; the seed beside each is what that rung is drawn with, and an empty one inherits. Ctrl+S or leaving a box saves — and re-renders what that rung reaches on the next run.',
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
      // Anything frozen that is not authored has only what the bytes recorded; a concept's prompt
      // is already in the box above.
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

    // The footer a drag writes into, holding the verdict for the insertion point under the pointer
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

  /** Shown when the condensation no longer matches the chunks; the condensation is still what runs. */
  /**
   * What the pipeline recorded when it gave up, plus the way into the task that recorded it. The
   * button names its own task rather than the asset's, because a failed re-render is a different
   * task from the one these bytes came from and the inspector is where its attempts are readable.
   */
  private failureBand(info: AssetInfo, failure: AssetFailure): HTMLElement {
    const band = el('div', 'as-failed', failureNote(info));
    const b = button('as-mode', 'Show task');
    b.title =
      failure.task === info.sourceTask
        ? 'Open this task in the inspector, where its attempts are listed'
        : 'Open the task that gave up in the inspector — a re-render, not the one these bytes came from';
    b.addEventListener('click', () => this.showTask(failure.task));
    band.appendChild(b);

    // On the band rather than in the bar: the offer only exists while there is a failure to read,
    // and this is where the author is reading it.
    const fix = button('as-mode', 'Fix with agent');
    fix.title =
      'Open a conversation about this failure, with what it said already in the composer. Nothing is sent';
    fix.addEventListener('click', () => void this.fixWithAgent(info.hash));
    band.appendChild(fix);
    return band;
  }

  /**
   * Hand the failure to the agent. The command opens the conversation and fills the composer; the
   * turn is the author's to send, and no picture is redrawn by any of it.
   */
  private async fixWithAgent(hash: string): Promise<void> {
    report(await exec('agent.fixAsset', { hash }));
  }

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
      // Opens elsewhere because this pane is showing the picture the reference belongs to
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
    text.title = 'Say the whole prompt yourself. Ctrl+S or leaving the box saves it.';
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
   * The approval frontier, under the picture it belongs to: everything these bytes were drawn
   * from, in the order the task fed them to the model, each saying whether it stands.
   *
   * This is deliberately not the reference strip. That strip lists the detachable bytes pinned to
   * a single prompt clause, and a click there opens the picture in another pane because it is a
   * second thing to look at. This strip lists what the whole picture rests on. Nothing here
   * detaches, and a click retargets this pane, because the job is to walk up the chain approving
   * as you go and a new pane per hop litters the mesh. One `← back` chip makes that walk
   * reversible without keeping a longer history.
   */
  private drawnFrom(info: AssetInfo): HTMLElement {
    const strip = el('div', 'as-from');

    const head = el('div', 'as-from-head');
    const title = el('span', 'as-section', 'DRAWN FROM');
    title.title =
      'The pictures this one was drawn from. Each has to be approved before this one can be.';
    head.appendChild(title);

    // The chip clears itself: changing the subject some other way leaves `backFor` naming a
    // picture no longer on screen, so the chip is offered only on the hop it can undo.
    if (this.back !== '' && this.backFor === info.hash) {
      const back = button('as-from-back', '← back');
      back.title = 'Back to the picture you came here from';
      back.addEventListener('click', () => this.showPrereq(this.back, ''));
      head.appendChild(back);
    }
    strip.appendChild(head);

    for (const p of info.prereqs) strip.appendChild(this.prereqRow(info, p));
    // The same sentence the greyed Approve carries, shown here so an author reading the list can
    // see which row is holding approval up without hovering a disabled button.
    if (info.unapproved) strip.appendChild(el('div', 'as-from-note', info.unapproved));
    return strip;
  }

  /** One prerequisite. Disabled when the manifest has no such bytes, and the tooltip then says why. */
  private prereqRow(info: AssetInfo, p: Prereq): HTMLElement {
    const row = button(`as-from-row${p.approved ? ' ok' : ''}`, '');
    row.appendChild(el('span', 'as-from-mark', p.approved ? '✓' : '·'));
    row.appendChild(el('span', 'as-from-name', p.label));
    if (p.slot) row.appendChild(el('span', 'as-from-slot', p.slot));

    if (p.missing) {
      row.disabled = true;
      row.title = p.note;
      return row;
    }
    row.title = `${p.note} Click to open ${p.label} in this pane.`;
    row.addEventListener('click', () => this.showPrereq(p.hash, info.hash));
    return row;
  }

  /** Retarget this pane, remembering the one hop back. `from` empty means the chip was the click. */
  private showPrereq(hash: string, from: string): void {
    if (hash === '' || hash === this.shown) return;
    this.back = from === '' ? '' : this.shown;
    this.backFor = from === '' ? '' : hash;
    this.ui.assetHash = hash;
    this.announce();
  }

  /**
   * The concept's one offer: name a variant and this becomes that plate. Kept beside the image
   * rather than in the header bar because it needs a field, and because it is the only control on
   * the pane that changes which kind the asset is.
   */
  private promoteStrip(locationId: string): HTMLElement {
    const strip = el('div', 'as-promote');
    strip.appendChild(el('span', 'as-promote-what', `Promote to a plate for ${locationId}:`));

    const input = document.createElement('input');
    input.className = 'as-promote-id';
    input.setAttribute('aria-label', 'The variant id this becomes the plate for');
    input.title = 'Which variant of the location these bytes become the plate for';
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
    go.title = 'Make this sketch the plate for that variant, so the next run adopts it';
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
    go.title = `Choose a file and let it stand in for ${slot} from now on`;
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
    // The `⇱` on a `request` chunk scrolls here, to the box those words came out of
    strip.dataset['anchor'] = 'request';

    const text = document.createElement('textarea');
    text.className = 'as-redraw-prompt';
    text.value = this.draft;
    text.spellcheck = false;
    text.setAttribute('aria-label', 'The prompt this concept is drawn from');
    text.title = 'Edit the words this sketch is drawn from. Redraw sends them.';
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
    name.title = 'Name the sketch Redraw files. Enter draws it.';
    name.addEventListener('input', () => (this.titleDraft = name.value));
    name.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') void this.redraw();
    });
    row.appendChild(name);

    const go = el('button', 'as-redraw-go', 'Redraw');
    go.title = 'Spend one image call on this prompt and file the result as a new sketch';
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
    // The `⇱` on an `art-notes` chunk scrolls here, to the box those words came out of
    box.dataset['rung'] = rung.target;

    const head = el('div', 'as-rung-head');
    head.appendChild(el('span', 'as-rung-label', rung.label));
    head.appendChild(el('span', 'as-rung-target', rung.target));
    head.appendChild(this.seedField(rung));
    box.appendChild(head);

    const text = document.createElement('textarea');
    text.value = rung.notes ?? '';
    text.spellcheck = false;
    text.title = `Say how ${rung.label} should look. Appended to the prompt, so saving re-renders what this rung reaches on the next run.`;
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

  /**
   * The seed box that sits in a rung's heading. Narrow, and beside the notes rather than under
   * them, because it is not art direction: it asks for a different picture of the same words.
   *
   * An empty box is the only way to say "inherit", since 0 is a seed like any other. The
   * placeholder shows the seed that would be used instead, and the tooltip says where it comes
   * from.
   */
  private seedField(rung: ArtRungInfo): HTMLElement {
    const inherited = this.info?.configSeed;
    const field = document.createElement('input');
    field.type = 'number';
    field.min = '0';
    field.step = '1';
    field.className = 'as-rung-seed';
    field.value = rung.seed === undefined ? '' : String(rung.seed);
    field.placeholder = inherited === undefined ? 'seed' : String(inherited);
    field.setAttribute('aria-label', `Image seed for ${rung.label}`);
    field.title =
      `Draw ${rung.label} from this seed instead. Saving re-renders what this rung reaches on ` +
      'the next run — same words, different picture. Empty inherits ' +
      (inherited === undefined ? 'the wider rung, then the model’s own choice.' : `${inherited}.`);

    const key = `seed:${rung.target}`;
    field.addEventListener('input', () => {
      this.dirty.add(key);
      field.classList.add('dirty');
    });
    field.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        void this.commitSeed(rung, field.value, field);
      }
    });
    field.addEventListener('blur', () => {
      if (this.dirty.has(key)) void this.commitSeed(rung, field.value, field);
    });
    return field;
  }

  /** Commit one rung's seed. An empty box clears it, which is the rung inheriting again. */
  private async commitSeed(rung: ArtRungInfo, text: string, field: HTMLElement): Promise<void> {
    const key = `seed:${rung.target}`;
    const typed = text.trim();
    const seed = typed === '' ? -1 : Number(typed);
    if (typed !== '' && (!Number.isInteger(seed) || seed < 0)) {
      return this.complain('A seed is a whole number of 0 or more; empty the box to inherit one.');
    }
    if (seed === (rung.seed ?? -1)) {
      this.dirty.delete(key);
      field.classList.remove('dirty');
      return;
    }

    const outcome = await exec('art.setSeed', { target: rung.target, seed });
    this.dirty.delete(key);
    report(outcome);
    if (!outcome.ok) return;

    field.classList.remove('dirty');
    // The seed is in the task hash, so what the pane says about this asset has moved under it.
    void this.load(this.shown);
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
