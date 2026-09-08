import type { Container } from 'pathux';
import { redrawing, type AnchorPass } from '../../tour/anchors.js';
import { exec, notify, onInvalidate, report } from '../../app/bridge.js';
import type { VnContext } from '../../app/context.js';
import { menuFor } from '../../doctree/doctree.js';
import { assetNode } from '../../panes/open.js';
import { openCommandDialog } from '../../chrome/dialog.js';
import { showContextMenu } from '../../chrome/showmenu.js';
import { TOKENS } from '../../app/tokens.js';
import {
  REQUEST_ANCHOR,
  approveAction,
  blockedNote,
  driftNote,
  exportAction,
  promoteAction,
  promptEditable,
  regenerateAction,
  replaceAction,
  taskAction,
  watchSlot,
  type RegenerateAction,
} from '../../../rules/assetview.js';
import type { OriginAction } from '../../../rules/promptview.js';
import type { Action } from '../../../rules/anchors.js';
import { VnEditor, registerEditor } from '../../app/editor.js';
import ASSET_CSS from '../../../styles/asset.css?inline';
import type { ArtRungInfo, AssetInfo, PropValue } from '../../../../src/shared/ipc.js';
import { el } from './dom.js';
import { ChunkDragController } from './chunkdrag.js';
import { PromptChunkView } from './promptview.js';
import { AssetFraming } from './framing.js';

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
 *
 * Split into this directory by concern: `chunkdrag.ts` (drag-to-reorder), `promptview.ts` (the
 * prompt/clause half of the body), and `framing.ts` (the header, frame, and the promote/replace/
 * art-notes strips). Since TypeScript has no partial classes, each concern is a delegate class
 * holding a back-reference to this editor, constructed once in the field initializers below.
 */
export class AssetEditor extends VnEditor {
  private bar!: Container;
  surface!: HTMLDivElement;

  info: AssetInfo | undefined;
  /** True while the shown asset is the one filling its slot, so a later render is one to follow. */
  private holding = false;
  private failure = '';
  /** The hash the shown info is for, which trails `ui.assetHash` by one async read. */
  shown = '';
  /** Rising with every load, so a slow read for an asset the author already left is dropped. */
  private token = 0;
  /** Rungs typed into and not yet committed — a refetch under them would eat the edit. */
  dirty = new Set<string>();
  /** The variant id typed into the promote strip; kept here so a rebuild does not drop it. */
  variant = '';
  /** The concept's prompt and name as the boxes hold them — prefilled, then whatever was typed. */
  draft = '';
  titleDraft = '';
  /** True once the prompt box was typed into, so a background refetch stops overwriting it. */
  promptDirty = false;
  /** One hop of history, so walking up DRAWN FROM is reversible: where from, and back to what. */
  back = '';
  backFor = '';
  /** The body's anchors, replaced whole by every `rebuildBody`, which clears the surface first. */
  drawing: AnchorPass = redrawing('asset', 'body');

  readonly chunkDrag = new ChunkDragController(this);
  private readonly promptView = new PromptChunkView(this);
  private readonly framing = new AssetFraming(this);

  static override define() {
    return {
      tagname : 'vn-asset-editor-x',
      areaname: 'asset',
      icon    : -1,
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

  async load(hash: string): Promise<void> {
    const mine = ++this.token;
    // A refetch of the same asset keeps what is half-typed; moving to another one does not.
    if (hash !== this.shown) {
      this.variant = '';
      this.promptDirty = false;
      this.promptView.editing.clear();
      this.promptView.customDraft = undefined;
      this.chunkDrag.refocus = '';
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
      // A pinned pane keeps showing what it was pinned to, so it never follows here.
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
  complain(message: string): void {
    notify({ category: 'asset', level: 'warn', message });
  }

  private async approve(action: Action): Promise<void> {
    report(await exec(action.id, action.props));
  }

  /** Save a copy of the picture on screen. The chooser is main's, so the path never crosses IPC. */
  private async download(action: Action): Promise<void> {
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
  private async regenerate(action: RegenerateAction & { ok: true }): Promise<void> {
    if (action.act === 'pipeline') {
      openCommandDialog(action.id, action.props, undefined, action.note);
      return;
    }
    report(await exec(action.id, action.props));
  }

  /**
   * Draw the concept again from whatever the box holds. `art.redraw` is `confirm: true`, so the
   * author is asked before the image call is spent; the result is a new sketch beside this one,
   * and the command's own `view.open` effect brings this pane to it.
   */
  async redraw(action: Action): Promise<void> {
    const prompt = this.draft.trim();
    if (prompt === '') return this.complain('A redraw needs a prompt — the box is empty.');

    const outcome = await exec(action.id, {
      ...action.props,
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
  async promote(action: Action): Promise<void> {
    const variant = this.variant.trim();
    if (variant === '') return this.complain('Name the variant this becomes the plate for.');

    const outcome = await exec(action.id, { ...action.props, variant });
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
  async replace(action: Action): Promise<void> {
    const outcome = await exec(action.id, action.props);
    report(outcome);
    if (!outcome.ok) return;
    const next = (outcome.data as { hash?: string } | undefined)?.hash;
    if (next === undefined || next === this.shown) return void this.load(this.shown);
    this.ui.assetHash = next;
    this.announce();
  }

  /**
   * Hand the task off to the inspector, which is the pane that reads attempts. The publish has to
   * land before the open: the inspector reads the selection on its first `update()`.
   */
  showTask(taskHash: string, action: Action): void {
    this.ui.taskHash = taskHash;
    this.announce();
    void exec(action.id, action.props);
  }

  /**
   * Commit one rung. An empty box clears the note, which is what the command means by empty —
   * so a box the author blanked is a real edit, not a no-op.
   */
  async commitRung(rung: ArtRungInfo, text: string, box: HTMLElement): Promise<void> {
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
  async runPrompt(id: string, props: Record<string, PropValue>): Promise<void> {
    const outcome = await exec(id, props);
    report(outcome);
    if (!outcome.ok) return;
    void this.load(this.shown);
  }

  /** Which clauses the prompt in force no longer appears to say. Reads; writes nothing. */
  async runCheck(action: Action): Promise<void> {
    const outcome = await exec(action.id, action.props);
    report(outcome);
    if (outcome.ok) void this.load(this.shown);
  }

  /** Run one clause act exactly as its button recorded it. */
  async runChunk(chunk: string, action: Action): Promise<void> {
    this.promptView.editing.delete(chunk);
    this.dirty.delete(`chunk:${chunk}`);
    this.chunkDrag.refocus = chunk;
    await this.runPrompt(action.id, action.props);
  }

  /** Commit one clause box. The command refuses empty text, so an empty box is never sent to it. */
  async commitChunk(chunk: string, action: Action, text: string, card: HTMLElement): Promise<void> {
    const next = text.trim();
    this.dirty.delete(`chunk:${chunk}`);
    card.classList.remove('dirty');
    if (next === '') {
      this.promptView.editing.delete(chunk);
      this.rebuildBody();
      return this.complain('Nothing typed — use Reset to go back to the derived words.');
    }
    await this.runChunk(chunk, { id: action.id, props: { ...action.props, text: next } });
  }

  async commitCustom(action: Action, text: string, box: HTMLElement): Promise<void> {
    this.dirty.delete('custom');
    box.classList.remove('dirty');
    this.promptView.customDraft = undefined;
    await this.runPrompt(action.id, { ...action.props, text: text.trim() });
  }

  /** Put the caret in the box that was just opened, after the rebuild that drew it. */
  focusBox(chunk: string): void {
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
  async openOrigin(action: OriginAction & { ok: true }): Promise<void> {
    if (action.kind === 'scroll') {
      const at = this.surface.querySelector(
        action.to === 'request'
          ? `[data-anchor="${REQUEST_ANCHOR}"]`
          : `[data-anchor="rung/${action.to}"]`,
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
      where : 'elsewhere',
      ...(action.subject ? { subject: action.subject } : {}),
    });
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
    const anchors = redrawing('asset', 'bar');

    this.bar.clear();
    this.bar.label('ASSET').style['padding'] = '0px 8px';
    this.pinToggle(this.bar);

    // A concept is approved by nothing and planned by nothing, so neither button can ever act on
    // one; a greyed pair beside a working Redraw reads as breakage. The bar carries the act this
    // asset actually has, and the body carries the rest — the prompt box, its hint, and Promote.
    if (info?.kind === 'concept') {
      const offer = promptEditable(info);
      anchors.act(
        this.bar.button(offer.label, () => {}),
        offer,
        (a) => void this.redraw(a),
      );
    } else if (info?.kind === 'reference') {
      // An upload has neither act, because nothing generated it: there is no output to approve
      // and no task to requeue. It takes part by being pointed at from a prompt clause
      this.bar.label('uploaded').style['padding'] = '0px 8px';
    } else {
      const action = approveAction(info);
      anchors.act(
        this.bar.button(action.label, () => {}),
        action,
        (a) => void this.approve(a),
      );

      const regen = regenerateAction(info);
      anchors.act(
        this.bar.button(regen.label, () => {}),
        regen,
        () => void (regen.ok && this.regenerate(regen)),
      );
    }

    const open = taskAction(info?.sourceTask);
    anchors.act(
      this.bar.button(open.label, () => {}),
      open,
      (a) => void (open.ok && this.showTask(open.publish['taskHash'] ?? '', a)),
    );

    // Beside Task rather than in the body, because the band that says the same thing is below the
    // picture and a tall asset pushes it off screen.
    const blocked = info ? blockedNote(info) : null;
    if (blocked) {
      const mark = this.bar.label('?');
      mark.description = `${blocked} Click Task to see what is holding it up.`;
      mark.setCSSAfter(() => {
        mark.style['padding'] = '0px 8px';
        mark.style['color'] = TOKENS.vermilion;
        mark.style['fontWeight'] = '800';
      });
    }

    const download = exportAction(info);
    anchors.act(
      this.bar.button(download.label, () => {}),
      download,
      (a) => void this.download(a),
    );

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

  rebuildBody(): void {
    this.surface.textContent = '';
    this.drawing = redrawing('asset', 'body');

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

    this.surface.appendChild(this.framing.head(info));
    this.surface.appendChild(this.framing.frame(info));
    // Drawn only when there are rows, since an empty strip on every portrait would add nothing,
    // and `unapproved` is only ever set when one of these rows is pending.
    if (info.prereqs.length > 0) this.surface.appendChild(this.framing.drawnFrom(info));

    const promotable = promoteAction(info);
    if (promotable.ok) this.surface.appendChild(this.framing.promoteStrip(info, promotable));

    // Mutually exclusive with the promote strip by construction: a concept fills no slot, and
    // nothing that fills a slot is a concept.
    const replaceable = replaceAction(info);
    if (replaceable.ok) this.surface.appendChild(this.framing.replaceStrip(replaceable));

    // Ahead of the drift band: a failure says the picture is not there, which outranks a note
    // saying the picture no longer matches the words.
    if (info.failure) this.surface.appendChild(this.promptView.failureBand(info, info.failure));

    const drift = driftNote(info);
    if (drift) this.surface.appendChild(el('div', 'as-drift', drift));

    const editable = promptEditable(info);
    if (editable.ok) {
      this.surface.appendChild(el('div', 'as-section', 'PROMPT · AS AUTHORED'));
      this.surface.appendChild(this.framing.promptStrip(info, editable));
    }
    this.promptView.rebuildPrompt(info, editable.ok);

    this.surface.appendChild(el('div', 'as-section', 'ART NOTES'));
    if (info.rungs.length === 0) {
      this.surface.appendChild(
        el('div', 'as-hint', 'Nothing this asset was generated from is still in the project.'),
      );
      return;
    }
    for (const rung of info.rungs) this.surface.appendChild(this.framing.rungBox(rung));
    this.surface.appendChild(
      el(
        'div',
        'as-hint',
        'Notes are appended to the prompt, widest rung first; the seed beside each is what that rung is drawn with, and an empty one inherits. Ctrl+S or leaving a box saves — and re-renders what that rung reaches on the next run.',
      ),
    );
  }
}

registerEditor(AssetEditor, 'vn.AssetEditor');
