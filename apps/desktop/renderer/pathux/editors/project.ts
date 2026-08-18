import type { Button, Container } from 'pathux';
import { exec, onInvalidate, report } from '../bridge.js';
import { VnEditor, registerEditor } from '../editor.js';
import PROJECT_CSS from '../../styles/project.css?inline';
import type { ProjectView } from '../../../src/shared/ipc.js';

/**
 * `project.yaml`, as the run reads it. A singleton pane — it has no subject, because a workspace
 * has one config — so it is deliberately absent from `SUBJECT_OF` and `view.open(editor=project)`
 * carries nothing.
 *
 * One field is editable and the rest are shown. The art style is the sentence every image prompt
 * opens with, so it is the one setting an author reaches for repeatedly; the model ids and image
 * params are read-only here because changing them is a deliberate, file-level act and a pane that
 * made it a two-click affair would invite it. Applying goes through `project.setArtStyle`, which
 * is `confirm: true` and says how many image tasks it re-keys before it writes.
 */
export class ProjectEditor extends VnEditor {
  private surface!: HTMLDivElement;
  private styleBox!: HTMLTextAreaElement;
  private warn!: HTMLDivElement;
  private rows!: HTMLDivElement;
  private titleEl!: HTMLDivElement;
  private rootEl!: HTMLDivElement;
  private noteEl!: HTMLDivElement;
  private applyBtn!: Button;

  private view: ProjectView | undefined;
  /** True once the box was typed into, so a background refetch stops overwriting the draft. */
  private dirty = false;
  /** Rising with every load, so a slow read that arrives after a newer one is dropped. */
  private token = 0;
  private unwatch: (() => void) | undefined;

  static override define() {
    return {
      tagname: 'vn-project-editor-x',
      areaname: 'project',
      uiname: 'Project',
      icon: -1,
    };
  }

  override init() {
    super.init();

    const bar = (this.header as Container).row();
    bar.label('PROJECT').style['padding'] = '0px 8px';
    this.applyBtn = bar.button('Apply', () => void this.apply());
    this.applyBtn.description = 'Write these settings back to project.yaml';
    const reload = bar.button('⟳', () => void this.load());
    reload.description = 'Re-read project.yaml (discards an unapplied edit)';
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
    this.styleBox.title =
      'The sentence every image prompt opens with. Applying it re-keys every image task.';
    this.styleBox.addEventListener('input', () => this.touched());
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys opens the palette on the first `/` of a sentence.
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

    this.noteEl = el('div', 'pj-note') as HTMLDivElement;
    this.surface.appendChild(this.noteEl);

    this.appendSurface(this.surface);

    // Opening another workspace, importing, or an undo of this pane's own write all move the file
    // under it; a draft the author has not applied does not follow, and its next apply earns the
    // "already says that" or the real refusal, which is the honest outcome.
    this.unwatch = onInvalidate(() => {
      if (!this.dirty) void this.load();
    });

    void this.load();
  }

  override on_remove() {
    this.unwatch?.();
    this.unwatch = undefined;
    super.on_remove();
  }

  // -------------------------------------------------------------------------
  // Reading and writing
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    const mine = ++this.token;
    const outcome = await exec('project.info');
    if (mine !== this.token) return;

    if (!outcome.ok) {
      this.view = undefined;
      this.note(outcome.error, true);
      this.paint();
      return;
    }
    this.view = outcome.data as ProjectView;
    this.dirty = false;
    this.styleBox.value = this.view.artStyle;
    this.note('');
    this.paint();
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
    this.applyBtn.disabled = !view || !this.dirty;
    this.titleEl.textContent = view?.title ?? 'No project open';
    this.rootEl.textContent = view?.root ?? '';
    this.warn.textContent =
      view && this.dirty
        ? `Applying re-keys ${view.imageTasks} image task(s) — the next run redraws them.`
        : '';

    this.rows.textContent = '';
    if (!view) return;
    row(this.rows, 'title', view.title);
    row(this.rows, 'start', view.start);
    row(this.rows, 'models.image', view.models.image);
    row(this.rows, 'models.text', view.models.text);
    row(this.rows, 'models.vision', view.models.vision.join(', '));
    row(this.rows, 'image_params.aspect', view.imageParams.aspect);
    row(this.rows, 'image_params.seed', view.imageParams.seed?.toString() ?? '');
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
