import { imageModelChoices, modelCatalog } from '@vn/gengraph';
import { exec, report } from '../../app/bridge.js';
import {
  REQUEST_ANCHOR,
  backAction,
  badgesOf,
  modelAction,
  notesAction,
  prereqAction,
  promoteBox,
  redrawBox,
  redrawGo,
  seedAction,
  type PromoteAction,
  type RedrawAction,
  type ReplaceAction,
} from '../../../rules/assetview.js';
import type { ArtRungInfo, AssetInfo, Prereq } from '../../../../src/shared/ipc.js';
import { button, el, option } from './dom.js';
import type { AssetEditor } from './index.js';

/**
 * The asset header, the picture frame, the DRAWN FROM approval chain, and the promote/replace/
 * art-notes strips underneath it. Mostly pure builders over an `AssetInfo`; the state they touch
 * (`variant`, `draft`, `titleDraft`, `back`/`backFor`, `dirty`) lives on `editor`.
 */
export class AssetFraming {
  constructor(private readonly editor: AssetEditor) {}

  head(info: AssetInfo): HTMLElement {
    const head = el('div', 'as-head');
    head.appendChild(el('div', 'as-label', info.label));

    const badges = el('div', 'as-badges');
    for (const badge of badgesOf(info)) {
      badges.appendChild(el('span', `as-badge ${badge}`, badge));
    }
    head.appendChild(badges);

    // Shows the full hash rather than the short one, since this pane is what an author copies
    // an identity out of.
    head.appendChild(el('div', 'as-hash', `${info.hash}.${info.ext}`));
    return head;
  }

  frame(info: AssetInfo): HTMLElement {
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
  drawnFrom(info: AssetInfo): HTMLElement {
    const strip = el('div', 'as-from');

    const head = el('div', 'as-from-head');
    const title = el('span', 'as-section', 'DRAWN FROM');
    title.title =
      'The pictures this one was drawn from. Each has to be approved before this one can be.';
    head.appendChild(title);

    // The chip clears itself: changing the subject some other way leaves `backFor` naming a
    // picture no longer on screen, so the chip is offered only on the hop it can undo.
    if (this.editor.back !== '' && this.editor.backFor === info.hash) {
      const back = backAction(this.editor.back);
      head.appendChild(
        this.editor.drawing.act(button('as-from-back', back.label), back, () =>
          this.showPrereq(this.editor.back, ''),
        ),
      );
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
    // Recorded rather than acted: the click retargets this pane through `showPrereq`, which keeps
    // the hop back. A row the manifest has no bytes for is greyed with the note that says so.
    this.editor.drawing.record(row, prereqAction(p));
    if (p.missing) return row;
    row.addEventListener('click', () => this.showPrereq(p.hash, info.hash));
    return row;
  }

  /** Retarget this pane, remembering the one hop back. `from` empty means the chip was the click. */
  private showPrereq(hash: string, from: string): void {
    if (hash === '' || hash === this.editor.shown) return;
    this.editor.back = from === '' ? '' : this.editor.shown;
    this.editor.backFor = from === '' ? '' : hash;
    this.editor.ui.assetHash = hash;
    this.editor.announce();
  }

  /**
   * The concept's one offer: name a variant and this becomes that plate. Kept beside the image
   * rather than in the header bar because it needs a field, and because it is the only control on
   * the pane that changes which kind the asset is.
   */
  promoteStrip(info: AssetInfo, offer: PromoteAction & { ok: true }): HTMLElement {
    const strip = el('div', 'as-promote');
    strip.appendChild(el('span', 'as-promote-what', `Promote to a plate for ${offer.locationId}:`));

    let picker: HTMLSelectElement | undefined;

    const input = document.createElement('input');
    input.className = 'as-promote-id';
    input.setAttribute('aria-label', 'The variant id this becomes the plate for');
    const box = promoteBox(info);
    input.placeholder = box.label;
    input.value = this.editor.variant;
    this.editor.drawing.record(input, box);
    input.addEventListener('input', () => {
      this.editor.variant = input.value;
      // Typing the name of a variant that exists is the same choice the picker makes, so the two
      // must not end up disagreeing about which one is selected.
      if (picker) picker.value = offer.variants.includes(input.value) ? input.value : '';
    });
    // The screen keymap is a bubble-phase window listener, so the field stops its own keys.
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') void this.editor.promote(offer);
    });
    strip.appendChild(input);

    if (offer.variants.length > 0) {
      picker = this.variantPicker(offer, input);
      strip.appendChild(picker);
    }

    strip.appendChild(
      this.editor.drawing.act(
        el('button', 'as-promote-go', offer.label),
        offer,
        (a) => void this.editor.promote(a),
      ),
    );

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
   * The variants the location already has, beside the promote field rather than in place of it.
   * Promoting to a name the sheet does not carry yet is the other half of what the strip does, so
   * choosing fills the field and the field stays typeable — the same shape a `directory` prop's
   * Browse… button has in the command form.
   */
  private variantPicker(
    offer: PromoteAction & { ok: true },
    input: HTMLInputElement,
  ): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'as-promote-pick';
    select.setAttribute('aria-label', `The variants ${offer.locationId} already has`);
    select.title =
      `Fill the field with a variant ${offer.locationId} already has. Its plate becomes this ` +
      'picture; leave the field as it is to write a variant the sheet does not carry yet.';
    select.appendChild(option('', 'or one it has…'));
    for (const variant of offer.variants) select.appendChild(option(variant, variant));
    select.value = offer.variants.includes(this.editor.variant) ? this.editor.variant : '';
    select.addEventListener('change', () => {
      if (select.value === '') return;
      this.editor.variant = select.value;
      input.value = select.value;
      input.focus();
    });
    return select;
  }

  /**
   * The offer every planned picture has: hand in a file and let it be this one. An author who paid
   * for a cleanup has bytes better than anything a run will produce, and the strip says what that
   * costs — the render it stands in for stays in the store, and the next run adopts rather than
   * draws. The slot is shown rather than asked for: it is the picture on screen.
   */
  replaceStrip(offer: ReplaceAction & { ok: true }): HTMLElement {
    const strip = el('div', 'as-replace');
    strip.appendChild(
      this.editor.drawing.act(
        el('button', 'as-replace-go', offer.label),
        offer,
        (a) => void this.editor.replace(a),
      ),
    );
    strip.appendChild(el('span', 'as-replace-what', offer.slot));
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
  promptStrip(info: AssetInfo, offer: RedrawAction & { ok: true }): HTMLElement {
    const strip = el('div', 'as-redraw');
    // The `⇱` on a `request` chunk scrolls here, to the box those words came out of
    strip.dataset['anchor'] = REQUEST_ANCHOR;

    const text = document.createElement('textarea');
    text.className = 'as-redraw-prompt';
    text.value = this.editor.draft;
    text.spellcheck = false;
    text.setAttribute('aria-label', 'The prompt this concept is drawn from');
    this.editor.drawing.record(text, redrawBox(info));
    text.addEventListener('input', () => {
      this.editor.draft = text.value;
      this.editor.promptDirty = true;
      strip.classList.add('dirty');
    });
    // The screen keymap is a bubble-phase window listener, so the box stops its own keys.
    text.addEventListener('keydown', (event) => event.stopPropagation());
    strip.appendChild(text);

    const row = el('div', 'as-redraw-row');
    const name = document.createElement('input');
    name.className = 'as-redraw-title';
    name.value = this.editor.titleDraft;
    name.placeholder = 'name for this sketch';
    name.setAttribute('aria-label', 'What to call this sketch');
    name.title = 'Name the sketch Redraw files. Enter draws it.';
    name.addEventListener('input', () => (this.editor.titleDraft = name.value));
    name.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') void this.editor.redraw(offer);
    });
    row.appendChild(name);

    // The bar's Redraw is the same offer; this one is told apart as the strip's own button
    const go = redrawGo(info);
    row.appendChild(
      this.editor.drawing.act(
        el('button', 'as-redraw-go', go.label),
        go,
        (a) => void this.editor.redraw(a),
      ),
    );
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

  rungBox(rung: ArtRungInfo): HTMLElement {
    const box = el('div', 'as-rung');
    // The `⇱` on an `art-notes` chunk scrolls here, to the box those words came out of
    box.dataset['rung'] = rung.target;
    box.dataset['anchor'] = `rung/${rung.target}`;

    const head = el('div', 'as-rung-head');
    head.appendChild(el('span', 'as-rung-label', rung.label));
    head.appendChild(el('span', 'as-rung-target', rung.target));
    head.appendChild(this.seedField(rung));
    head.appendChild(this.modelField(rung));
    box.appendChild(head);

    const text = document.createElement('textarea');
    text.value = rung.notes ?? '';
    text.spellcheck = false;
    const notes = notesAction(rung);
    text.placeholder = notes.label;
    this.editor.drawing.record(text, notes);
    text.addEventListener('input', () => {
      this.editor.dirty.add(rung.target);
      box.classList.add('dirty');
    });
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys hands Ctrl+Z and the shell's other gestures away mid-edit.
    text.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.editor.commitRung(rung, text.value, box);
      }
    });
    text.addEventListener('blur', () => {
      if (this.editor.dirty.has(rung.target)) void this.editor.commitRung(rung, text.value, box);
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
    const inherited = this.editor.info?.configSeed;
    const field = document.createElement('input');
    field.type = 'number';
    field.min = '0';
    field.step = '1';
    field.className = 'as-rung-seed';
    field.value = rung.seed === undefined ? '' : String(rung.seed);
    const seed = seedAction(rung, inherited);
    field.placeholder = seed.label;
    field.setAttribute('aria-label', `Image seed for ${rung.label}`);

    const key = `seed:${rung.target}`;
    this.editor.drawing.record(field, seed);
    field.addEventListener('input', () => {
      this.editor.dirty.add(key);
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
      if (this.editor.dirty.has(key)) void this.commitSeed(rung, field.value, field);
    });
    return field;
  }

  /**
   * The image-model picker beside the seed box. Its rows are the catalog the Project pane's
   * picker draws, with an inherit row first; a rung whose model is not in the catalog is still
   * listed, so it is shown rather than silently reset.
   */
  private modelField(rung: ArtRungInfo): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'as-rung-model';
    const current = rung.imageModel ?? '';
    const project = this.editor.info?.projectModel;
    const rows = imageModelChoices(modelCatalog(), current, { inherit: true });
    for (const row of rows) {
      const item = option(
        row.id,
        row.id === '' ? `inherit${project ? ` (${project})` : ''}` : row.label,
      );
      item.title = row.tooltip;
      select.appendChild(item);
    }
    select.value = current;
    select.setAttribute('aria-label', `Image model for ${rung.label}`);
    this.editor.drawing.record(select, modelAction(rung, project));
    select.addEventListener('change', () => void this.commitModel(rung, select.value));
    return select;
  }

  /** Commit one rung's image model. The inherit row clears it. */
  private async commitModel(rung: ArtRungInfo, model: string): Promise<void> {
    if (model === (rung.imageModel ?? '')) return;
    const outcome = await exec('art.setModel', { target: rung.target, model });
    report(outcome);
    if (!outcome.ok) return;
    void this.editor.load(this.editor.shown);
  }

  /** Commit one rung's seed. An empty box clears it, which is the rung inheriting again. */
  private async commitSeed(rung: ArtRungInfo, text: string, field: HTMLElement): Promise<void> {
    const key = `seed:${rung.target}`;
    const typed = text.trim();
    const seed = typed === '' ? -1 : Number(typed);
    if (typed !== '' && (!Number.isInteger(seed) || seed < 0)) {
      return this.editor.complain(
        'A seed is a whole number of 0 or more; empty the box to inherit one.',
      );
    }
    if (seed === (rung.seed ?? -1)) {
      this.editor.dirty.delete(key);
      field.classList.remove('dirty');
      return;
    }

    const outcome = await exec('art.setSeed', { target: rung.target, seed });
    this.editor.dirty.delete(key);
    report(outcome);
    if (!outcome.ok) return;

    field.classList.remove('dirty');
    // The seed is in the task hash, so what the pane says about this asset has moved under it.
    void this.editor.load(this.editor.shown);
  }
}
