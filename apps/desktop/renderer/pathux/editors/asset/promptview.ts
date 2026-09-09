import { ThumbnailCache, pickAssetPopup } from 'pathux';
import { exec, report, say } from '../../app/bridge.js';
import { galleryItem } from '../../assets/assetthumb.js';
import {
  failureNote,
  failureTaskAction,
  fixAction,
  promptShown,
} from '../../../rules/assetview.js';
import {
  checkAction,
  chunkActs,
  chunkAddress,
  chunkBoxAction,
  chunkTag,
  chunkTexture,
  chunkVoice,
  condenseAction,
  coverageMark,
  customAction,
  customBoxAction,
  dropRefAction,
  heldNote,
  modeStrip,
  originAction,
  originButton,
  railAction,
  refOpenAction,
  refStrip,
  type RefChip,
} from '../../../rules/promptview.js';
import type { Action } from '../../../rules/anchors.js';
import type { AssetFailure, AssetInfo, AssetListing } from '../../../../src/shared/ipc.js';
import type { PromptChunkInfo, PromptView } from '../../../../src/shared/prompt.js';
import { button, el } from './dom.js';
import type { AssetEditor } from './index.js';

/**
 * The prompt half of the asset pane: what would be sent, the clauses it is made of, and every
 * per-clause act (edit, drag-reorder via `editor.chunkDrag`, attach a reference, drop one).
 * Owns the boxes-open state and the reference-thumbnail cache; everything else it needs — the
 * surface to draw into, the commands to run, the drag controller — it reaches through `editor`.
 */
export class PromptChunkView {
  /** Chunk boxes open for editing: the clause key → which op the box commits. */
  editing = new Map<string, 'replace' | 'append'>();
  /** The custom box as typed; `undefined` until it is, so a refetch refills it from the project. */
  customDraft: string | undefined;
  /** Decoded reference thumbnails, kept across popups so reopening the gallery redraws at once. */
  private readonly thumbs = new ThumbnailCache();

  constructor(private readonly editor: AssetEditor) {}

  /**
   * The prompt half: what would be sent, and the clauses it is made of. Every kind gets the cards —
   * the composition is the same object whether the author is editing it or reading it — but a
   * frozen one gets no controls, because there is no derivation underneath to do anything to.
   */
  rebuildPrompt(info: AssetInfo, authored: boolean): void {
    const view = info.promptView;
    this.editor.chunkDrag.dragNote = undefined;

    if (!view) {
      const prompt = promptShown(info);
      this.editor.surface.appendChild(
        el(
          'div',
          'as-section',
          prompt.derived ? 'PROMPT · AS DERIVED TODAY' : 'PROMPT · AS RECORDED',
        ),
      );
      this.editor.surface.appendChild(
        el('div', 'as-prompt', prompt.text || 'The project no longer describes this asset.'),
      );
      return;
    }

    if (view.frozen) {
      // Anything frozen that is not authored has only what the bytes recorded; a concept's prompt
      // is already in the box above.
      if (!authored) {
        this.editor.surface.appendChild(el('div', 'as-section', 'PROMPT · AS RECORDED'));
        this.editor.surface.appendChild(
          el('div', 'as-prompt', view.text || 'No prompt was recorded.'),
        );
      }
      this.editor.surface.appendChild(el('div', 'as-hint', view.frozen));
      if (view.chunks.length > 0) this.editor.surface.appendChild(this.chunkList(view));
      return;
    }

    this.editor.surface.appendChild(el('div', 'as-section', 'PROMPT'));
    this.editor.surface.appendChild(this.modeRow(view));
    this.editor.surface.appendChild(
      el('div', 'as-prompt', view.text || 'This prompt says nothing.'),
    );
    if (view.held) this.editor.surface.appendChild(this.heldBanner(view));
    if (view.mode === 'custom') this.editor.surface.appendChild(this.customBox(view));
    this.editor.surface.appendChild(this.chunkList(view));

    // The footer a drag writes into, holding the verdict for the insertion point under the pointer
    this.editor.chunkDrag.dragNote = el('div', 'as-note');
    this.editor.surface.appendChild(this.editor.chunkDrag.dragNote);
    this.editor.surface.appendChild(
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
      row.appendChild(
        this.editor.drawing.act(
          button(`as-mode${seg.active ? ' on' : ''}`, seg.offer.label),
          seg.offer,
          (a) => void this.editor.runPrompt(a.id, a.props),
        ),
      );
    }

    const condense = condenseAction(view);
    row.appendChild(
      this.editor.drawing.act(
        button('as-mode act', condense.label),
        condense,
        (a) => void this.editor.runPrompt(a.id, a.props),
      ),
    );

    const check = checkAction(view);
    row.appendChild(
      this.editor.drawing.act(
        button('as-mode', check.label),
        check,
        (a) => void this.editor.runCheck(a),
      ),
    );
    return row;
  }

  /**
   * What the pipeline recorded when it gave up, plus the way into the task that recorded it. The
   * button names its own task rather than the asset's, because a failed re-render is a different
   * task from the one these bytes came from and the inspector is where its attempts are readable.
   */
  failureBand(info: AssetInfo, failure: AssetFailure): HTMLElement {
    const band = el('div', 'as-failed', failureNote(info));
    const show = failureTaskAction(info, failure);
    band.appendChild(
      this.editor.drawing.act(button('as-mode', show.label), show, (a) =>
        this.editor.showTask(failure.task, a),
      ),
    );

    // Placed on the band rather than the bar, because the offer exists only while there is a
    // failure here for the author to read.
    const ask = fixAction(info);
    band.appendChild(
      this.editor.drawing.act(button('as-mode', ask.label), ask, (a) => void this.fixWithAgent(a)),
    );
    return band;
  }

  /**
   * Hand the failure to the agent. The command opens the conversation and fills the composer; the
   * turn is the author's to send, and no picture is redrawn by any of it.
   */
  private async fixWithAgent(action: Action): Promise<void> {
    report(await exec(action.id, action.props));
  }

  private heldBanner(view: PromptView): HTMLElement {
    const banner = el('div', 'as-held', heldNote(view));
    const action = condenseAction(view);
    if (action.ok) {
      banner.appendChild(
        this.editor.drawing.act(
          button('as-mode', action.label),
          action,
          (a) => void this.editor.runPrompt(a.id, a.props),
        ),
      );
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
    card.dataset['anchor'] = `chunk/${chunk.key}`;
    card.tabIndex = 0;

    const rail = el('div', 'as-chunk-rail');
    if (!view.frozen) {
      // Recorded rather than acted: the rail is grabbed on `pointerdown`, not clicked
      this.editor.drawing.record(rail, railAction(chunk));
      rail.addEventListener('pointerdown', (event) =>
        this.editor.chunkDrag.grabChunk(view, chunk.key, rail, event as PointerEvent),
      );
      card.addEventListener('keydown', (event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        event.stopPropagation();
        void this.editor.chunkDrag.nudge(view, chunk.key, event.key === 'ArrowUp' ? -1 : 1);
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
      main.appendChild(this.chunkActs(view, chunk, card));
      const how = this.editing.get(chunk.key);
      if (how) main.appendChild(this.chunkBox(view, chunk, how, card));
    }

    card.appendChild(main);
    if (this.editor.chunkDrag.refocus === chunk.key) {
      this.editor.chunkDrag.refocus = '';
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
      this.editor.drawing.act(thumb, refOpenAction(chip), (a) => void exec(a.id, a.props));
      item.appendChild(thumb);
      item.appendChild(el('span', 'as-ref-name', chip.label));

      if (!view.frozen) {
        const drop = dropRefAction(view, chunk, chip);
        item.appendChild(
          this.editor.drawing.act(
            button('as-ref-drop', drop.label),
            drop,
            (a) => void this.editor.runPrompt(a.id, a.props),
          ),
        );
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
      // Recorded rather than acted: an open is a publish followed by the open, and a scroll is the
      // pane's own, so the click stays below and the offer says what it does
      const offer = originButton(chunk);
      if (offer) this.editor.drawing.record(open, offer);
      open.addEventListener('click', () => void this.editor.openOrigin(origin));
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
  private chunkActs(view: PromptView, chunk: PromptChunkInfo, card: HTMLElement): HTMLElement {
    const acts = el('div', 'as-chunk-acts');

    for (const act of chunkActs(view, chunk)) {
      const opens = act.opens;
      const picks = act.picks;
      const b = this.editor.drawing.act(
        button('as-chunk-act', act.offer.label),
        act.offer,
        (a) =>
          void (opens
            ? this.openBox(chunk.key, opens)
            : picks
              ? this.pickRef(chunk.key, a, b)
              : this.editor.runChunk(chunk.key, a)),
      );
      acts.appendChild(b);
    }

    // The card carries the dirty mark, so the box below can be built and rebuilt without it.
    card.classList.toggle('dirty', this.editor.dirty.has(`chunk:${chunk.key}`));
    return acts;
  }

  /**
   * Attach a reference through the asset gallery. The manifest is read when the popup opens
   * rather than followed, since the choice is over what is there at that moment, and the thumbnail
   * cache is the pane's own so reopening the popup redraws from what it already decoded.
   *
   * `anchor` is a raw DOM button rather than a widget, so the editor is the popup's owner and the
   * button supplies only the corner to open at.
   */
  private async pickRef(chunk: string, action: Action, anchor: HTMLElement): Promise<void> {
    const outcome = await exec('asset.list', {});
    if (!outcome.ok) return report(outcome);

    const assets = outcome.data as AssetListing[] | undefined;
    if (!assets?.length) {
      return say('This project has no assets to attach yet.', true);
    }

    const rect = anchor.getBoundingClientRect();
    const picked = await pickAssetPopup(this.editor, {
      items: assets.map(galleryItem),
      cache: this.thumbs,
      at   : { x: rect.left, y: rect.bottom },
    });
    if (!picked) return;

    await this.editor.runChunk(chunk, {
      id   : action.id,
      props: { ...action.props, ref: picked.id },
    });
  }

  /** Open the box one of the two boxed clause acts commits through. */
  private openBox(chunk: string, how: 'replace' | 'append'): void {
    this.editing.set(chunk, how);
    this.editor.rebuildBody();
    this.editor.focusBox(chunk);
  }

  /** The inline box for one clause. Commits on Ctrl+S or blur, exactly like `rungBox`. */
  private chunkBox(
    view: PromptView,
    chunk: PromptChunkInfo,
    how: 'replace' | 'append',
    card: HTMLElement,
  ): HTMLElement {
    const key = `chunk:${chunk.key}`;
    // The box commits the same act its button opened, so both read one offer.
    const offer = chunkActs(view, chunk).find((act) => act.key === how)!.offer;
    const action: Action = offer.ok ? offer : { id: 'prompt.setChunk', props: {} };
    const text = document.createElement('textarea');
    text.className = 'as-chunk-box';
    this.editor.drawing.record(text, chunkBoxAction(view, chunk, how));
    text.spellcheck = false;
    text.setAttribute('aria-label', `${how} the ${chunk.key} clause`);
    text.placeholder =
      how === 'replace' ? 'the words to send instead' : 'the words to add after it';
    // Replacing starts from what is being replaced, so an edit to one phrase keeps the rest.
    text.value = chunk.edit === how ? (chunk.authored ?? '') : how === 'replace' ? chunk.text : '';
    text.addEventListener('input', () => {
      this.editor.dirty.add(key);
      card.classList.add('dirty');
    });
    // The screen keymap is a bubble-phase window listener, so the box stops its own keys.
    text.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.editor.commitChunk(chunk.key, action, text.value, card);
      }
      if (event.key === 'Escape') {
        this.editor.dirty.delete(key);
        this.editing.delete(chunk.key);
        this.editor.rebuildBody();
      }
    });
    text.addEventListener('blur', () => {
      if (this.editor.dirty.has(key))
        void this.editor.commitChunk(chunk.key, action, text.value, card);
    });
    return text;
  }

  /** The whole prompt, written by hand. Same commit gesture as every other box on the pane. */
  private customBox(view: PromptView): HTMLElement {
    const box = el('div', 'as-custom');
    const offer = customAction(view);
    const action: Action = offer.ok ? offer : { id: 'prompt.setCustom', props: {} };
    const text = document.createElement('textarea');
    text.spellcheck = false;
    text.setAttribute('aria-label', 'The prompt this asset is generated from');
    text.value = this.customDraft ?? view.custom ?? view.text;
    this.editor.drawing.record(text, customBoxAction(view));
    text.addEventListener('input', () => {
      this.customDraft = text.value;
      this.editor.dirty.add('custom');
      box.classList.add('dirty');
    });
    text.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.editor.commitCustom(action, text.value, box);
      }
    });
    text.addEventListener('blur', () => {
      if (this.editor.dirty.has('custom')) void this.editor.commitCustom(action, text.value, box);
    });
    box.appendChild(text);

    const row = el('div', 'as-custom-row');
    row.appendChild(
      this.editor.drawing.act(
        button('as-mode', offer.label),
        offer,
        (a) => void this.editor.commitCustom(a, text.value, box),
      ),
    );
    row.appendChild(
      el('div', 'as-hint', 'Ctrl+S or leaving the box saves. Chunks goes back to the derivation.'),
    );
    box.appendChild(row);
    return box;
  }
}
