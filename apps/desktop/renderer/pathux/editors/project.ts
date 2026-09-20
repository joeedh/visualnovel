import { UIBase, type Button, type Container, type MenuTemplate, type RowFrame } from 'pathux';
import { exec, onInvalidate, onProjectView, refreshProjectView, report } from '../app/bridge.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import { redrawing, type AnchorPass } from '../tour/anchors.js';
import { refreshModelsAction } from '../../rules/models.js';
import {
  applyStyleAction,
  bubbleNamesAction,
  builtinSkillAction,
  imageModelAction,
  imageModelRows,
  reloadAction,
  SHOT_FORM_ROWS,
  shotFormAction,
  styleBox,
  textModelAction,
  toggledVisionModels,
  visionModelsAction,
} from '../../rules/projectbar.js';
import { textModelRows } from '../widgets/modelmenu.js';
import { textModelChoices } from '@vn/types';
import { modelCatalog } from '@vn/gengraph';
import PROJECT_CSS from '../../styles/project.css?inline';
import type { ProjectView, PropValue } from '../../../src/shared/ipc.js';
import type { Offer } from '../../rules/anchors.js';

/**
 * `project.yaml`, as the run reads it. A singleton pane with no subject (a workspace has one
 * config), so it is deliberately absent from `SUBJECT_OF` and `view.open(editor=project)` carries
 * nothing.
 *
 * Four fields are editable. The art style is the sentence every image prompt opens with, typed
 * into a box and written by Apply through `project.setArtStyle`. The three model ids are picked
 * from dropdowns whose every row runs the matching `project.set*Model*` command at once; the
 * image model's is `confirm: true` and says how many image tasks it re-keys before it writes,
 * while the text and vision models re-key nothing. The image params are read-only here because
 * changing them is a deliberate, file-level act.
 *
 * The shot form and `bubble_names` are set from the settings card too: a two-row dropdown and a
 * checkbox, each writing its key the moment it is picked.
 *
 * The third card is the builtin skill catalog, one checkbox per skill, each writing the whole
 * `builtin_skills` list through `project.setBuiltinSkills` as it is ticked.
 */
export class ProjectEditor extends VnEditor {
  private surface!: HTMLDivElement;
  private styleBox!: HTMLTextAreaElement;
  private warn!: HTMLDivElement;
  private rows!: HTMLDivElement;
  private skillRows!: HTMLDivElement;
  private titleEl!: HTMLDivElement;
  private rootEl!: HTMLDivElement;
  private noteEl!: HTMLDivElement;
  private applyBtn!: Button;

  private view: ProjectView | undefined;
  /** True once the box was typed into, so a background refetch stops overwriting the draft. */
  private dirty = false;
  /** True once this pane has fetched the model listings on its own; the button is the retry. */
  private listedOnce = false;

  static override define() {
    return {
      tagname : 'vn-project-editor-x',
      areaname: 'project',
      icon    : -1,
    };
  }

  override init() {
    super.init();

    const bar = (this.header as Container).row();
    bar.label('PROJECT').style['padding'] = '0px 8px';
    // Presented by `paint`, which every load ends in
    this.applyBtn = bar.button('Apply', () => void this.apply());
    // Its own pass: the button is built once with the pane, so a record in the bar's pass would be
    // dropped by the bar's next paint
    const reload = reloadAction();
    redrawing('project', 'reload').act(
      bar.button(reload.label, () => {}),
      reload,
      () => void this.load(),
    );
    bar.flushUpdate();

    this.adoptStyle(PROJECT_CSS);
    this.surface = el('div', 'pj-surface') as HTMLDivElement;

    this.titleEl = el('div', 'pj-title') as HTMLDivElement;
    this.rootEl = el('div', 'pj-root') as HTMLDivElement;
    this.surface.append(this.titleEl, this.rootEl);

    const card = el('div', 'pj-card authored');
    card.appendChild(el('h2', '', 'Art style'));
    const body = el('div', 'pj-body');
    this.styleBox = document.createElement('textarea');
    this.styleBox.className = 'pj-style';
    this.styleBox.spellcheck = false;
    this.styleBox.placeholder = 'e.g. soft anime, cel shaded, warm palette';
    this.styleBox.addEventListener('input', () => this.touched());
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys hands Ctrl+Z and the shell's other gestures away mid-edit.
    this.styleBox.addEventListener('keydown', (event) => event.stopPropagation());
    this.warn = el('div', 'pj-warn') as HTMLDivElement;
    body.append(this.styleBox, this.warn);
    card.appendChild(body);
    this.surface.appendChild(card);

    const settings = el('div', 'pj-card');
    settings.appendChild(el('h2', '', 'Settings'));
    this.rows = el('div', 'pj-rows') as HTMLDivElement;
    settings.appendChild(this.rows);
    this.surface.appendChild(settings);

    const skills = el('div', 'pj-card');
    skills.appendChild(el('h2', '', 'Builtin skills'));
    this.skillRows = el('div', 'pj-skills') as HTMLDivElement;
    skills.appendChild(this.skillRows);
    this.surface.appendChild(skills);

    this.noteEl = el('div', 'pj-note') as HTMLDivElement;
    this.surface.appendChild(this.noteEl);

    this.appendSurface(this.surface);

    // Opening another workspace, importing, or an undo of this pane's own write all move the file
    // under the pane. A draft the author has not applied does not follow the file, and applying it
    // later earns either the "already says that" answer or the real refusal.
    const refollow = (): void => {
      if (!this.dirty) void this.load();
    };
    this.watch(() => onInvalidate(refollow), refollow);
    // Every read of the file lands here, this pane's own included, so a refreshed model list
    // drawn for the node pickers redraws this pane's picker too.
    this.watch(() => onProjectView((view) => this.follow(view)));

    void this.load();
  }

  // -------------------------------------------------------------------------
  // Reading and writing
  // -------------------------------------------------------------------------

  /** Re-read the file through the shell, which is what sets the pickers' catalog snapshot. */
  private async load(): Promise<void> {
    await refreshProjectView();
  }

  /** Show what the shell read, unless the box holds a draft the author has not applied. */
  private follow(view: ProjectView | undefined): void {
    if (this.dirty) return;
    this.view = view;
    this.styleBox.value = view?.artStyle ?? '';
    this.note(view === undefined ? 'No project is open.' : '', view === undefined);
    this.paint();
    // A catalog with no text listing predates the text pickers, or was never fetched: list once,
    // so the pickers hold more than the shipped ids. Once is enough — a listing that failed is
    // in the note, and Refresh models is the retry.
    if (view !== undefined && view.imageModels.text.length === 0 && !this.listedOnce) {
      this.listedOnce = true;
      void this.refreshModels();
    }
  }

  /**
   * Write the box. `project.setArtStyle` is `confirm: true`, so the author is asked — with the
   * count of image tasks it re-keys — before the file moves.
   */
  private async apply(): Promise<void> {
    if (!this.view || !this.dirty) return void this.note('no changes');
    const outcome = await exec('project.setArtStyle', { style: this.styleBox.value.trim() });
    if (!outcome.ok) return void this.note(outcome.error, true);
    this.dirty = false;
    report(outcome);
    await this.load();
  }

  /**
   * Write one picker row. `project.setImageModel` is `confirm: true`, so the author is asked with
   * the count of image tasks it re-keys before the file moves; a refusal (no key for the vendor,
   * the value the file already holds) lands in the note.
   */
  private async pickModel(id: string): Promise<void> {
    const outcome = await exec('project.setImageModel', { model: id });
    if (!outcome.ok) return void this.note(outcome.error, true);
    report(outcome);
    await this.load();
  }

  /** Write the text-model picker's row. Nothing is re-keyed, so nothing confirms. */
  private async pickTextModel(id: string): Promise<void> {
    const outcome = await exec('project.setTextModel', { model: id });
    if (!outcome.ok) return void this.note(outcome.error, true);
    report(outcome);
    await this.load();
  }

  /** Write the vision picker's row, as the whole list with this id toggled. */
  private async toggleVisionModel(id: string): Promise<void> {
    const models = toggledVisionModels(this.view?.models.vision ?? [], id);
    const outcome = await exec('project.setVisionModels', { models });
    if (!outcome.ok) return void this.note(outcome.error, true);
    report(outcome);
    await this.load();
  }

  /**
   * Write one checkbox's tick, as the whole list `project.yaml` will hold. The pane is not marked
   * dirty by it: the write lands at once, and the re-read that follows redraws every box from the
   * file rather than from what was clicked.
   */
  private async setBuiltinSkills(ids: string[]): Promise<void> {
    const outcome = await exec('project.setBuiltinSkills', { ids });
    if (!outcome.ok) return void this.note(outcome.error, true);
    report(outcome);
    await this.load();
  }

  /** Fetch the model listings again. The bridge re-reads the project view once they land. */
  private async refreshModels(): Promise<void> {
    const outcome = await exec('models.refresh');
    if (!outcome.ok) return void this.note(outcome.error, true);
    report(outcome);
  }

  private touched(): void {
    this.dirty = true;
    this.note('');
    this.paint();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private note(text: string, bad = false): void {
    this.noteEl.textContent = text;
    this.noteEl.className = bad ? 'pj-note bad' : 'pj-note';
    this.noteEl.title = text;
  }

  private paint(): void {
    const view = this.view;
    // Re-recorded on every paint: the bar is built once at init, and what Apply offers follows the
    // box the author is typing in.
    const anchors = redrawing('project', 'bar');
    anchors.act(
      this.applyBtn,
      applyStyleAction(view !== undefined, this.dirty),
      () => void this.apply(),
    );
    anchors.record(this.styleBox, styleBox(view !== undefined));
    this.titleEl.textContent = view?.title ?? 'No project open';
    this.rootEl.textContent = view?.root ?? '';
    this.warn.textContent =
      view && this.dirty
        ? `Applying re-keys ${view.imageTasks} image task(s) — the next run redraws them.`
        : '';

    this.rows.textContent = '';
    this.skillRows.textContent = '';
    if (!view) return;
    row(this.rows, 'title', view.title);
    row(this.rows, 'start', view.start);
    this.modelPicker(anchors, view);
    this.textPicker(anchors, view);
    this.visionPicker(anchors, view);
    row(this.rows, 'image_params.aspect', view.imageParams.aspect);
    row(this.rows, 'image_params.seed', view.imageParams.seed?.toString() ?? '');
    this.shotFormPicker(anchors, view);
    this.flagRow(
      anchors,
      'bubble_names',
      bubbleNamesAction(true, view.bubbleNames),
      view.bubbleNames,
    );
    this.skillBoxes(anchors, view);
  }

  /**
   * The `shot_form` row: a two-row dropdown, frames or pages, each row running
   * `project.setShotForm` as it is picked. Nothing is re-keyed, so nothing confirms.
   */
  private shotFormPicker(anchors: AnchorPass, view: ProjectView): void {
    const frame = this.pickerRow('shot_form');
    const offer = shotFormAction(true, view.shotForm);
    // Rows carry their own tooltip, so the last slot has to be an explicit id: `createMenu` reads
    // `item[5]` for any row longer than four and would otherwise file the callback under undefined
    const template: MenuTemplate = SHOT_FORM_ROWS.map((entry) => [
      entry.id === view.shotForm ? `✓ ${entry.label}` : entry.label,
      () => void this.write('project.setShotForm', { form: entry.id }),
      undefined,
      undefined,
      entry.tooltip,
      entry.id,
    ]) as MenuTemplate;
    anchors.record(frame.menu({ title: offer.label, template }), offer);
    frame.flushUpdate();
  }

  /**
   * A `project.yaml` flag as a checkbox in the value column. Recorded rather than acted, the way
   * a skill's box is: the click is the box's own `change`, which runs the offer's props.
   */
  private flagRow(anchors: AnchorPass, key: string, offer: Offer, checked: boolean): void {
    this.rows.appendChild(el('span', 'pj-key', key));
    const label = el('label', 'pj-flag') as HTMLLabelElement;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => {
      if (offer.ok) void this.write(offer.id, offer.props);
    });
    label.append(box, el('span', 'pj-val', offer.label));
    anchors.record(label, offer);
    this.rows.appendChild(label);
  }

  /** Run one key's command and re-read the view, so the control shows what the file now says. */
  private async write(id: string, props: Record<string, PropValue>): Promise<void> {
    const outcome = await exec(id, props);
    if (!outcome.ok) return void this.note(outcome.error, true);
    report(outcome);
    await this.load();
  }

  /**
   * One checkbox per builtin skill, ticked as `project.yaml` has it. The box is recorded rather
   * than acted: a checkbox's click is its own `change`, and what that change runs is the list the
   * offer already computed — the catalog with this one flipped.
   */
  private skillBoxes(anchors: AnchorPass, view: ProjectView): void {
    if (view.builtinSkills.length === 0) {
      this.skillRows.appendChild(el('div', 'pj-empty-skills', 'No builtin catalog was found.'));
      return;
    }
    for (const skill of view.builtinSkills) {
      const offer = builtinSkillAction(true, skill, view.builtinSkills);
      const label = el('label', 'pj-skill') as HTMLLabelElement;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = skill.enabled;
      box.addEventListener('change', () => {
        if (offer.ok) void this.setBuiltinSkills(offer.props['ids'] as string[]);
      });
      label.append(box, el('span', 'pj-skill-name', skill.name));
      label.appendChild(el('span', 'pj-skill-desc', skill.description));
      anchors.record(label, offer);
      this.skillRows.appendChild(label);
    }
  }

  /**
   * The `models.image` row: a dropdown in place of the value, one row per image model, opened in
   * search mode because the catalog is long, with Refresh models beside it. The rows carry their
   * own tooltips and run the command as they are picked; the dropdown is what the pass records,
   * with the rows supplying the id, the way the header records the agent's model menu.
   */
  private modelPicker(anchors: AnchorPass, view: ProjectView): void {
    const current = view.models.image;
    const frame = this.pickerRow('models.image');

    // Rows carry their own tooltip, so the last slot has to be an explicit id: `createMenu` reads
    // `item[5]` for any row longer than four and would otherwise file the callback under undefined
    const template: MenuTemplate = imageModelRows(current, view.imageModels).map((entry) => [
      entry.label,
      () => void this.pickModel(entry.id),
      undefined,
      undefined,
      entry.tooltip,
      entry.id,
    ]) as MenuTemplate;
    const offer = imageModelAction(true, current);
    anchors.record(frame.menu({ title: offer.label, template, autoSearchMode: true }), offer);
    const refresh = refreshModelsAction(true, view.imageModels.asOf);
    anchors.act(
      frame.button(refresh.label, () => {}),
      refresh,
      () => void this.refreshModels(),
    );
    frame.flushUpdate();
  }

  /** A row holding one path.ux frame, for a picker drawn in place of a value. */
  private pickerRow(key: string): RowFrame {
    this.rows.appendChild(el('span', 'pj-key', key));
    const holder = el('span', 'pj-val');
    const frame = UIBase.constructElement<RowFrame>('rowframe-x', this.ctx);
    frame.ctx = this.ctx;
    holder.appendChild(frame);
    this.rows.appendChild(holder);
    return frame;
  }

  /**
   * The `models.text` row: the same dropdown the header's model menu is, rebuilt on every open
   * so a refreshed listing is in it, with each row running `project.setTextModel`.
   */
  private textPicker(anchors: AnchorPass, view: ProjectView): void {
    const frame = this.pickerRow('models.text');
    const offer = textModelAction(true, view.models.text);
    const menu = frame.menu({ title: offer.label, template: [], autoSearchMode: true });
    menu.template = (() =>
      textModelRows(view.models.text, (id) => void this.pickTextModel(id))) as never;
    anchors.record(menu, offer);
    frame.flushUpdate();
  }

  /**
   * The `models.vision` row: the list as the file has it, then a dropdown whose rows toggle
   * membership — a ticked row is on the list, and picking it takes it off.
   */
  private visionPicker(anchors: AnchorPass, view: ProjectView): void {
    const frame = this.pickerRow('models.vision');
    const current = view.models.vision;
    frame.label(current.join(', ') || 'none');
    const offer = visionModelsAction(true, current);
    const menu = frame.menu({ title: offer.label, template: [], autoSearchMode: true });
    // Rows carry their own tooltip, so the last slot has to be an explicit id: `createMenu` reads
    // `item[5]` for any row longer than four and would otherwise file the callback under undefined
    menu.template = (() =>
      textModelChoices(modelCatalog()?.text, '').map((row) => [
        current.includes(row.id) ? `✓ ${row.label}` : row.label,
        () => void this.toggleVisionModel(row.id),
        undefined,
        undefined,
        current.includes(row.id)
          ? `Take ${row.id} off the list of reviewers.`
          : `Add ${row.id} to the reviewers. ${row.tooltip}`,
        row.id,
      ])) as never;
    anchors.record(menu, offer);
    frame.flushUpdate();
  }
}

/** One read-only key/value pair. An empty value reads as "unset" rather than as a blank line. */
function row(into: HTMLElement, key: string, value: string): void {
  into.appendChild(el('span', 'pj-key', key));
  into.appendChild(el('span', value ? 'pj-val' : 'pj-val none', value || 'unset'));
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(ProjectEditor, 'vn.ProjectEditor');
