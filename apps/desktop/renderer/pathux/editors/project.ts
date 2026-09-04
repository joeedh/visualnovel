import type { Button, Container } from 'pathux';
import { exec, onInvalidate, report } from '../app/bridge.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import { redrawing } from '../tour/anchors.js';
import { STYLE_SUPPLIES, applyStyleAction } from '../../rules/projectbar.js';
import PROJECT_CSS from '../../styles/project.css?inline';
import type { ProjectView } from '../../../src/shared/ipc.js';

/**
 * `project.yaml`, as the run reads it. A singleton pane with no subject (a workspace has one
 * config), so it is deliberately absent from `SUBJECT_OF` and `view.open(editor=project)` carries
 * nothing.
 *
 * The art style is the one editable field, because it is the sentence every image prompt opens
 * with. The model ids and image params are read-only here because changing them is a deliberate,
 * file-level act. Applying goes through `project.setArtStyle`, which is `confirm: true` and says
 * how many image tasks it re-keys before it writes.
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

  static override define() {
    return {
      tagname: 'vn-project-editor-x',
      areaname: 'project',
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

    void this.load();
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
    const offer = applyStyleAction(view !== undefined, this.dirty);
    this.applyBtn.disabled = !offer.ok;
    this.applyBtn.description = offer.ok
      ? 'Write these settings back to project.yaml'
      : offer.reason;
    // Re-recorded on every paint: the bar is built once at init, and what Apply offers follows the
    // box the author is typing in.
    redrawing('project', 'bar').act(this.applyBtn, offer, () => void this.apply(), {
      supplies: STYLE_SUPPLIES,
    });
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
