import type { Container } from 'pathux';
import { exec, onInvalidate, say } from '../bridge.js';
import {
  approveAction,
  badgesOf,
  driftNote,
  promoteAction,
  promptEditable,
  promptShown,
} from '../../rules/assetview.js';
import { VnEditor, registerEditor } from '../editor.js';
import ASSET_CSS from '../../styles/asset.css?inline';
import type { AssetInfo, ArtRungInfo } from '../../../src/shared/ipc.js';

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

    const drift = driftNote(info);
    if (drift) this.surface.appendChild(el('div', 'as-drift', drift));

    const editable = promptEditable(info);
    if (editable.ok) {
      this.surface.appendChild(el('div', 'as-section', 'PROMPT · AS AUTHORED'));
      this.surface.appendChild(this.promptStrip());
    } else {
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
    }

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
   * The one editable prompt in the app. Prefilled whole rather than blank: the generator wrapped
   * the author's sentence in a style preamble and a framing line, and an author editing "at dawn"
   * to "at dusk" should keep both without knowing they are there.
   */
  private promptStrip(): HTMLElement {
    const strip = el('div', 'as-redraw');

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

registerEditor(AssetEditor, 'vn.AssetEditor');
